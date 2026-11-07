/**
 * Test hồi quy cho các lỗi phát hiện khi review Phase 8, chạy ContentController thật trong jsdom.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { act } from "react";
import { isTypingEvent } from "../src/content/index";
import { NativeTrackFallback } from "../src/content/overlay/nativeTrackFallback";
import type { SubtitleItem } from "../src/shared/types";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function fakeChrome() {
  const store: Record<string, unknown> = {};
  let onMessage: any = null;
  (globalThis as any).chrome = {
    runtime: {
      id: "ext",
      onMessage: { addListener: (l: any) => (onMessage = l) },
      connect: () => {
        throw new Error("Could not establish connection");
      },
    },
    storage: {
      local: {
        get: async (k: string | string[]) => {
          const ks = Array.isArray(k) ? k : [k];
          return Object.fromEntries(ks.filter((x) => x in store).map((x) => [x, store[x]]));
        },
        set: async (o: Record<string, unknown>) => Object.assign(store, o),
        remove: async () => {},
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  return { store, getOnMessage: () => onMessage };
}

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.src = "blob:test";
  Object.defineProperty(v, "paused", { value: true, configurable: true });
  Object.defineProperty(v, "currentTime", { value: 1, writable: true, configurable: true });
  v.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.appendChild(v);
  return v;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function bootContent() {
  vi.resetModules();
  await act(async () => {
    await import("../src/content/index");
    await tick(30);
  });
}

function hosts() {
  return document.querySelectorAll("subtrans-overlay");
}

async function importFile(name: string, content: string) {
  const host = hosts()[0] as HTMLElement;
  const input = host.shadowRoot!.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], name, { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(30);
  });
}

const SRT_A = "1\n00:00:00,500 --> 00:00:03,000\nHello there\nXin chào\n\n";
const SRT_B = "1\n00:00:00,500 --> 00:00:03,000\nSecond file\nTệp thứ hai\n\n";

afterEach(() => {
  document.body.innerHTML = "";
  delete (globalThis as any).chrome;
  vi.useRealTimers();
});

describe("Phase 8 — nhập file không nhân đôi overlay", () => {
  it("video không có track → 1 overlay; nhập 2 file liên tiếp → vẫn 1 overlay, hiện nội dung file mới", async () => {
    fakeChrome();
    makeVideo();
    await bootContent();
    expect(hosts()).toHaveLength(1);

    await importFile("a.srt", SRT_A);
    expect(hosts()).toHaveLength(1);
    let box = hosts()[0].shadowRoot!.querySelector('[data-testid="st-subtitle"]');
    expect(box?.textContent).toContain("Xin chào");

    await importFile("b.srt", SRT_B);
    expect(hosts()).toHaveLength(1);
    box = hosts()[0].shadowRoot!.querySelector('[data-testid="st-subtitle"]');
    expect(box?.textContent).toContain("Tệp thứ hai");
    expect(box?.textContent).not.toContain("Xin chào");
    // native fallback: không tạo nhiều track "SubTrans"
    const v = document.querySelector("video")!;
    expect(Array.from(v.textTracks ?? []).filter((t) => t.label === "SubTrans").length).toBeLessThanOrEqual(1);
  });

  it("file rỗng/không hợp lệ → báo lỗi, giữ nguyên trạng thái", async () => {
    fakeChrome();
    makeVideo();
    await bootContent();
    await importFile("bad.srt", "không phải phụ đề");
    expect(hosts()).toHaveLength(1);
    const toast = hosts()[0].shadowRoot!.textContent || "";
    expect(toast).toContain("không có dòng phụ đề hợp lệ");
  });
});

describe("Phase 8 — phím tắt không cướp phím của trang", () => {
  it("trang KHÔNG có phụ đề: phím V/G/H đi tiếp tới trang (không preventDefault)", async () => {
    fakeChrome();
    makeVideo(); // video không track, chưa nhập file
    await bootContent();
    for (const key of ["v", "g", "h"]) {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
  });

  it("có phụ đề: V đổi chế độ, G/H chỉnh lệch; đang gõ (kể cả trong Shadow DOM) thì bỏ qua", async () => {
    const { store } = fakeChrome();
    makeVideo();
    await bootContent();
    await importFile("a.srt", SRT_A);

    const g = new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true });
    await act(async () => {
      document.body.dispatchEvent(g);
    });
    expect(g.defaultPrevented).toBe(true);
    expect(Object.keys(store).some((k) => k.startsWith("offset:file:a.srt"))).toBe(true);

    // Ô nhập nằm trong Shadow DOM của một web component
    const hostEl = document.createElement("div");
    document.body.appendChild(hostEl);
    const sr = hostEl.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    sr.appendChild(input);
    const typed = new KeyboardEvent("keydown", { key: "v", bubbles: true, composed: true, cancelable: true });
    input.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
  });

  it("isTypingEvent dùng composedPath", () => {
    const sr = document.createElement("div").attachShadow({ mode: "open" });
    const ta = document.createElement("textarea");
    sr.appendChild(ta);
    const host = sr.host;
    expect(isTypingEvent({ target: host, composedPath: () => [ta, sr, host] } as any)).toBe(true);
    expect(isTypingEvent({ target: host, composedPath: () => [host, document.body] } as any)).toBe(false);
  });
});

describe("Phase 8 — MiniToolbar chỉ hiện khi rê chuột lên video", () => {
  it("không hover → ẩn và không chặn click; hover vào vùng video → hiện; ra ngoài → ẩn", async () => {
    fakeChrome();
    makeVideo();
    await bootContent();
    const tb = () => hosts()[0].shadowRoot!.querySelector('[data-testid="st-toolbar"]') as HTMLElement;
    expect(tb().dataset.revealed).toBe("false");
    expect(tb().className).toContain("pointer-events-none");

    await act(async () => {
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 100, bubbles: true }));
      await tick(40);
    });
    expect(tb().dataset.revealed).toBe("true");

    await act(async () => {
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 900, clientY: 900, bubbles: true }));
      await tick(40);
    });
    expect(tb().dataset.revealed).toBe("false");
  });
});

describe("Phase 8 — độ lệch áp cho native fallback (fullscreen chính thẻ <video>)", () => {
  it("cue dời theo offset", () => {
    const added: Array<[number, number]> = [];
    (globalThis as any).VTTCue = class {
      constructor(public startTime: number, public endTime: number, public text: string) {}
    };
    const v = document.createElement("video");
    const fakeTrack: any = { mode: "disabled", cues: [], addCue: (c: any) => added.push([c.startTime, c.endTime]), removeCue: () => {} };
    (v as any).addTextTrack = () => fakeTrack;
    const items: SubtitleItem[] = [
      { id: 0, block: 0, start_sec: 10, end_sec: 12, source_text: "A", target_text: "", translated: false, engine: null },
    ];
    const n = new NativeTrackFallback(v);
    n.enable(items, "en");
    n.setOffset(0.5);
    expect(added[added.length - 1]).toEqual([9.5, 11.5]);
    delete (globalThis as any).VTTCue;
  });
});
