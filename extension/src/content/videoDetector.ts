/**
 * SubTrans Extension — Dò thẻ <video> chính trên trang (PLAN 4.2 + quy tắc dọn dẹp Phase 6)
 * - Chọn video hiển thị lớn nhất (≥ 200×120px) và có nguồn phát.
 * - Chưa tìm thấy: MutationObserver (debounce 500ms) + quét lại mỗi 3s (video lazy/chưa có kích thước).
 * - Đã tìm thấy: NGẮT observer, chỉ kiểm tra mỗi 2s xem video còn trong DOM không.
 */

import { Disposer } from "../shared/disposer";

export const MIN_VIDEO_WIDTH = 200;
export const MIN_VIDEO_HEIGHT = 120;

export interface VideoLike {
  getBoundingClientRect(): { width: number; height: number };
  readyState: number;
  currentSrc?: string;
  src?: string;
  querySelector?(sel: string): unknown;
  isConnected?: boolean;
}

export function isCandidateVideo(v: VideoLike): boolean {
  const r = v.getBoundingClientRect();
  if (r.width < MIN_VIDEO_WIDTH || r.height < MIN_VIDEO_HEIGHT) return false;
  return (
    v.readyState >= 1 ||
    Boolean(v.currentSrc) ||
    Boolean(v.src) ||
    Boolean(v.querySelector?.("source"))
  );
}

export function pickLargestVideo<T extends VideoLike>(videos: ArrayLike<T>): T | null {
  let best: T | null = null;
  let bestArea = 0;
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (!isCandidateVideo(v)) continue;
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

export class VideoDetector {
  private readonly disposer = new Disposer();
  private phase: Disposer | null = null;
  private current: HTMLVideoElement | null = null;

  constructor(
    private readonly doc: Document,
    private readonly onChange: (video: HTMLVideoElement | null) => void
  ) {}

  public start(): void {
    this.scan();
    if (!this.current) this.watchForVideo();
  }

  public dispose(): void {
    this.phase = null;
    this.disposer.disposeAll();
  }

  public getCurrent(): HTMLVideoElement | null {
    return this.current;
  }

  /** Buộc quét lại (ví dụ khi SPA đổi trang) */
  public rescan(): void {
    this.scan();
  }

  private scan(): void {
    if (this.disposer.isDisposed) return;
    const best = pickLargestVideo(this.doc.querySelectorAll("video"));
    if (best === this.current) return;
    this.current = best;
    this.onChange(best);
    if (best) this.watchCurrent();
    else this.watchForVideo();
  }

  /** Chưa có video: observer + quét định kỳ */
  private watchForVideo(): void {
    this.phase?.disposeAll();
    const d = (this.phase = this.disposer.child());
    let debounce: ReturnType<typeof setTimeout> | null = null;
    d.add(() => {
      if (debounce) clearTimeout(debounce);
    });
    const root = this.doc.documentElement ?? this.doc.body;
    if (root && typeof MutationObserver !== "undefined") {
      const mo = d.observe(
        new MutationObserver(() => {
          if (debounce) return;
          debounce = setTimeout(() => {
            debounce = null;
            this.scan();
          }, 500);
        })
      );
      mo.observe(root, { childList: true, subtree: true });
    }
    d.interval(() => this.scan(), 3000);
  }

  /** Đã có video: ngắt observer, chỉ kiểm tra video còn trong DOM */
  private watchCurrent(): void {
    this.phase?.disposeAll();
    const d = (this.phase = this.disposer.child());
    d.interval(() => {
      if (this.current && !this.current.isConnected) {
        this.current = null;
        this.onChange(null);
        this.scan();
      }
    }, 2000);
  }
}
