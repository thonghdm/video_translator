/**
 * SubTrans Extension — Session: 1 video + 1 nguồn phụ đề (PLAN Phase 6)
 * - Nạp cue -> Tính sourceHash -> Kiểm tra IndexedDB cache (cache.load).
 * - Dựng SubtitleItem, gán bản dịch đã lưu theo mode hiện tại.
 * - Khởi chạy Scheduler Two-Tier Lookahead để dịch các câu còn thiếu.
 * - Gom kết quả dịch mới (buffer), debounce 2s lưu vào IndexedDB (cache.saveLines).
 * - Vòng rAF chỉ chạy khi video đang phát và tab đang hiển thị; đồng bộ currentTime (+ offset).
 * - Khi dispose: flush toàn bộ buffer lưu trữ, hủy request dịch đang chạy, dọn dẹp listeners.
 */

import type { EngineId, SubtitleItem, SubtitleMode, TranslateMode } from "../../shared/types";
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

/** Áp dụng bản dịch từ cache IndexedDB vào danh sách SubtitleItem */
export function applyLinesToItems(
  items: SubtitleItem[],
  lines: Record<string /*engineKey*/, (string | null)[]> | undefined,
  mode: TranslateMode,
  geminiModel?: string
): void {
  if (!lines) return;
  const preferredCloudKey = geminiModel ? `cloud:${geminiModel}` : "cloud";

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.ignored) continue;

    let targetText: string | null = null;
    let engine: EngineId | null = null;

    if (mode === "google") {
      // Ưu tiên api rồi tới cloud:*
      if (lines["api"]?.[i]) {
        targetText = lines["api"][i];
        engine = "api";
      } else {
        const cloudKey = Object.keys(lines).find(
          (k) => (k === "cloud" || k.startsWith("cloud:")) && lines[k]?.[i]
        );
        if (cloudKey && lines[cloudKey]?.[i]) {
          targetText = lines[cloudKey][i];
          engine = "cloud";
        }
      }
    } else {
      // gemini hoặc hybrid: ưu tiên cloud:${model} -> cloud:* -> api
      if (lines[preferredCloudKey]?.[i]) {
        targetText = lines[preferredCloudKey][i];
        engine = "cloud";
      } else {
        const anyCloudKey = Object.keys(lines).find(
          (k) => (k === "cloud" || k.startsWith("cloud:")) && lines[k]?.[i]
        );
        if (anyCloudKey && lines[anyCloudKey]?.[i]) {
          targetText = lines[anyCloudKey][i];
          engine = "cloud";
        } else if (lines["api"]?.[i]) {
          targetText = lines["api"][i];
          engine = "api";
        }
      }
    }

    if (targetText) {
      it.target_text = targetText;
      it.translated = true;
      it.engine = engine;
    }
  }
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
    this.items = cuesToItems(cues);

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
          applyLinesToItems(this.items, this.cachedLines, mode, model);
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

    const off = this.source.onCuesChanged?.((next) => {
      // Track nạp thêm cue: dựng lại items và giữ bản dịch theo id
      const updated = cuesToItems(next);
      for (const it of updated) {
        const old = this.items[it.id];
        if (old && old.translated) {
          it.target_text = old.target_text;
          it.translated = true;
          it.engine = old.engine;
        }
      }
      this.setItems(updated);
      this.scheduler?.plan(this.getCurrentPlayhead());
    });
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
    if (this.cachedLines && Object.keys(this.cachedLines).length > 0) {
      applyLinesToItems(this.items, this.cachedLines, newSettings.mode, newSettings.gemini?.model);
      this.setItems(this.items);
    }
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
