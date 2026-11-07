/**
 * SubTrans Extension — Gắn overlay vào trang bằng Shadow DOM (PLAN 4.5)
 *
 * Hai chế độ đặt vị trí:
 *  1. "container": adapter đưa container có position ≠ static (vd. #movie_player) → host absolute inset:0.
 *  2. "fixed":     generic → host position:fixed, đồng bộ theo video.getBoundingClientRect().
 *
 * Fullscreen:
 *  - fullscreenElement CHỨA video → chuyển host vào trong fullscreenElement (nếu chưa nằm trong đó).
 *  - fullscreenElement === video  → không vẽ được con → bật NativeTrackFallback.
 *  - thoát fullscreen              → trả host về chỗ cũ.
 *
 * Host là custom tag <subtrans-overlay> với style inline !important để CSS của trang không đụng được.
 */

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import css from "./overlay.css?inline";
import { Disposer } from "../../shared/disposer";
import { raf } from "../../shared/raf";
import { OverlayApp } from "./OverlayApp";
import type { OverlayStore } from "./store";
import { overlayPosKey } from "./useDraggable";

export type OverlayPlacement = "container" | "fixed";

export interface OverlayHostOptions {
  /** Container có position ≠ static; null/undefined = chế độ fixed */
  container?: HTMLElement | null;
  /** Gọi khi cần bật/tắt chế độ TextTrack gốc (fullscreen chính thẻ video) */
  onNativeFallback?: (on: boolean) => void;
  onOffsetChange?: (delta: number) => void;
  onOffsetReset?: () => void;
  onImportFile?: (file: File) => void;
  onExport?: (format: "srt" | "vtt", mode: "bilingual" | "target" | "source") => void;
}

const HOST_TAG = "subtrans-overlay";
const Z_FIXED = "2147483646";
const Z_CONTAINER = "60";

function setImportant(el: HTMLElement, styles: Record<string, string>): void {
  for (const [k, v] of Object.entries(styles)) {
    el.style.setProperty(k, v, "important");
  }
}

export class OverlayHost {
  public readonly host: HTMLElement;
  public readonly placement: OverlayPlacement;
  private readonly shadow: ShadowRoot;
  private readonly root: Root;
  private readonly disposer = new Disposer();
  private readonly homeParent: Element;
  private rafPending = false;
  private nativeOn = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly store: OverlayStore,
    private readonly opts: OverlayHostOptions = {}
  ) {
    const doc = video.ownerDocument;
    this.placement = opts.container ? "container" : "fixed";
    this.homeParent = opts.container ?? doc.body ?? doc.documentElement;

    this.host = doc.createElement(HOST_TAG);
    this.host.setAttribute("data-subtrans-host", "");
    setImportant(this.host, {
      all: "initial",
      display: "block",
      "pointer-events": "none",
      margin: "0",
      padding: "0",
      border: "0",
      contain: "layout style",
    });
    if (this.placement === "container") {
      setImportant(this.host, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        "z-index": Z_CONTAINER,
      });
    } else {
      setImportant(this.host, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "0px",
        height: "0px",
        "z-index": Z_FIXED,
      });
    }

    this.shadow = this.host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = css;
    this.shadow.appendChild(style);
    const mountPoint = doc.createElement("div");
    this.shadow.appendChild(mountPoint);

    this.homeParent.appendChild(this.host);
    this.disposer.add(() => this.host.remove());

    this.root = createRoot(mountPoint);
    this.disposer.add(() => this.root.unmount());
    this.root.render(
      createElement(OverlayApp, {
        store,
        getContainerRect: this.getContainerRect,
        storageKey: overlayPosKey(location.hostname),
        onOffsetChange: opts.onOffsetChange,
        onOffsetReset: opts.onOffsetReset,
        onImportFile: opts.onImportFile,
        onExport: opts.onExport,
      })
    );

    this.setupPositioning();
    this.setupFullscreen();
  }

  /** Rect vùng player (dùng cho kéo thả) */
  public getContainerRect = (): DOMRect | null => {
    const r = this.host.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };

  public dispose(): void {
    if (this.nativeOn) this.opts.onNativeFallback?.(false);
    this.disposer.disposeAll();
  }

  // ---------------------------------------------------------------------------

  private setupPositioning(): void {
    if (this.placement !== "fixed") return;
    const sync = () => {
      this.rafPending = false;
      if (this.disposer.isDisposed) return;
      const r = this.video.getBoundingClientRect();
      const hidden = r.width < 2 || r.height < 2;
      setImportant(this.host, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        visibility: hidden ? "hidden" : "visible",
      });
    };
    const schedule = () => {
      if (this.rafPending || this.disposer.isDisposed) return;
      this.rafPending = true;
      raf(sync);
    };
    sync();
    const { signal } = this.disposer;
    if (typeof ResizeObserver !== "undefined") {
      this.disposer.observe(new ResizeObserver(schedule)).observe(this.video);
    }
    window.addEventListener("scroll", schedule, { capture: true, passive: true, signal });
    window.addEventListener("resize", schedule, { passive: true, signal });
    // Dự phòng cho thay đổi layout không phát sự kiện (đổi theater mode, sidebar...)
    this.disposer.interval(schedule, 1000);
  }

  private setupFullscreen(): void {
    const doc = this.video.ownerDocument;
    const onChange = () => {
      const fe = doc.fullscreenElement;
      if (!fe) {
        this.setNative(false);
        if (this.host.parentElement !== this.homeParent) this.homeParent.appendChild(this.host);
        return;
      }
      if (fe === this.video) {
        this.setNative(true);
        return;
      }
      this.setNative(false);
      if (fe.contains(this.video) && !fe.contains(this.host)) {
        fe.appendChild(this.host);
      }
    };
    doc.addEventListener("fullscreenchange", onChange, { signal: this.disposer.signal });
    onChange();
  }

  private setNative(on: boolean): void {
    if (this.nativeOn === on) return;
    this.nativeOn = on;
    this.store.setState({ nativeFallback: on });
    this.opts.onNativeFallback?.(on);
  }
}
