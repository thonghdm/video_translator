/**
 * Test hồi quy cho các lỗi phát hiện khi review Phase 6 (scheduler + session).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Scheduler, normalizeSrcLang, MAX_RETRIES } from "../src/content/scheduler";
import { Session } from "../src/content/pipeline/session";
import { OverlayStore } from "../src/content/overlay/store";
import type { SubtitleItem, Cue, TrackRef } from "../src/shared/types";
import type { BackgroundPort } from "../src/content/port";
import type { SubtitleSource } from "../src/content/adapters/types";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

afterEach(() => vi.useRealTimers());

const mk = (n: number, translated = false, engine: SubtitleItem["engine"] = null): SubtitleItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i, block: 0, start_sec: i * 3, end_sec: i * 3 + 3, source_text: `Line ${i}`,
    target_text: translated ? `Dòng ${i}` : "", translated, engine, ignored: false,
  }));

class FakePort {
  sent: any[] = [];
  sends: any[] = [];
  cancelled: string[] = [];
  private h = new Map<string, (r: any) => void>();
  private s = new Set<(x: any) => void>();
  onStatus(cb: (x: any) => void) { this.s.add(cb); return () => this.s.delete(cb); }
  emit(api: boolean, cloud: boolean, geminiReady = true) {
    const b = (x: boolean) => ({ blocked: x, until: x ? Date.now() + 60_000 : 0 });
    for (const c of this.s) c({ type: "status", breakers: { api: b(api), cloud: b(cloud) }, geminiReady });
  }
  request(m: any) { this.sent.push(m); return new Promise((r) => this.h.set(m.reqId, r)); }
  respond(i: number, results: any[], error?: any) {
    const m = this.sent[i];
    this.h.get(m.reqId)?.({ type: "translate.result", reqId: m.reqId, results, error });
    this.h.delete(m.reqId);
  }
  send(m: any) { this.sends.push(m); }
  cancel(id: string) { this.cancelled.push(id); }
}

function sched(port: FakePort, mode: any, get: () => SubtitleItem[], set: (u: SubtitleItem[]) => void, extra = {}) {
  return new Scheduler({ trackKey: "k", srcLang: "en", mode, port: port as unknown as BackgroundPort,
    getItems: get, onItemsUpdated: set, ...extra });
}

describe("P1 — upgrade dùng priority 'upgrade' và không lặp vô hạn", () => {
  it("gửi priority 'upgrade', không prefer; Gemini trả lại GTX → mỗi dòng tối đa 2 lần thử", async () => {
    let items = mk(2, true, "api");
    const port = new FakePort();
    const s = sched(port, "hybrid", () => items, (u) => (items = u));
    s.plan(0);
    expect(port.sent[0]).toMatchObject({ priority: "upgrade" });
    expect(port.sent[0].prefer).toBeUndefined();
    port.respond(0, [{ text: "x", engine: "api" }, { text: "", engine: null }]);
    await Promise.resolve();
    s.plan(0);
    expect(port.sent).toHaveLength(2);
    port.respond(1, [{ text: "x", engine: "api" }, { text: "", engine: null }]);
    await Promise.resolve();
    for (let k = 0; k < 10; k++) s.plan(0);
    expect(port.sent).toHaveLength(2); // hết lượt, không gửi nữa
  });

  it("upgrade thành công → dòng đổi sang engine cloud và được lưu theo cloud:<model>", async () => {
    let items = mk(1, true, "api");
    const port = new FakePort();
    const saved: any[] = [];
    const s = sched(port, "hybrid", () => items, (u) => (items = u), {
      geminiModel: "m1",
      onLinesTranslated: (k: string, u: any) => saved.push([k, u]),
    });
    s.plan(0);
    port.respond(0, [{ text: "Bản Gemini", engine: "cloud" }]);
    await Promise.resolve();
    expect(items[0]).toMatchObject({ engine: "cloud", target_text: "Bản Gemini" });
    expect(saved).toEqual([["cloud:m1", [[0, "Bản Gemini"]]]]);
  });

  it("không upgrade khi vẫn còn dòng chưa dịch (dịch thường trước)", () => {
    const items = [...mk(1, true, "api"), ...mk(2).slice(1)];
    const port = new FakePort();
    const s = sched(port, "hybrid", () => items, () => {});
    s.plan(0);
    expect(port.sent.every((m) => m.priority !== "upgrade")).toBe(true);
  });

  it("thiếu key (disabled) → ngừng upgrade", async () => {
    const items = mk(1, true, "api");
    const port = new FakePort();
    const s = sched(port, "hybrid", () => items, () => {});
    s.plan(0);
    port.respond(0, [{ text: "", engine: null }], { kind: "disabled", message: "no key" });
    await Promise.resolve();
    s.plan(0);
    expect(port.sent).toHaveLength(1);
  });
});

describe("P2 — breaker cloud khóa KHÔNG làm dừng GTX ở mode google", () => {
  it("vẫn gửi batch dịch thường", () => {
    const items = mk(3);
    const port = new FakePort();
    const s = sched(port, "google", () => items, () => {});
    port.emit(false, true);
    s.plan(0);
    expect(port.sent.length).toBeGreaterThan(0);
    expect(s.paused).toBe(false);
  });
});

describe("P3 — lỗi tạm thời không đốt lượt retry", () => {
  it("mất mạng nhiều lần rồi có lại → vẫn dịch tiếp", async () => {
    vi.useFakeTimers();
    let items = mk(1);
    const port = new FakePort();
    const s = sched(port, "google", () => items, (u) => (items = u));
    for (let k = 0; k < 5; k++) {
      s.plan(0);
      port.respond(port.sent.length - 1, [{ text: "", engine: null }], { kind: "network", message: "offline" });
      await vi.advanceTimersByTimeAsync(5_100); // hết tạm nghỉ → tự lập lại lịch
    }
    const before = port.sent.length;
    s.plan(0);
    expect(port.sent.length).toBeGreaterThanOrEqual(before);
    port.respond(port.sent.length - 1, [{ text: "Xin chào", engine: "api" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(items[0].translated).toBe(true);
    s.dispose();
  });

  it("blocked → tạm nghỉ đúng retryAfterMs rồi TỰ chạy lại (không cần seek/tick)", async () => {
    vi.useFakeTimers();
    let items = mk(1);
    const port = new FakePort();
    const msgs: Array<string | null> = [];
    const s = sched(port, "google", () => items, (u) => (items = u), { onStatusMessage: (m: string | null) => msgs.push(m) });
    s.plan(0);
    port.respond(0, [{ text: "", engine: null }], { kind: "blocked", message: "429", retryAfterMs: 4_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.paused).toBe(true);
    expect(msgs.some((m) => m?.includes("00:04"))).toBe(true);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.paused).toBe(false);
    expect(port.sent).toHaveLength(2);
    expect(msgs[msgs.length - 1]).toBeNull();
    s.dispose();
  });

  it("dòng rỗng KHÔNG kèm lỗi (hoặc lỗi other) → tối đa 3 lượt", async () => {
    const items = mk(1);
    const port = new FakePort();
    const s = sched(port, "google", () => items, () => {});
    for (let k = 0; k < MAX_RETRIES + 2; k++) {
      s.plan(0);
      if (port.sent.length > k) port.respond(k, [{ text: "", engine: null }], k % 2 ? { kind: "other", message: "x" } : undefined);
      await Promise.resolve();
    }
    expect(port.sent).toHaveLength(MAX_RETRIES);
  });
});

describe("P4/P6 — upgrade không phụ thuộc geminiReady; mode gemini cũng nâng dòng GTX", () => {
  it("geminiReady=false (bucket tạm cạn) vẫn upgrade", () => {
    const port = new FakePort();
    const s = sched(port, "hybrid", () => mk(1, true, "api"), () => {});
    port.emit(false, false, false);
    s.plan(0);
    expect(port.sent[0]?.priority).toBe("upgrade");
  });

  it("mode gemini: dòng đã rơi về GTX được thử lại bằng Gemini", () => {
    const port = new FakePort();
    const s = sched(port, "gemini", () => mk(1, true, "api"), () => {});
    s.plan(0);
    expect(port.sent[0]?.priority).toBe("upgrade");
  });

  it("mode google: KHÔNG upgrade", () => {
    const port = new FakePort();
    const s = sched(port, "google", () => mk(1, true, "api"), () => {});
    s.plan(0);
    expect(port.sent).toHaveLength(0);
  });
});

describe("P7 — srcLang", () => {
  it("'und'/rỗng → 'auto'", () => {
    expect(normalizeSrcLang("und")).toBe("auto");
    expect(normalizeSrcLang("")).toBe("auto");
    expect(normalizeSrcLang("en-US")).toBe("en-US");
    const port = new FakePort();
    new Scheduler({ trackKey: "k", srcLang: "und", mode: "google", port: port as unknown as BackgroundPort, getItems: () => mk(1), onItemsUpdated: () => {} }).plan(0);
    expect(port.sent[0].srcLang).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
const TRACK: TrackRef = { trackKey: "web:t", platform: "web", videoId: "v", title: "t", lang: "en", kind: "html5" };

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  Object.defineProperty(v, "paused", { value: true, configurable: true });
  Object.defineProperty(v, "currentTime", { value: 0, writable: true, configurable: true });
  document.body.appendChild(v);
  return v;
}

describe("Session — đổi mode cập nhật overlay, cue đổi không gắn bản dịch sai câu", () => {
  it("đổi google → gemini: dòng đang hiện đổi sang bản Gemini (object mới để store nhận ra)", async () => {
    const port = new FakePort();
    const cues: Cue[] = [{ start: 0, end: 5, text: "Hello" }];
    const src: SubtitleSource = { track: TRACK, load: async () => cues, dispose() {} };
    const store = new OverlayStore();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const s = new Session(makeVideo(), src, store, null, { port: port as unknown as BackgroundPort, settings });
    const started = s.start();
    await Promise.resolve();
    // cache.load trả về cả bản api và cloud
    const m = port.sent[0];
    (port as any).h.get(m.reqId)({ type: "cache.loaded", reqId: m.reqId, hit: true, cues,
      lines: { api: ["Chào (GTX)"], [`cloud:${settings.gemini.model}`]: ["Xin chào (Gemini)"] } });
    await started;
    expect(store.getState().item?.target_text).toBe("Chào (GTX)");
    s.onSettingsChanged({ ...settings, mode: "gemini" });
    expect(store.getState().item?.target_text).toBe("Xin chào (Gemini)");
    expect(store.getState().item?.engine).toBe("cloud");
    s.dispose();
  });

  it("track nạp lại cue khác nội dung → bỏ bản dịch cũ của câu đã đổi, lưu track theo hash mới", async () => {
    const port = new FakePort();
    let emit!: (c: Cue[]) => void;
    const cues1: Cue[] = [{ start: 0, end: 2, text: "A" }, { start: 2, end: 4, text: "B" }];
    const src: SubtitleSource = {
      track: TRACK, load: async () => cues1, dispose() {},
      onCuesChanged: (cb) => { emit = cb; return () => {}; },
    };
    const store = new OverlayStore();
    const s = new Session(makeVideo(), src, store, null, { port: port as unknown as BackgroundPort, settings: structuredClone(DEFAULT_SETTINGS) });
    const started = s.start();
    await Promise.resolve();
    const m = port.sent[0];
    (port as any).h.get(m.reqId)({ type: "cache.loaded", reqId: m.reqId, hit: true, cues: cues1, lines: { api: ["Dịch A", "Dịch B"] } });
    await started;
    port.sends.length = 0;
    emit([{ start: 0, end: 2, text: "A" }, { start: 2, end: 4, text: "B đã sửa" }, { start: 4, end: 6, text: "C" }]);
    const items = s.getItems();
    expect(items[0].target_text).toBe("Dịch A"); // câu không đổi: giữ
    expect(items[1].translated).toBe(false); // câu đã đổi: KHÔNG gắn bản dịch cũ
    expect(port.sends.find((x) => x.type === "cache.saveTrack")).toBeTruthy();
    s.dispose(); // flush
    const saveLines = port.sends.filter((x) => x.type === "cache.saveLines");
    expect(saveLines.length).toBeGreaterThan(0);
    expect(saveLines[0].total).toBe(3);
    expect(saveLines[0].sourceHash).toBe(port.sends.find((x) => x.type === "cache.saveTrack").sourceHash);
  });
});
