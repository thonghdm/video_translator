/**
 * Test hồi quy cho các bản sửa sau review Phase 9.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { act } from "react";
import { extractVideoId } from "../src/content/adapters/ytParser";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
  (globalThis as any).__subtransContent?.dispose?.();
  delete (globalThis as any).__subtransContent;
  delete (globalThis as any).chrome;
});

describe("extractVideoId — embed", () => {
  it("/embed/{id} lấy id; /embed/videoseries, /embed/live_stream KHÔNG phải id video", () => {
    expect(extractVideoId("https://www.youtube.com/embed/abc123?rel=0")).toBe("abc123");
    expect(extractVideoId("https://www.youtube-nocookie.com/embed/xyz")).toBe("xyz");
    expect(extractVideoId("https://www.youtube.com/embed/videoseries?list=PL1")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/embed/live_stream?channel=UC1")).toBeNull();
  });
});

function fakeChrome() {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    runtime: {
      id: "ext",
      onMessage: { addListener: () => {}, removeListener: () => {} },
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
}

describe("Player nạp track muộn (sau khi phát) → tự dựng session", () => {
  it("lúc đầu không có track; có track rồi 'playing' → phụ đề hiện", async () => {
    fakeChrome();
    const v = document.createElement("video");
    v.src = "blob:x";
    Object.defineProperty(v, "paused", { value: true, configurable: true });
    Object.defineProperty(v, "currentTime", { value: 1, writable: true, configurable: true });
    v.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0, toJSON() {} }) as DOMRect;
    let tracks: any[] = [];
    Object.defineProperty(v, "textTracks", {
      configurable: true,
      get: () => Object.assign([...tracks], { addEventListener: () => {} }),
    });
    document.body.appendChild(v);

    vi.resetModules();
    await act(async () => {
      await import("../src/content/index");
      await new Promise((r) => setTimeout(r, 30));
    });
    const host = () => document.querySelector("subtrans-overlay")!;
    expect(host().shadowRoot!.querySelector('[data-testid="st-subtitle"]')).toBeNull();

    // Player nạp track sau khi bắt đầu phát
    tracks = [{ kind: "subtitles", label: "English", language: "en", mode: "disabled",
      cues: [{ startTime: 0, endTime: 3, text: "Loaded late" }] }];
    await act(async () => {
      v.dispatchEvent(new Event("playing"));
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(host().shadowRoot!.querySelector('[data-testid="st-subtitle"]')?.textContent).toContain("Loaded late");
    expect(document.querySelectorAll("subtrans-overlay")).toHaveLength(1);
  });
});
