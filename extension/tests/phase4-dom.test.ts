/**
 * Phase 4 — test DOM (jsdom): Session hiển thị đúng dòng theo currentTime, OverlayHost render vào
 * Shadow DOM, không rò listener, xử lý fullscreen.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { act } from "react";
import { Session } from "../src/content/pipeline/session";
import { OverlayStore } from "../src/content/overlay/store";
import { OverlayHost } from "../src/content/overlay/mount";
import type { SubtitleSource } from "../src/content/adapters/types";
import type { Cue, TrackRef } from "../src/shared/types";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const TRACK: TrackRef = { trackKey: "web:test", platform: "web", videoId: "v", title: "t", lang: "en", kind: "html5" };
const CUES: Cue[] = [
  { start: 0, end: 2, text: "First line" },
  { start: 3, end: 5, text: "Second line" },
  { start: 6, end: 8, text: "[Music]" },
];

function fakeSource(cues = CUES): SubtitleSource & { disposed: boolean } {
  return {
    track: TRACK,
    disposed: false,
    load: async () => cues,
    dispose() {
      this.disposed = true;
    },
  };
}

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  Object.defineProperty(v, "paused", { value: true, configurable: true });
  Object.defineProperty(v, "currentTime", { value: 0, writable: true, configurable: true });
  v.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380, x: 10, y: 20, toJSON() {} }) as DOMRect;
  document.body.appendChild(v);
  return v;
}

function setTime(v: HTMLVideoElement, t: number) {
  (v as unknown as { currentTime: number }).currentTime = t;
  v.dispatchEvent(new Event("seeked"));
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
});

describe("Session", () => {
  it("hiển thị dòng theo currentTime khi seek; khoảng trống → null", async () => {
    const v = makeVideo();
    const store = new OverlayStore();
    const s = new Session(v, fakeSource(), store, null);
    expect(await s.start()).toBe(3);
    expect(store.getState().item?.source_text).toBe("First line");
    setTime(v, 4);
    expect(store.getState().item?.source_text).toBe("Second line");
    setTime(v, 2.5);
    expect(store.getState().item).toBeNull();
    setTime(v, 7);
    expect(store.getState().item?.ignored).toBe(true);
    s.dispose();
  });

  it("offset cộng vào currentTime", async () => {
    const v = makeVideo();
    const store = new OverlayStore();
    const s = new Session(v, fakeSource(), store, null, { getOffset: () => 3 });
    await s.start();
    expect(store.getState().item?.source_text).toBe("Second line");
    s.dispose();
  });

  it("chỉ đẩy vào store khi dòng đổi (không re-render thừa)", async () => {
    const v = makeVideo();
    const store = new OverlayStore();
    const s = new Session(v, fakeSource(), store, null);
    await s.start();
    const fn = vi.fn();
    store.subscribe(fn);
    setTime(v, 0.5);
    setTime(v, 1.5);
    expect(fn).not.toHaveBeenCalled();
    setTime(v, 3.5);
    expect(fn).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("dispose: gỡ listener, dispose source, xóa dòng hiện tại", async () => {
    const v = makeVideo();
    const store = new OverlayStore();
    const src = fakeSource();
    const s = new Session(v, src, store, null);
    await s.start();
    s.dispose();
    expect(src.disposed).toBe(true);
    expect(store.getState().item).toBeNull();
    const fn = vi.fn();
    store.subscribe(fn);
    setTime(v, 4);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("OverlayHost (Shadow DOM)", () => {
  it("chế độ fixed: host đặt theo rect của video, render phụ đề trong shadow root", async () => {
    const v = makeVideo();
    const store = new OverlayStore();
    let host!: OverlayHost;
    await act(async () => {
      host = new OverlayHost(v, store);
    });
    expect(host.placement).toBe("fixed");
    const el = document.querySelector("subtrans-overlay") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.getPropertyValue("position")).toBe("fixed");
    expect(el.style.getPropertyPriority("position")).toBe("important");
    expect(el.style.getPropertyValue("width")).toBe("640px");
    expect(el.style.getPropertyValue("left")).toBe("10px");

    await act(async () => {
      store.setState({
        item: { id: 0, block: 0, start_sec: 0, end_sec: 1, source_text: "Hello", target_text: "Xin chào", translated: true, engine: "cloud" },
      });
    });
    const shadow = el.shadowRoot!;
    const box = shadow.querySelector('[data-testid="st-subtitle"]')!;
    expect(box.textContent).toContain("Hello");
    expect(box.textContent).toContain("Xin chào");
    expect(box.textContent).toContain("Cloud");
    // Không lọt ra DOM của trang
    expect(document.body.textContent).not.toContain("Xin chào");

    await act(async () => store.setState({ mode: "vi" }));
    expect(shadow.querySelector('[data-testid="st-subtitle"]')!.textContent).not.toContain("Hello");
    await act(async () => store.setState({ mode: "off" }));
    expect(shadow.querySelector('[data-testid="st-subtitle"]')).toBeNull();

    await act(async () => host.dispose());
    expect(document.querySelector("subtrans-overlay")).toBeNull();
  });

  it("chế độ container: host absolute bên trong container", async () => {
    const v = makeVideo();
    const container = document.createElement("div");
    container.style.position = "relative";
    container.appendChild(v);
    document.body.appendChild(container);
    let host!: OverlayHost;
    await act(async () => {
      host = new OverlayHost(v, new OverlayStore(), { container });
    });
    const el = container.querySelector("subtrans-overlay") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.getPropertyValue("position")).toBe("absolute");
    await act(async () => host.dispose());
  });

  it("fullscreen chính thẻ <video> → native fallback; fullscreen khung bọc → chuyển host vào trong", async () => {
    const wrap = document.createElement("div");
    document.body.appendChild(wrap);
    const v = makeVideo();
    wrap.appendChild(v);
    const store = new OverlayStore();
    const native = vi.fn();
    let host!: OverlayHost;
    await act(async () => {
      host = new OverlayHost(v, store, { onNativeFallback: native });
    });
    const el = document.querySelector("subtrans-overlay") as HTMLElement;
    expect(el.parentElement).toBe(document.body);

    const setFs = (node: Element | null) => {
      Object.defineProperty(document, "fullscreenElement", { value: node, configurable: true });
      document.dispatchEvent(new Event("fullscreenchange"));
    };

    await act(async () => setFs(v));
    expect(store.getState().nativeFallback).toBe(true);
    expect(native).toHaveBeenLastCalledWith(true);

    await act(async () => setFs(wrap));
    expect(store.getState().nativeFallback).toBe(false);
    expect(el.parentElement).toBe(wrap);

    await act(async () => setFs(null));
    expect(el.parentElement).toBe(document.body);

    await act(async () => host.dispose());
    // Sau dispose, sự kiện fullscreen không còn tác dụng
    native.mockClear();
    setFs(v);
    expect(native).not.toHaveBeenCalled();
  });
});
