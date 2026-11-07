/**
 * SubTrans Extension — Bộ lập lịch dịch phụ đề (PLAN 6.2 / Section 655–672)
 * Port từ thuật toán Two-Tier Lookahead trong pipeline.go:
 * - Tier 1: Vùng phát hiện tại [t - 1s, t + 15s], batch nhỏ (3 dòng/240 ký tự) hiển thị tức thì.
 * - Tier 2: Ahead (tăng dần) -> Behind, batch 5 dòng/400 ký tự (GTX) hoặc maxItemsTier2 dòng/2000 ký tự (Gemini).
 * - Tối đa 2 batch chạy song song mỗi session. Tier-1 luôn được ưu tiên.
 * - Tự động retry dòng rỗng tối đa 3 lần.
 * - Tạm dừng khi gặp RateLimited (blocked) hoặc mất mạng, kèm đếm ngược trên UI.
 * - Hybrid upgrade: nâng cấp dòng API lên Cloud khi đã dịch xong toàn bộ và Gemini sẵn sàng.
 */

import type { EngineId, SubtitleItem, TranslateMode } from "../shared/types";
import { splitLinesIntoControlledBatches } from "../shared/batching";
import { upsertSubtitles } from "../shared/subtitles";
import type { BackgroundPort } from "./port";
import { newReqId } from "./port";
import type { B2C, BreakerView, C2B } from "../shared/messages";

export interface SchedulerOptions {
  trackKey: string;
  srcLang: string;
  mode: TranslateMode;
  geminiModel?: string;
  maxItemsTier2?: number;
  pretranslateWholeTrack?: boolean;
  port: BackgroundPort;
  getItems: () => SubtitleItem[];
  onItemsUpdated: (updatedItems: SubtitleItem[]) => void;
  onStatusMessage?: (message: string | null) => void;
  onLinesTranslated?: (engineKey: string, updates: Array<[number, string]>) => void;
}

export interface ScheduledBatch {
  ids: number[];
  priority: "tier1" | "tier2";
  isUpgrade?: boolean;
}

export function inPlayWindow(item: SubtitleItem, playheadSec: number): boolean {
  return item.end_sec >= playheadSec - 1.0 && item.start_sec <= playheadSec + 15.0;
}

export class Scheduler {
  private readonly inflight = new Map<string, number[]>(); // reqId -> item ids
  private readonly retries = new Map<number, number>(); // id -> retry count
  private queuedBatches: ScheduledBatch[] = [];
  private pausedUntil = 0;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private geminiReady = false;
  private breakers: { api: BreakerView; cloud: BreakerView } = {
    api: { blocked: false, until: 0 },
    cloud: { blocked: false, until: 0 },
  };
  private unregisterStatus: (() => void) | null = null;

  constructor(private readonly opts: SchedulerOptions) {
    this.unregisterStatus = this.opts.port.onStatus((s) => {
      this.handleBreakerStatus(s);
    });
  }

  public get inflightCount(): number {
    return this.inflight.size;
  }

  public get queuedCount(): number {
    return this.queuedBatches.length;
  }

  public updateSettings(patch: {
    mode?: TranslateMode;
    geminiModel?: string;
    maxItemsTier2?: number;
    pretranslateWholeTrack?: boolean;
  }): void {
    if (patch.mode) this.opts.mode = patch.mode;
    if (patch.geminiModel !== undefined) this.opts.geminiModel = patch.geminiModel;
    if (patch.maxItemsTier2 !== undefined) this.opts.maxItemsTier2 = patch.maxItemsTier2;
    if (patch.pretranslateWholeTrack !== undefined) {
      this.opts.pretranslateWholeTrack = patch.pretranslateWholeTrack;
    }
  }

  /** Lên lịch dịch dựa theo mốc thời gian phát hiện tại */
  public plan(playheadSec: number): void {
    if (this.disposed) return;

    const items = this.opts.getItems();
    if (!items || items.length === 0) return;

    const inflightIds = new Set<number>();
    for (const ids of this.inflight.values()) {
      for (const id of ids) inflightIds.add(id);
    }

    const tier1Ids: number[] = [];
    const aheadIds: number[] = [];
    const behindIds: number[] = [];

    const pretranslateAll = this.opts.pretranslateWholeTrack ?? true;
    const maxLookaheadSec = playheadSec + 75.0; // 15s window + 60s ahead

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.ignored || it.translated) continue;
      if (inflightIds.has(it.id)) continue;
      if ((this.retries.get(it.id) ?? 0) >= 3) continue;

