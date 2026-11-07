/**
 * SubTrans Extension — Session: 1 video + 1 nguồn phụ đề (PLAN 4.10, bản tối thiểu của Phase 4)
 * - Nạp cue → SubtitleItem → hiển thị dòng ứng với currentTime (+ offset).
 * - Vòng rAF CHỈ chạy khi video đang phát và tab đang hiện; pause/ended/seeked chỉ cập nhật 1 lần.
 * - Chỉ đẩy vào store khi id dòng hiện tại (hoặc nội dung của nó) đổi.
 * - Phase 6 sẽ bổ sung dịch (scheduler) qua setItems().
 */

import type { SubtitleItem, SubtitleMode } from "../../shared/types";
import { cuesToItems, findSubtitleAtTime } from "../../shared/subtitles";
import { Disposer } from "../../shared/disposer";
import { raf, cancelRaf } from "../../shared/raf";
import type { SubtitleSource } from "../adapters/types";
import type { OverlayStore } from "../overlay/store";
import type { NativeTrackFallback } from "../overlay/nativeTrackFallback";

export interface SessionOptions {
  getOffset?: () => number;
  /** Gọi khi video đổi nguồn phát (SPA player nạp video khác vào cùng thẻ) */
  onSourceChanged?: () => void;
}

export class Session {
  private items: SubtitleItem[] = [];
  private readonly disposer = new Disposer();
  private rafId: number | null = null;
  private lastShown: SubtitleItem | null = null;
  private started = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: SubtitleSource,
    private readonly store: OverlayStore,
    private readonly native: NativeTrackFallback | null,
    private readonly opts: SessionOptions = {}
  ) {
    this.disposer.add(() => this.stopLoop());
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
    this.setItems(cuesToItems(cues));

    const off = this.source.onCuesChanged?.((next) => {
      // Track nạp thêm cue: dựng lại items (giữ bản dịch theo id ở Phase 6)
      this.setItems(cuesToItems(next));
    });
    if (off) this.disposer.add(off);

    this.bindVideoEvents();
    return this.items.length;
  }

  /** Thay toàn bộ danh sách (Phase 6 dùng để đẩy bản dịch vào) */
  public setItems(items: SubtitleItem[]): void {
    this.items = items;
    this.native?.update(items, this.store.getState().mode);
    this.lastShown = null; // buộc tính lại dòng hiện tại
    this.tick();
  }

  public onModeChanged(mode: SubtitleMode): void {
    this.native?.update(this.items, mode);
  }

  public dispose(): void {
    this.disposer.disposeAll();
    this.items = [];
    this.lastShown = null;
    this.store.setState({ item: null });
  }

  // ---------------------------------------------------------------------------

  private bindVideoEvents(): void {
    const v = this.video;
    const { signal } = this.disposer;
    const once = () => this.tick();
    v.addEventListener("play", () => this.startLoop(), { signal });
    v.addEventListener("playing", () => this.startLoop(), { signal });
    v.addEventListener("pause", () => (this.stopLoop(), once()), { signal });
    v.addEventListener("ended", () => (this.stopLoop(), once()), { signal });
    v.addEventListener("seeked", once, { signal });
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
    const t = this.video.currentTime + (this.opts.getOffset?.() ?? 0);
    const item = findSubtitleAtTime(this.items, t);
    if (item === this.lastShown) return;
    this.lastShown = item;
    this.store.setState({ item });
  }
}
