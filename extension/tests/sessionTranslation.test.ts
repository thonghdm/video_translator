/**
 * SubTrans Extension — Unit tests cho Session Translation & Caching (PLAN Phase 6)
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import {
  Session,
  computeSourceHash,
  applyLinesToItems,
} from "../src/content/pipeline/session";
import { OverlayStore } from "../src/content/overlay/store";
import type { SubtitleSource } from "../src/content/adapters/types";
import type { Cue, SubtitleItem, TrackRef } from "../src/shared/types";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { BackgroundPort } from "../src/content/port";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const TRACK: TrackRef = {
  trackKey: "web:session-test",
  platform: "web",
  videoId: "v123",
  title: "Test Video",
  lang: "en",
  kind: "html5",
};

const CUES: Cue[] = [
  { start: 0, end: 2, text: "Welcome to the show" },
  { start: 2, end: 4, text: "Let's learn translation" },
];

function fakeSource(cues = CUES): SubtitleSource {
  return {
    track: TRACK,
    load: async () => cues,
    dispose: vi.fn(),
  };
}

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  Object.defineProperty(v, "paused", { value: true, configurable: true });
  Object.defineProperty(v, "currentTime", { value: 0, writable: true, configurable: true });
  return v;
}

class FakePort {
  public sent: any[] = [];
  public requests: any[] = [];
  private handlers = new Map<string, (res: any) => void>();

  public onStatus(): () => void {
    return () => {};
  }

  public send(msg: any): void {
    this.sent.push(msg);
  }

  public request<T = any>(msg: any): Promise<T> {
    this.requests.push(msg);
    return new Promise<T>((resolve) => {
      this.handlers.set(msg.reqId, resolve);
    });
  }

  public respond(reqId: string, res: any): void {
    const h = this.handlers.get(reqId);
    if (h) {
      this.handlers.delete(reqId);
      h(res);
    }
  }

  public cancel = vi.fn();
}

describe("computeSourceHash & applyLinesToItems", () => {
  it("computeSourceHash sinh hash ổn định từ text của các cue", () => {
    const hash1 = computeSourceHash(CUES);
    const hash2 = computeSourceHash([...CUES]);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(8);
  });

  it("applyLinesToItems: mode google ưu tiên api rồi tới cloud", () => {
    const items: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 0,
        end_sec: 1,
        source_text: "Hi",
        target_text: "",
        translated: false,
        engine: null,
        ignored: false,
      },
    ];

    const lines = {
      api: ["Chào"],
      "cloud:gemini-3.5-flash-lite": ["Xin chào"],
    };

    const out = applyLinesToItems(items, lines, "google");
    expect(out[0].target_text).toBe("Chào");
    expect(out[0].engine).toBe("api");
    expect(items[0].target_text).toBe(""); // không sửa mảng gốc
  });

  it("applyLinesToItems: mode gemini/hybrid ưu tiên cloud:${model} rồi tới api", () => {
    const items: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 0,
        end_sec: 1,
        source_text: "Hi",
        target_text: "",
        translated: false,
        engine: null,
        ignored: false,
      },
    ];

    const lines = {
      api: ["Chào"],
      "cloud:gemini-3.5-flash-lite": ["Xin chào"],
    };

    const out = applyLinesToItems(items, lines, "gemini", "gemini-3.5-flash-lite");
    expect(out[0].target_text).toBe("Xin chào");
    expect(out[0].engine).toBe("cloud");
  });
});

describe("Session Translation & Caching Integration", () => {
  let fakePort: FakePort;

  beforeEach(() => {
    vi.useFakeTimers();
    fakePort = new FakePort();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Cache Hit: nạp bản dịch đã lưu từ IndexedDB khi khởi động", async () => {
    const v = makeVideo();
    const store = new OverlayStore();
    const session = new Session(v, fakeSource(), store, null, {
      port: fakePort as unknown as BackgroundPort,
      settings: structuredClone(DEFAULT_SETTINGS),
    });

    const startPromise = session.start();
    await Promise.resolve();

    // Session gửi request cache.load
    expect(fakePort.requests.length).toBe(1);
    const loadReq = fakePort.requests[0];
    expect(loadReq.type).toBe("cache.load");

    // Giả lập cache HIT với bản dịch có sẵn
    fakePort.respond(loadReq.reqId, {
      type: "cache.loaded",
      reqId: loadReq.reqId,
      hit: true,
      lines: {
        api: ["Chào mừng đến buổi biểu diễn", "Cùng học dịch thuật nhé"],
      },
    });

    await startPromise;

    const items = session.getItems();
    expect(items[0].translated).toBe(true);
    expect(items[0].target_text).toBe("Chào mừng đến buổi biểu diễn");
    expect(items[0].engine).toBe("api");

    // Khi playhead ở mốc 0.5s -> store hiển thị bản dịch tiếng Việt
    (v as any).currentTime = 0.5;
    v.dispatchEvent(new Event("seeked"));
    expect(store.getState().item?.target_text).toBe("Chào mừng đến buổi biểu diễn");

    session.dispose();
  });

  it("Cache Miss: lưu track mới, dịch qua Scheduler và debounce 2s lưu cache", async () => {
    const v = makeVideo();
    const store = new OverlayStore();
    const session = new Session(v, fakeSource(), store, null, {
      port: fakePort as unknown as BackgroundPort,
      settings: structuredClone(DEFAULT_SETTINGS),
    });

    const startPromise = session.start();
    await Promise.resolve();

    // Cache Miss
    const loadReq = fakePort.requests[0];
    fakePort.respond(loadReq.reqId, {
      type: "cache.loaded",
      reqId: loadReq.reqId,
      hit: false,
    });

    await startPromise;

    // Phải gửi cache.saveTrack
    const saveTrackMsg = fakePort.sent.find((m) => m.type === "cache.saveTrack");
    expect(saveTrackMsg).toBeDefined();

    // Scheduler được kích hoạt -> gửi request translate
    const transReq = fakePort.requests.find((m) => m.type === "translate");
    expect(transReq).toBeDefined();

    // Trả lời kết quả dịch
    fakePort.respond(transReq.reqId, {
      type: "translate.result",
      reqId: transReq.reqId,
      results: [
        { text: "Bản dịch câu 1", engine: "api" },
        { text: "Bản dịch câu 2", engine: "api" },
      ],
    });

    await Promise.resolve();

    // Kiểm tra items đã được cập nhật bản dịch
    expect(session.getItems()[0].target_text).toBe("Bản dịch câu 1");

    // Chưa flush saveLines ngay (debounce 2s)
    let saveLinesMsg = fakePort.sent.find((m) => m.type === "cache.saveLines");
    expect(saveLinesMsg).toBeUndefined();

    // Chờ 2s debounce
    vi.advanceTimersByTime(2100);

    // Đã gửi cache.saveLines
    saveLinesMsg = fakePort.sent.find((m) => m.type === "cache.saveLines");
    expect(saveLinesMsg).toBeDefined();
    expect(saveLinesMsg.engineKey).toBe("api");
    expect(saveLinesMsg.updates).toEqual([
      [0, "Bản dịch câu 1"],
      [1, "Bản dịch câu 2"],
    ]);

    session.dispose();
  });

  it("Dispose: flush ngay buffer còn lại và hủy request dịch đang bay", async () => {
    const v = makeVideo();
    const store = new OverlayStore();
    const session = new Session(v, fakeSource(), store, null, {
      port: fakePort as unknown as BackgroundPort,
      settings: structuredClone(DEFAULT_SETTINGS),
    });

    const startPromise = session.start();
    await Promise.resolve();

    const loadReq = fakePort.requests[0];
    fakePort.respond(loadReq.reqId, {
      type: "cache.loaded",
      reqId: loadReq.reqId,
      hit: false,
    });
    await startPromise;

    // Đang có 1 request dịch bay đi
    const transReq = fakePort.requests.find((m) => m.type === "translate");
    expect(transReq).toBeDefined();

    // Hủy session ngay trong khi request đang bay
    session.dispose();

    // Request translate đang bay phải bị hủy
    expect(fakePort.cancel).toHaveBeenCalledWith(transReq.reqId);
  });
});
