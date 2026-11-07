/**
 * Phase 6 — tích hợp đầu-cuối trong jsdom:
 * Session → Scheduler → BackgroundPort ⇄ (cặp port giả) ⇄ MessagingHub → TranslationRouter → GTX (fetch giả)
 *                                                               └→ SubtransDB (fake-indexeddb)
 * Mục tiêu: bắt lỗi LỆCH GIAO THỨC giữa content và background mà unit test từng phía không thấy.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { BackgroundPort, type PortLike } from "../src/content/port";
import { MessagingHub } from "../src/background/messaging";
import { TranslationRouter } from "../src/background/router";
import { GtxQueue } from "../src/background/engines/gtx";
import { GeminiEngine } from "../src/background/engines/gemini";
import { CircuitBreaker } from "../src/shared/breaker";
import { TokenBucket } from "../src/shared/tokenBucket";
import { LRUCache } from "../src/shared/lru";
import { SubtransDB } from "../src/background/cache/db";
import { Session } from "../src/content/pipeline/session";
import { OverlayStore } from "../src/content/overlay/store";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { Cue, TrackRef } from "../src/shared/types";
import type { SubtitleSource } from "../src/content/adapters/types";

type Fn = (...a: unknown[]) => void;

/** Cặp port nối trực tiếp content ⇄ background (bất đồng bộ như Chrome) */
function portPair(): [PortLike, any] {
  const cMsg: Fn[] = [], cDisc: Fn[] = [], bMsg: Fn[] = [], bDisc: Fn[] = [];
  const clone = (m: unknown) => JSON.parse(JSON.stringify(m)); // Chrome serialize message
  const content: PortLike = {
    postMessage: (m) => queueMicrotask(() => bMsg.forEach((f) => f(clone(m)))),
    disconnect: () => bDisc.forEach((f) => f()),
    onMessage: { addListener: (f) => cMsg.push(f as Fn) },
    onDisconnect: { addListener: (f) => cDisc.push(f as Fn) },
  };
  const bg = {
    name: "subtrans",
    postMessage: (m: unknown) => queueMicrotask(() => cMsg.forEach((f) => f(clone(m)))),
    onMessage: { addListener: (f: Fn) => bMsg.push(f) },
    onDisconnect: { addListener: (f: Fn) => bDisc.push(f) },
  };
  return [content, bg];
}

function setupBackground() {
  const onConnect: Fn[] = [];
  (globalThis as any).chrome = {
    runtime: {
      onConnect: { addListener: (f: Fn) => onConnect.push(f) },
      onMessage: { addListener: () => {} },
    },
  };
  const gtxBreaker = new CircuitBreaker();
  const geminiBreaker = new CircuitBreaker();
  const bucket = new TokenBucket(600);
  const engine = new GeminiEngine(
    { apiKey: "", model: "m", endpoint: "https://g/v1beta/models", timeoutTier1Ms: 500, timeoutTier2Ms: 500, maxItemsTier1: 10, maxItemsTier2: 20 },
    geminiBreaker,
    bucket
  );
  const router = new TranslationRouter({ mode: "google", geminiModel: "m" }, new LRUCache(1000), gtxBreaker, new GtxQueue(2, 0), engine);
  const db = new SubtransDB();
  const hub = new MessagingHub(router, gtxBreaker, geminiBreaker, engine, { scheduleSave: () => {} } as any, db, async () => ({ maxTracks: 200, maxAgeDays: 30 }));
  hub.init();
  const connect = () => {
    const [c, b] = portPair();
    onConnect.forEach((f) => f(b));
    return c;
  };
  return { connect, db };
}

const TRACK: TrackRef = { trackKey: "web:e2e:track", platform: "web", videoId: "v", title: "E2E", lang: "en", kind: "html5" };
const CUES: Cue[] = Array.from({ length: 12 }, (_, i) => ({ start: i * 3, end: i * 3 + 2.5, text: `Sentence number ${i}.` }));

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  Object.defineProperty(v, "paused", { value: true, configurable: true });
  Object.defineProperty(v, "currentTime", { value: 0, writable: true, configurable: true });
  document.body.appendChild(v);
  return v;
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout chờ điều kiện");
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).chrome;
});

describe("Phase 6 E2E", () => {
  it("dịch toàn bộ track qua GTX, lưu IndexedDB; mở lại → lấy từ cache, 0 request dịch", async () => {
    let gtxCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      gtxCalls++;
      const q = new URL(String(u)).searchParams.get("q") || "";
      const out = q.split("\n").map((l) => `VI:${l}`).join("\n");
      return new Response(JSON.stringify([out.split("\n").map((t, i, a) => [i < a.length - 1 ? t + "\n" : t, "src"])]), { status: 200 });
    });
    const { connect, db } = setupBackground();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const src = (): SubtitleSource => ({ track: TRACK, load: async () => CUES, dispose() {} });

    // Lần 1: cache miss → dịch hết
    const port1 = new BackgroundPort(connect);
    const store1 = new OverlayStore();
    const s1 = new Session(makeVideo(), src(), store1, null, { port: port1, settings });
    await s1.start();
    await waitFor(() => s1.getItems().every((it) => it.translated));
    expect(s1.getItems()[0]).toMatchObject({ target_text: "VI:Sentence number 0.", engine: "api" });
    expect(store1.getState().item?.target_text).toBe("VI:Sentence number 0.");
    expect(gtxCalls).toBeGreaterThan(0);
    s1.dispose(); // flush saveLines
    await waitFor(() => false, 300).catch(() => {}); // chờ IndexedDB ghi xong

    const lines = await db.getLines(TRACK.trackKey);
    expect(lines.api?.filter(Boolean)).toHaveLength(12);

    // Lần 2: cache hit → hiện ngay, KHÔNG gọi GTX
    gtxCalls = 0;
    const port2 = new BackgroundPort(connect);
    const store2 = new OverlayStore();
    const s2 = new Session(makeVideo(), src(), store2, null, { port: port2, settings });
    await s2.start();
    expect(s2.getItems().every((it) => it.translated)).toBe(true);
    expect(store2.getState().item?.target_text).toBe("VI:Sentence number 0.");
    await new Promise((r) => setTimeout(r, 100));
    expect(gtxCalls).toBe(0);
    s2.dispose();
    port1.dispose();
    port2.dispose();
  });
});
