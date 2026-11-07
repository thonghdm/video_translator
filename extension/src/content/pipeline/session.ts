/**
 * SubTrans Extension — Session: 1 video + 1 nguồn phụ đề (PLAN Phase 6)
 * - Nạp cue -> Tính sourceHash -> Kiểm tra IndexedDB cache (cache.load).
 * - Dựng SubtitleItem, gán bản dịch đã lưu theo mode hiện tại.
 * - Khởi chạy Scheduler Two-Tier Lookahead để dịch các câu còn thiếu.
 * - Gom kết quả dịch mới (buffer), debounce 2s lưu vào IndexedDB (cache.saveLines).
 * - Vòng rAF chỉ chạy khi video đang phát và tab đang hiển thị; đồng bộ currentTime (+ offset).
 * - Khi dispose: flush toàn bộ buffer lưu trữ, hủy request dịch đang chạy, dọn dẹp listeners.
 */

import type { Cue, EngineId, SubtitleItem, SubtitleMode, TranslateMode } from "../../shared/types";
import { cuesToItems, findSubtitleAtTime } from "../../shared/subtitles";
import { Disposer } from "../../shared/disposer";
import { raf, cancelRaf } from "../../shared/raf";
import { fnv1a32 } from "../../shared/hash";
import type { Settings } from "../../shared/settings";
import type { B2C } from "../../shared/messages";
import type { BackgroundPort } from "../port";
import { newReqId } from "../port";
import type { SubtitleSource } from "../adapters/types";
import type { OverlayStore } from "../overlay/store";
import type { NativeTrackFallback } from "../overlay/nativeTrackFallback";
import { Scheduler } from "../scheduler";

export interface SessionOptions {
  port?: BackgroundPort;
  settings?: Settings;
  getOffset?: () => number;
  /** Gọi khi video đổi nguồn phát (SPA player nạp video khác vào cùng thẻ) */
  onSourceChanged?: () => void;
}

export function computeSourceHash(cues: Array<{ text: string }>): string {
  return fnv1a32(cues.map((c) => c.text).join("\n"));
}

/** Chọn bản dịch cho dòng i theo mode: google ưu tiên api; gemini/hybrid ưu tiên cloud:${model} → cloud:* → api */
function pickCachedLine(
  lines: Record<string, (string | null)[]>,
  i: number,
  mode: TranslateMode,
  geminiModel?: string
): { text: string; engine: EngineId } | null {
  const cloudKeys = Object.keys(lines).filter((k) => k === "cloud" || k.startsWith("cloud:"));
  const preferredCloud = geminiModel ? `cloud:${geminiModel}` : "cloud";
  const ordered = [preferredCloud, ...cloudKeys.filter((k) => k !== preferredCloud)];
  const fromCloud = () => {
    for (const k of ordered) {
      const t = lines[k]?.[i];
      if (t) return { text: t, engine: "cloud" as const };
    }
    return null;
  };
  const fromApi = () => {
    const t = lines["api"]?.[i];
    return t ? { text: t, engine: "api" as const } : null;
  };
  return mode === "google" ? fromApi() ?? fromCloud() : fromCloud() ?? fromApi();
}

/**
 * Áp bản dịch đã lưu (cache IndexedDB + bản dịch trong phiên) vào danh sách phụ đề.
 * Trả về MẢNG MỚI; dòng nào đổi bản dịch là object mới (để store/overlay nhận ra thay đổi khi đổi mode).
 */
export function applyLinesToItems(
  items: SubtitleItem[],
  lines: Record<string /*engineKey*/, (string | null)[]> | undefined,
  mode: TranslateMode,
  geminiModel?: string
): SubtitleItem[] {
  if (!lines || Object.keys(lines).length === 0) return items;
  return items.map((it, i) => {
    if (it.ignored) return it;
    const picked = pickCachedLine(lines, i, mode, geminiModel);
    if (!picked) return it;
    if (it.translated && it.target_text === picked.text && it.engine === picked.engine) return it;
    return { ...it, target_text: picked.text, translated: true, engine: picked.engine };
  });
}

export class Session {
  private items: SubtitleItem[] = [];
  private cachedLines: Record<string, (string | null)[]> = {};
  private sourceHash = "";
  private readonly disposer = new Disposer();
  private rafId: number | null = null;
  private lastShown: SubtitleItem | null = null;
  private started = false;
  private scheduler: Scheduler | null = null;