      if (inPlayWindow(it, playheadSec)) {
        tier1Ids.push(i);
      } else if (it.start_sec > playheadSec + 15.0) {
        if (pretranslateAll || it.start_sec <= maxLookaheadSec) {
          aheadIds.push(i);
        }
      } else if (it.end_sec < playheadSec - 1.0) {
        behindIds.push(i);
      }
    }

    const newBatches: ScheduledBatch[] = [];

    // 1. Pack Tier-1: 3 câu / 240 ký tự
    this.packBatches(items, tier1Ids, 3, 240, "tier1", newBatches);

    // 2. Pack Tier-2 (Ahead rồi tới Behind)
    const isGeminiExpected =
      this.opts.mode === "gemini" || this.opts.mode === "hybrid";
    const maxLinesTier2 = isGeminiExpected
      ? this.opts.maxItemsTier2 ?? 20
      : 5;
    const maxCharsTier2 = isGeminiExpected ? 2000 : 400;

    this.packBatches(items, aheadIds, maxLinesTier2, maxCharsTier2, "tier2", newBatches);
    this.packBatches(items, behindIds, maxLinesTier2, maxCharsTier2, "tier2", newBatches);

    // 3. Hybrid upgrade nếu tất cả câu đã dịch và còn câu dịch bằng API
    if (
      this.opts.mode === "hybrid" &&
      tier1Ids.length === 0 &&
      aheadIds.length === 0 &&
      behindIds.length === 0 &&
      this.canUpgradeToCloud()
    ) {
      const upgradeIds: number[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.translated && it.engine === "api" && !inflightIds.has(it.id)) {
          upgradeIds.push(i);
        }
      }
      this.packBatches(items, upgradeIds, maxLinesTier2, maxCharsTier2, "tier2", newBatches, true);
    }

    this.queuedBatches = newBatches;
    this.pump();
  }

  public onSeeked(currentTime: number): void {
    this.plan(currentTime);
  }

  public tick(currentTime: number): void {
    this.plan(currentTime);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.unregisterStatus) {
      this.unregisterStatus();
      this.unregisterStatus = null;
    }

    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    // Hủy toàn bộ request đang bay
    for (const reqId of this.inflight.keys()) {
      this.opts.port.cancel(reqId);
    }
    this.inflight.clear();
    this.queuedBatches = [];
    this.retries.clear();
    this.opts.onStatusMessage?.(null);
  }

  // ---------------------------------------------------------------------------

  private canUpgradeToCloud(): boolean {
    return this.geminiReady && !this.breakers.cloud.blocked;
  }

  private packBatches(
    items: SubtitleItem[],
    indices: number[],
    maxLines: number,
    maxChars: number,
    priority: "tier1" | "tier2",
    target: ScheduledBatch[],
    isUpgrade = false
  ): void {
    if (indices.length === 0) return;
    const lines = indices.map((idx) => items[idx].source_text);
    const subBatches = splitLinesIntoControlledBatches(lines, maxLines, maxChars);
    for (const sb of subBatches) {
      const ids = sb.map((local) => items[indices[local]].id);
      target.push({ ids, priority, isUpgrade });
    }
  }

  private pump(): void {
    if (this.disposed || this.isPaused()) return;

    while (this.inflight.size < 2 && this.queuedBatches.length > 0) {
      const batch = this.queuedBatches.shift()!;
      this.dispatchBatch(batch);
    }
  }

  private dispatchBatch(batch: ScheduledBatch): void {
    const items = this.opts.getItems();
    const itemMap = new Map<number, SubtitleItem>();
    for (const it of items) itemMap.set(it.id, it);

    const lines = batch.ids.map((id) => itemMap.get(id)?.source_text ?? "");
    const reqId = newReqId();
    this.inflight.set(reqId, batch.ids);

    const msg: C2B = {
      type: "translate",
      reqId,
      trackKey: this.opts.trackKey,
      srcLang: this.opts.srcLang || "en",
      lines,
      priority: batch.priority,
      prefer: batch.isUpgrade ? "cloud" : undefined,
    };

    this.opts.port
      .request<Extract<B2C, { type: "translate.result" }>>(msg)
      .then((res) => {
        if (this.disposed) return;
        this.inflight.delete(reqId);
        this.handleTranslateResult(batch, res);
        this.pump();
      })
      .catch((err) => {
        if (this.disposed) return;
        this.inflight.delete(reqId);
        if (import.meta.env?.DEV) console.warn("[SubTrans][scheduler] request lỗi:", err);
        this.pump();
      });
  }

  private handleTranslateResult(
    batch: ScheduledBatch,
    res: Extract<B2C, { type: "translate.result" }>
  ): void {
    if (res.error) {
      if (res.error.kind === "blocked") {
        const pauseMs = res.error.retryAfterMs ?? 10_000;
        this.pauseFor(pauseMs);
      } else if (res.error.kind === "network") {
        this.pauseFor(5_000);
      }
    }

    const items = this.opts.getItems();
    const itemMap = new Map<number, SubtitleItem>();
    for (const it of items) itemMap.set(it.id, it);

    const updates: SubtitleItem[] = [];
    const lineUpdatesByEngine: Record<string, Array<[number, string]>> = {};

    for (let i = 0; i < batch.ids.length; i++) {
      const id = batch.ids[i];
      const orig = itemMap.get(id);
      if (!orig) continue;

      const r = res.results?.[i];
      const targetText = r?.text ? r.text.trim() : "";
      const engine: EngineId | null = r?.engine ?? null;

      if (targetText) {
        const updated: SubtitleItem = {
          ...orig,
          target_text: targetText,
          translated: true,
          engine,
        };
        updates.push(updated);

        const engKey =
          engine === "cloud"
            ? this.opts.geminiModel
              ? `cloud:${this.opts.geminiModel}`
              : "cloud"
            : "api";

        if (!lineUpdatesByEngine[engKey]) {
          lineUpdatesByEngine[engKey] = [];
        }
        lineUpdatesByEngine[engKey].push([id, targetText]);
      } else {
        // Dòng rỗng: đếm số lần thử lại
        const retries = this.retries.get(id) ?? 0;
        if (retries < 3) {
          this.retries.set(id, retries + 1);
        }
      }
    }

    if (updates.length > 0) {
      const merged = upsertSubtitles(items, updates);
      this.opts.onItemsUpdated(merged);

      for (const [engKey, lineUpdates] of Object.entries(lineUpdatesByEngine)) {
        this.opts.onLinesTranslated?.(engKey, lineUpdates);
      }
    }
  }

  private isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  private pauseFor(ms: number): void {
    this.pauseUntil(Date.now() + ms);
  }

  private pauseUntil(until: number): void {
    if (until <= Date.now()) return;
    this.pausedUntil = Math.max(this.pausedUntil, until);

    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);

    const updateCountdown = () => {
      const remainingSec = Math.max(0, Math.ceil((this.pausedUntil - Date.now()) / 1000));
      if (remainingSec <= 0) {
        if (this.countdownTimer) clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.opts.onStatusMessage?.(null);
        this.pump();
        return;
      }
      const mm = String(Math.floor(remainingSec / 60)).padStart(2, "0");
      const ss = String(remainingSec % 60).padStart(2, "0");
      this.opts.onStatusMessage?.(`Đang tạm nghỉ do giới hạn API… (${mm}:${ss})`);
    };

    updateCountdown();
    this.countdownTimer = setInterval(updateCountdown, 1000);

    const waitMs = this.pausedUntil - Date.now();
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (this.countdownTimer) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
      }
      this.opts.onStatusMessage?.(null);
      this.pump();
    }, waitMs);
  }

  private handleBreakerStatus(status: Extract<B2C, { type: "status" }>): void {
    this.geminiReady = status.geminiReady;
    this.breakers = status.breakers;

    let until = 0;
    if (status.breakers.api.blocked && status.breakers.api.until > Date.now()) {
      until = Math.max(until, status.breakers.api.until);
    }
    if (status.breakers.cloud.blocked && status.breakers.cloud.until > Date.now()) {
      until = Math.max(until, status.breakers.cloud.until);
    }

    if (until > Date.now()) {
      this.pauseUntil(until);
    } else if (this.isPaused() && !status.breakers.api.blocked && !status.breakers.cloud.blocked) {
      this.pausedUntil = 0;
      if (this.pauseTimer) clearTimeout(this.pauseTimer);
      if (this.countdownTimer) clearInterval(this.countdownTimer);
      this.opts.onStatusMessage?.(null);
      this.pump();
    }
  }
}
