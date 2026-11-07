/**
 * SubTrans Extension — Bộ lập lịch dịch phụ đề (PLAN Phase 6)
 * Port thuật toán Two-Tier Lookahead từ pipeline.go:
 * - Tier-1: cửa sổ [t − 1s, t + 15s], batch nhỏ 3 dòng/240 ký tự → hiện gần như ngay.
 * - Tier-2: phía trước (tăng dần) rồi phía sau. GTX: 5 dòng/400 ký tự; Gemini: maxItemsTier2 dòng/2000 ký tự.
 * - Tối đa 2 batch đang chạy mỗi session; Tier-1 luôn được lấy trước.
 *
 * Giao ước lỗi với background (NOTES.md › Phase 2):
 *   blocked  → tạm nghỉ theo retryAfterMs (mặc định 10s), KHÔNG tính lượt retry
 *   network  → tạm nghỉ 5s, KHÔNG tính lượt retry (mạng có lại thì dịch tiếp)
 *   disabled → thiếu Gemini key: ngừng upgrade, không retry
 *   other / dòng rỗng không lỗi → tính 1 lượt retry (tối đa 3)
 *
 * Upgrade lên Gemini (hybrid, và gemini với các dòng đã phải rơi về GTX):
 *   chỉ chạy khi KHÔNG còn việc dịch thường; gửi priority "upgrade" (router: chỉ cloud, không rơi về GTX);
 *   mỗi dòng tối đa 2 lần thử; không phụ thuộc geminiReady (bucket có thể tạm cạn đúng lúc status gửi).
 * Trạng thái breaker từ background chỉ dùng để biết cloud có đang khóa không — KHÔNG tự tạm dừng dựa vào nó
 * (router đã tự chuyển tầng; chỉ trả lỗi khi KHÔNG tầng nào dịch được).
 */

import type { EngineId, Priority, SubtitleItem, TranslateMode } from "../shared/types";
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

type TranslateResult = Extract<B2C, { type: "translate.result" }>;

export const MAX_INFLIGHT = 2;
export const MAX_RETRIES = 3;
export const MAX_UPGRADE_ATTEMPTS = 2;
const LOOKAHEAD_WHEN_NOT_PRETRANSLATING_SEC = 60;

export function inPlayWindow(item: SubtitleItem, playheadSec: number): boolean {
  return item.end_sec >= playheadSec - 1.0 && item.start_sec <= playheadSec + 15.0;
}

/** Mã ngôn ngữ nguồn hợp lệ cho GTX ("und"/rỗng → "auto") */
export function normalizeSrcLang(lang: string | undefined): string {
  const l = (lang || "").trim();
  if (!l || l.toLowerCase() === "und") return "auto";
  return l;
}

export function engineKeyFor(engine: EngineId | null, geminiModel?: string): string {
  return engine === "cloud" ? (geminiModel ? `cloud:${geminiModel}` : "cloud") : "api";
}

export class Scheduler {
  private readonly inflight = new Map<string, number[]>(); // reqId -> item ids
  private readonly retries = new Map<number, number>(); // id -> số lượt "other"/rỗng
  private readonly upgradeAttempts = new Map<number, number>(); // id -> số lần thử upgrade
  private queuedBatches: ScheduledBatch[] = [];
  private pausedUntil = 0;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private geminiDisabled = false;
  private lastPlayhead = 0;
  private breakers: { api: BreakerView; cloud: BreakerView } = {
    api: { blocked: false, until: 0 },
    cloud: { blocked: false, until: 0 },
  };
  private unregisterStatus: (() => void) | null = null;

  constructor(private readonly opts: SchedulerOptions) {
    this.unregisterStatus = this.opts.port.onStatus((s) => {
      this.breakers = s.breakers;
    });
  }

  public get inflightCount(): number {
    return this.inflight.size;
  }

  public get queuedCount(): number {
    return this.queuedBatches.length;
  }

  public get paused(): boolean {
    return this.isPaused();
  }

  public updateSettings(patch: {
    mode?: TranslateMode;
    geminiModel?: string;
    maxItemsTier2?: number;
    pretranslateWholeTrack?: boolean;
  }): void {
    if (patch.mode && patch.mode !== this.opts.mode) {
      this.opts.mode = patch.mode;
      this.upgradeAttempts.clear(); // đổi mode: cho phép thử upgrade lại
    }
    if (patch.geminiModel !== undefined && patch.geminiModel !== this.opts.geminiModel) {
      this.opts.geminiModel = patch.geminiModel;
      this.geminiDisabled = false;
      this.upgradeAttempts.clear();
    }
    if (patch.maxItemsTier2 !== undefined) this.opts.maxItemsTier2 = patch.maxItemsTier2;
    if (patch.pretranslateWholeTrack !== undefined) {
      this.opts.pretranslateWholeTrack = patch.pretranslateWholeTrack;
    }
  }