  // Buffer gom lưu cache (debounce 2s)
  private readonly saveLinesBuffer = new Map<string /*engineKey*/, Map<number /*id*/, string /*text*/>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: SubtitleSource,
    private readonly store: OverlayStore,
    private readonly native: NativeTrackFallback | null,
    private readonly opts: SessionOptions = {}
  ) {
    this.disposer.add(() => this.stopLoop());
    this.disposer.add(() => this.flushSaveLines());
    this.disposer.add(() => this.scheduler?.dispose());
    this.disposer.add(() => this.source.dispose());
  }

  public get track() {
    return this.source.track;
  }

  public getItems(): readonly SubtitleItem[] {
    return this.items;
  }

  public async start(): Promise<number> {
    if (this.started) return this.items.length;
    this.started = true;

    const cues = await this.source.load();
    if (this.disposer.isDisposed) return 0;

    this.sourceHash = computeSourceHash(cues);
    const initialItems = this.source.getInitialItems?.();
    if (initialItems && initialItems.length === cues.length) {
      this.items = initialItems;
    } else {
      this.items = cuesToItems(cues);
    }

    // 1. Kiểm tra cache IndexedDB qua BackgroundPort
    if (this.opts.port && cues.length > 0) {
      try {
        const reqId = newReqId();
        const cacheRes = await this.opts.port.request<Extract<B2C, { type: "cache.loaded" }>>({
          type: "cache.load",
          reqId,
          trackKey: this.source.track.trackKey,
          sourceHash: this.sourceHash,
        });

        if (this.disposer.isDisposed) return 0;

        if (cacheRes && cacheRes.hit && cacheRes.lines) {
          this.cachedLines = cacheRes.lines;
          const mode = this.opts.settings?.mode ?? "google";
          const model = this.opts.settings?.gemini?.model;
          this.items = applyLinesToItems(this.items, this.cachedLines, mode, model);
        } else {
          // Lưu track mới vào IndexedDB
          this.opts.port.send({
            type: "cache.saveTrack",
            track: this.source.track,
            cues,
            sourceHash: this.sourceHash,
          });
        }
      } catch (err) {
        if (import.meta.env?.DEV) console.warn("[SubTrans][session] cache.load lỗi:", err);
      }
    }

    this.setItems(this.items);

    // 2. Khởi tạo Scheduler Two-Tier Lookahead
    if (this.opts.port && cues.length > 0) {
      this.initScheduler();
    }

    const off = this.source.onCuesChanged?.((next) => this.handleCuesChanged(next));
    if (off) this.disposer.add(off);

    this.bindVideoEvents();
    return this.items.length;
  }

  /** Thay toàn bộ danh sách phụ đề */
  public setItems(items: SubtitleItem[]): void {
    this.items = items;
    this.native?.update(items, this.store.getState().mode);
    this.lastShown = null; // buộc tính lại dòng hiện tại
    this.tick();
  }

  public onModeChanged(mode: SubtitleMode): void {
    this.native?.update(this.items, mode);
  }

  public onSettingsChanged(newSettings: Settings): void {
    this.opts.settings = newSettings;
    const next = applyLinesToItems(this.items, this.cachedLines, newSettings.mode, newSettings.gemini?.model);
    if (next !== this.items) this.setItems(next);
    this.scheduler?.updateSettings({
      mode: newSettings.mode,
      geminiModel: newSettings.gemini?.model,
      maxItemsTier2: newSettings.gemini?.maxItemsTier2,
      pretranslateWholeTrack: newSettings.pretranslateWholeTrack,
    });
    this.scheduler?.plan(this.getCurrentPlayhead());
  }

  public dispose(): void {
    this.flushSaveLines();
    this.disposer.disposeAll();
    this.items = [];
    this.lastShown = null;
    this.cachedLines = {};
    this.store.setState({ item: null });
  }

  // ---------------------------------------------------------------------------

  /**
   * Track nạp thêm/đổi cue (player HLS nạp dần, hoặc đổi nội dung):
   * - chỉ giữ bản dịch của dòng có CÙNG id VÀ CÙNG câu gốc (tránh gắn bản dịch sai câu);
   * - tính lại sourceHash; nếu đổi → lưu lại track và ghi lại các bản dịch còn hợp lệ theo hash mới.
   */
  private handleCuesChanged(next: Cue[]): void {
    const old = this.items;
    const updated = cuesToItems(next).map((it) => {
      const prev = old[it.id];
      return prev && prev.translated && prev.source_text === it.source_text
        ? { ...it, target_text: prev.target_text, translated: true, engine: prev.engine }
        : it;
    });
    const newHash = computeSourceHash(next);
    if (newHash !== this.sourceHash && this.opts.port) {
      this.sourceHash = newHash;
      this.saveLinesBuffer.clear();
      this.cachedLines = {};
      this.opts.port.send({ type: "cache.saveTrack", track: this.source.track, cues: next, sourceHash: newHash });
      const model = this.opts.settings?.gemini?.model;
      const byEngine = new Map<string, Array<[number, string]>>();
      for (const it of updated) {
        if (!it.translated || !it.target_text) continue;
        const k = it.engine === "cloud" ? (model ? `cloud:${model}` : "cloud") : "api";
        if (!byEngine.has(k)) byEngine.set(k, []);
        byEngine.get(k)!.push([it.id, it.target_text]);
      }
      this.items = updated; // để bufferSaveLines dùng đúng total mới
      for (const [k, u] of byEngine) this.bufferSaveLines(k, u);
    }
    this.setItems(updated);
    this.scheduler?.plan(this.getCurrentPlayhead());
  }

  private getCurrentPlayhead(): number {
    return this.video.currentTime + (this.opts.getOffset?.() ?? 0);
  }

  private initScheduler(): void {
    if (!this.opts.port) return;

    this.scheduler = new Scheduler({
      trackKey: this.source.track.trackKey,
      srcLang: this.source.track.lang,
      mode: this.opts.settings?.mode ?? "google",
      geminiModel: this.opts.settings?.gemini?.model,
      maxItemsTier2: this.opts.settings?.gemini?.maxItemsTier2,
      pretranslateWholeTrack: this.opts.settings?.pretranslateWholeTrack,
      port: this.opts.port,
      getItems: () => this.items,
      onItemsUpdated: (updated) => {
        this.setItems(updated);
      },
      onStatusMessage: (msg) => {
        this.store.setState({ message: msg });
      },
      onLinesTranslated: (engineKey, updates) => {
        this.bufferSaveLines(engineKey, updates);
      },
    });

    this.scheduler.plan(this.getCurrentPlayhead());
  }

  private bufferSaveLines(engineKey: string, updates: Array<[number, string]>): void {
    let map = this.saveLinesBuffer.get(engineKey);
    if (!map) {
      map = new Map<number, string>();
      this.saveLinesBuffer.set(engineKey, map);
    }
    for (const [id, text] of updates) {
      map.set(id, text);
      // Cập nhật bộ nhớ local cachedLines để nếu đổi mode thì có sẵn
      if (!this.cachedLines[engineKey]) {
        this.cachedLines[engineKey] = new Array(this.items.length).fill(null);
      }
      this.cachedLines[engineKey][id] = text;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushSaveLines();
      }, 2000);
    }
  }

  private flushSaveLines(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.opts.port || this.saveLinesBuffer.size === 0 || !this.sourceHash) return;

    for (const [engineKey, map] of this.saveLinesBuffer.entries()) {
      if (map.size === 0) continue;
      const updates = Array.from(map.entries());
      this.opts.port.send({
        type: "cache.saveLines",
        trackKey: this.source.track.trackKey,
        engineKey,
        sourceHash: this.sourceHash,
        total: this.items.length,
        updates,
      });
      map.clear();
    }
    this.saveLinesBuffer.clear();
  }

  private bindVideoEvents(): void {
    const v = this.video;
    const { signal } = this.disposer;
    const once = () => this.tick();

    v.addEventListener("play", () => this.startLoop(), { signal });
    v.addEventListener("playing", () => this.startLoop(), { signal });
    v.addEventListener("pause", () => (this.stopLoop(), once()), { signal });
    v.addEventListener("ended", () => (this.stopLoop(), once()), { signal });
    v.addEventListener(
      "seeked",
      () => {
        once();
        this.scheduler?.onSeeked(this.getCurrentPlayhead());
      },
      { signal }
    );
    v.addEventListener("ratechange", once, { signal });

    let loadCount = 0;
    v.addEventListener(
      "loadstart",
      () => {
        loadCount++;
        // Lần loadstart sau khi session đã chạy = nguồn video đổi
        if (loadCount >= 1 && this.items.length > 0) this.opts.onSourceChanged?.();
      },
      { signal }
    );

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) this.stopLoop();
        else if (!v.paused) this.startLoop();
      },
      { signal }
    );

    // Định kỳ mỗi 2s quét lại lịch dịch để bám sát playhead
    this.disposer.interval(() => {
      if (!v.paused && !document.hidden) {
        this.scheduler?.tick(this.getCurrentPlayhead());
      }
    }, 2000);

    if (!v.paused && !v.ended) this.startLoop();
    else this.tick();
  }

  private startLoop(): void {
    if (this.rafId !== null || this.disposer.isDisposed || document.hidden) return;
    const step = () => {
      this.rafId = null;
      if (this.disposer.isDisposed) return;
      this.tick();
      if (!this.video.paused && !this.video.ended && !document.hidden) {
        this.rafId = raf(step);
      }
    };
    this.rafId = raf(step);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelRaf(this.rafId);
      this.rafId = null;
    }
  }

  private tick(): void {
    const t = this.getCurrentPlayhead();
    const item = findSubtitleAtTime(this.items, t);
    if (item === this.lastShown) return;
    this.lastShown = item;
    this.store.setState({ item });
  }
}