  /** Lập lại toàn bộ hàng đợi theo playhead hiện tại (batch đang chạy không bị hủy) */
  public plan(playheadSec: number): void {
    if (this.disposed) return;
    this.lastPlayhead = playheadSec;
    const items = this.opts.getItems();
    if (!items || items.length === 0) return;

    const inflightIds = new Set<number>();
    for (const ids of this.inflight.values()) for (const id of ids) inflightIds.add(id);

    const tier1: number[] = [];
    const ahead: number[] = [];
    const behind: number[] = [];
    let pendingNormalWork = false;
    const pretranslateAll = this.opts.pretranslateWholeTrack ?? true;
    const maxAhead = playheadSec + 15 + LOOKAHEAD_WHEN_NOT_PRETRANSLATING_SEC;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.ignored || it.translated) continue;
      if (inflightIds.has(it.id)) {
        pendingNormalWork = true;
        continue;
      }
      if ((this.retries.get(it.id) ?? 0) >= MAX_RETRIES) continue;
      if (inPlayWindow(it, playheadSec)) {
        tier1.push(i);
      } else if (it.start_sec > playheadSec + 15) {
        if (pretranslateAll || it.start_sec <= maxAhead) ahead.push(i);
        else pendingNormalWork = true; // còn việc, chỉ là chưa tới lượt
      } else {
        behind.push(i);
      }
    }
    if (tier1.length || ahead.length || behind.length) pendingNormalWork = true;

    const batches: ScheduledBatch[] = [];
    this.pack(items, tier1, 3, 240, "tier1", batches);
    const geminiTier2 = this.opts.mode === "gemini" || this.opts.mode === "hybrid";
    const maxLines = geminiTier2 ? this.opts.maxItemsTier2 ?? 20 : 5;
    const maxChars = geminiTier2 ? 2000 : 400;
    this.pack(items, ahead, maxLines, maxChars, "tier2", batches);
    this.pack(items, behind, maxLines, maxChars, "tier2", batches);

    // Upgrade: chỉ khi đã hết việc dịch thường
    if (!pendingNormalWork && this.canUpgrade()) {
      const upgrade: number[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (
          it.translated &&
          it.engine === "api" &&
          !it.ignored &&
          !inflightIds.has(it.id) &&
          (this.upgradeAttempts.get(it.id) ?? 0) < MAX_UPGRADE_ATTEMPTS
        ) {
          upgrade.push(i);
        }
      }
      // Ưu tiên dòng gần playhead trước
      upgrade.sort((a, b) => distance(items[a], playheadSec) - distance(items[b], playheadSec));
      this.pack(items, upgrade, this.opts.maxItemsTier2 ?? 20, 2000, "tier2", batches, true);
    }

    this.queuedBatches = batches;
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
    this.unregisterStatus?.();
    this.unregisterStatus = null;
    this.clearPauseTimers();
    for (const reqId of this.inflight.keys()) this.opts.port.cancel(reqId);
    this.inflight.clear();
    this.queuedBatches = [];
    this.retries.clear();
    this.upgradeAttempts.clear();
    this.opts.onStatusMessage?.(null);
  }

  // ---------------------------------------------------------------------------

  private canUpgrade(): boolean {
    const m = this.opts.mode;
    return (m === "hybrid" || m === "gemini") && !this.geminiDisabled && !this.breakers.cloud.blocked;
  }

  private pack(
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
    for (const sb of splitLinesIntoControlledBatches(lines, maxLines, maxChars)) {
      target.push({ ids: sb.map((local) => items[indices[local]].id), priority, isUpgrade });
    }
  }

  private pump(): void {
    if (this.disposed || this.isPaused()) return;
    while (this.inflight.size < MAX_INFLIGHT && this.queuedBatches.length > 0) {
      this.dispatch(this.queuedBatches.shift()!);
    }
  }

  private dispatch(batch: ScheduledBatch): void {
    const byId = new Map(this.opts.getItems().map((it) => [it.id, it] as const));
    const reqId = newReqId();
    this.inflight.set(reqId, batch.ids);
    const priority: Priority = batch.isUpgrade ? "upgrade" : batch.priority;
    const msg: C2B = {
      type: "translate",
      reqId,
      trackKey: this.opts.trackKey,
      srcLang: normalizeSrcLang(this.opts.srcLang),
      lines: batch.ids.map((id) => byId.get(id)?.source_text ?? ""),
      priority,
    };
    this.opts.port
      .request<TranslateResult>(msg)
      .then((res) => {
        if (this.disposed) return;
        this.inflight.delete(reqId);
        this.handleResult(batch, res);
        this.pump();
      })
      .catch((err) => {
        if (this.disposed) return;
        this.inflight.delete(reqId);
        if (import.meta.env?.DEV) console.warn("[SubTrans][scheduler] request lỗi:", err);
        // Timeout/port lỗi: coi như lỗi tạm thời, không tính lượt retry; lập lại lịch sau
        this.pauseFor(3_000, false);
      });
  }

  private handleResult(batch: ScheduledBatch, res: TranslateResult): void {
    const kind = res.error?.kind;
    if (kind === "blocked") this.pauseFor(res.error?.retryAfterMs ?? 10_000, true);
    else if (kind === "network") this.pauseFor(5_000, true);
    else if (kind === "disabled" && batch.isUpgrade) this.geminiDisabled = true;
    // "Lỗi tạm thời" (blocked/network/canceled) không đốt lượt retry của dòng
    const transient = kind === "blocked" || kind === "network" || kind === "canceled" || kind === "disabled";

    const items = this.opts.getItems();
    const byId = new Map(items.map((it) => [it.id, it] as const));
    const updates: SubtitleItem[] = [];
    const lineUpdates: Record<string, Array<[number, string]>> = {};

    batch.ids.forEach((id, i) => {
      const orig = byId.get(id);
      if (!orig) return;
      const r = res.results?.[i];
      const text = r?.text?.trim() ?? "";
      const engine: EngineId | null = r?.engine ?? null;

      if (batch.isUpgrade) {
        if (text && engine === "cloud") {
          updates.push({ ...orig, target_text: text, translated: true, engine });
          (lineUpdates[engineKeyFor(engine, this.opts.geminiModel)] ??= []).push([id, text]);
        } else if (!transient || kind === "disabled") {
          this.upgradeAttempts.set(id, (this.upgradeAttempts.get(id) ?? 0) + 1);
        }
        return;
      }

      if (text) {
        updates.push({ ...orig, target_text: text, translated: true, engine });
        (lineUpdates[engineKeyFor(engine, this.opts.geminiModel)] ??= []).push([id, text]);
      } else if (!transient) {
        this.retries.set(id, Math.min(MAX_RETRIES, (this.retries.get(id) ?? 0) + 1));
      }
    });

    if (updates.length > 0) {
      this.opts.onItemsUpdated(upsertSubtitles(items, updates));
      for (const [k, u] of Object.entries(lineUpdates)) this.opts.onLinesTranslated?.(k, u);
    }
  }

  private isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  private clearPauseTimers(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.pauseTimer = null;
    this.countdownTimer = null;
  }

  /** Tạm dừng gửi batch mới; hết hạn thì lập lại lịch theo playhead gần nhất */
  private pauseFor(ms: number, showCountdown: boolean): void {
    const until = Date.now() + Math.max(0, ms);
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    this.clearPauseTimers();

    const update = () => {
      const remain = Math.max(0, Math.ceil((this.pausedUntil - Date.now()) / 1000));
      if (remain <= 0) return;
      const mm = String(Math.floor(remain / 60)).padStart(2, "0");
      const ss = String(remain % 60).padStart(2, "0");
      this.opts.onStatusMessage?.(`Đang tạm nghỉ do giới hạn API… (${mm}:${ss})`);
    };
    if (showCountdown) {
      update();
      this.countdownTimer = setInterval(update, 1000);
    }
    this.pauseTimer = setTimeout(() => {
      this.clearPauseTimers();
      this.pausedUntil = 0;
      if (showCountdown) this.opts.onStatusMessage?.(null);
      this.plan(this.lastPlayhead);
    }, Math.max(0, this.pausedUntil - Date.now()));
  }
}

function distance(it: SubtitleItem, t: number): number {
  if (t < it.start_sec) return it.start_sec - t;
  if (t > it.end_sec) return t - it.end_sec;
  return 0;
}
