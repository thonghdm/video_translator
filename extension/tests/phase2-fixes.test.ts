/**
 * Test hồi quy cho các lỗi phát hiện khi review Phase 2, kèm các case port từ
 * translator_mock_test.go và gemini_test.go (bỏ các case liên quan Qwen/local_ai).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { CircuitBreaker } from "../src/shared/breaker";
import { TokenBucket } from "../src/shared/tokenBucket";
import { LRUCache } from "../src/shared/lru";
import { GeminiEngine, type GeminiConfig } from "../src/background/engines/gemini";
import { GtxQueue, googleBatchOrPerLine, translateFastGtx } from "../src/background/engines/gtx";
import { TranslationRouter, planTiers } from "../src/background/router";
import {
  classifyErr,
  errToBreakerOutcome,
  CanceledError,
  NetworkError,
  RateLimitedError,
  LocalRateLimitError,
} from "../src/background/engines/errors";
import type { TranslateMode } from "../src/shared/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const CFG: GeminiConfig = {
  apiKey: "KEY_1234567890",
  model: "gemini-test",
  endpoint: "https://gemini.test/v1beta/models",
  timeoutTier1Ms: 300,
  timeoutTier2Ms: 300,
  maxItemsTier1: 10,
  maxItemsTier2: 20,
};

const isGtx = (u: unknown) => String(u).includes("translate.googleapis.com");
const gtxBody = (text: string) =>
  new Response(JSON.stringify([text.split("\n").map((t, i, a) => [i < a.length - 1 ? t + "\n" : t, "src"])]), {
    status: 200,
  });
const geminiBody = (items: Array<{ id: number; vi: string }>) =>
  new Response(
    JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(items) }] } }],
    }),
    { status: 200 }
  );
/** Gemini mock: dịch mọi id gửi lên thành "VI:<text>" */
const geminiEcho = (init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const prompt: string = body.contents[0].parts[0].text;
  const items = JSON.parse(prompt.slice(prompt.indexOf("[")));
  return geminiBody(items.map((it: { id: number; text: string }) => ({ id: it.id, vi: `VI:${it.text}` })));
};
/** GTX mock: "GTX:<line>" cho từng dòng */
const gtxEcho = (u: unknown) => {
  const q = decodeURIComponent(new URL(String(u)).searchParams.get("q") || "");
  return gtxBody(q.split("\n").map((l) => `GTX:${l}`).join("\n"));
};

function makeRouter(opts: {
  mode?: TranslateMode;
  key?: string;
  gtxBreaker?: CircuitBreaker;
  geminiBreaker?: CircuitBreaker;
  bucket?: TokenBucket;
  cache?: LRUCache<string, string>;
  geminiTimeout?: number;
}) {
  const cache = opts.cache ?? new LRUCache<string, string>(1000);
  const gtxBreaker = opts.gtxBreaker ?? new CircuitBreaker();
  const geminiBreaker = opts.geminiBreaker ?? new CircuitBreaker();
  const bucket = opts.bucket ?? new TokenBucket(600);
  const engine = new GeminiEngine(
    {
      ...CFG,
      apiKey: opts.key ?? CFG.apiKey,
      timeoutTier1Ms: opts.geminiTimeout ?? CFG.timeoutTier1Ms,
      timeoutTier2Ms: opts.geminiTimeout ?? CFG.timeoutTier2Ms,
    },
    geminiBreaker,
    bucket
  );
  const router = new TranslationRouter(
    { mode: opts.mode ?? "google", geminiModel: CFG.model },
    cache,
    gtxBreaker,
    new GtxQueue(2, 0),
    engine
  );
  return { router, cache, gtxBreaker, geminiBreaker, bucket, engine };
}

// ---------------------------------------------------------------------------
describe("Lỗi 1 — Gemini kiểm tra kết quả acquire, lấy token TRƯỚC breaker", () => {
  it("bucket cạn → KHÔNG gọi HTTP, ném LocalRateLimitError, không phạt breaker", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, i) => geminiEcho(i));
    const bucket = new TokenBucket(12);
    bucket.restore({ tokens: 0, lastRefillMs: Date.now() });
    const br = new CircuitBreaker();
    const eng = new GeminiEngine({ ...CFG, timeoutTier1Ms: 100 }, br, bucket);
    await expect(eng.translateLines(["hi"], [], true)).rejects.toBeInstanceOf(LocalRateLimitError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(br.blocked()).toBe(false);
    expect(br.getFails()).toBe(0);
  });

  it("bị hủy khi đang chờ token → CanceledError, và KHÔNG giữ cờ probe half-open", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, i) => geminiEcho(i));
    const br = new CircuitBreaker();
    br.restore({ blockedUntil: Date.now() - 10, fails: 0, backoffStep: 1 }); // half-open
    const bucket = new TokenBucket(12);
    bucket.restore({ tokens: 0, lastRefillMs: Date.now() });
    const eng = new GeminiEngine({ ...CFG, timeoutTier1Ms: 5000 }, br, bucket);
    const c = new AbortController();
    setTimeout(() => c.abort(), 30);
    await expect(eng.translateLines(["hi"], [], true, c.signal)).rejects.toBeInstanceOf(CanceledError);
    expect(br.isProbing()).toBe(false);
    expect(br.allow()).toEqual({ allowed: true, isProbe: true }); // lượt probe vẫn còn nguyên
  });

  it("port gemini_test: TokenBucketExhausted_ReturnsLocalRateLimit_NoHTTP_NoBreakerPenalty (qua router mode gemini → GTX bù)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u, i) => (isGtx(u) ? gtxEcho(u) : geminiEcho(i)));
    const bucket = new TokenBucket(12);
    bucket.restore({ tokens: 0, lastRefillMs: Date.now() });
    const { router, geminiBreaker } = makeRouter({ mode: "gemini", bucket, geminiTimeout: 80 });
    const out = await router.translate({ lines: ["Hello"], priority: "tier1" });
    expect(out.results[0]).toEqual({ text: "GTX:Hello", engine: "api" });
    expect(fetchSpy.mock.calls.every((c) => isGtx(c[0]))).toBe(true);
    expect(geminiBreaker.getFails()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("Lỗi 2 — GtxQueue giới hạn đồng thời thật sự", () => {
  it("burst 8 job, concurrency 2 → tối đa 2 chạy cùng lúc", async () => {
    const q = new GtxQueue(2, 20);
    let active = 0;
    let peak = 0;
    const job = () =>
      q.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 40));
        active--;
      }, false);
    await Promise.all(Array.from({ length: 8 }, job));
    expect(peak).toBe(2);
    expect(q.activeCount).toBe(0);
  });

  it("giãn cách gapMs giữa 2 lần bắt đầu", async () => {
    const q = new GtxQueue(4, 50);
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 3 }, () => q.run(async () => void starts.push(Date.now()), false))
    );
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(45);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(45);
  });

  it("Tier-1 đến sau vẫn chạy trước các Tier-2 đang xếp hàng", async () => {
    const q = new GtxQueue(1, 0);
    const order: string[] = [];
    const slow = (name: string) => async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, 10));
    };
    const ps = [q.run(slow("t2-a"), false), q.run(slow("t2-b"), false), q.run(slow("t2-c"), false)];
    ps.push(q.run(slow("t1"), true));
    await Promise.all(ps);
    expect(order[0]).toBe("t2-a"); // đã chạy trước khi t1 tới
    expect(order[1]).toBe("t1");
  });

  it("task bị abort khi còn trong hàng đợi → bị loại ngay, không chạy", async () => {
    const q = new GtxQueue(1, 0);
    const ran = vi.fn();
    const c = new AbortController();
    const first = q.run(() => new Promise((r) => setTimeout(r, 50)), false);
    const second = q.run(async () => ran(), false, c.signal);
    c.abort();
    await expect(second).rejects.toBeInstanceOf(CanceledError);
    await first;
    expect(ran).not.toHaveBeenCalled();
    expect(q.queuedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("Lỗi 3 — Hybrid upgrade không bị cache GTX chặn", () => {
  it("dòng đã có bản GTX trong cache → upgrade vẫn gọi Gemini và trả engine cloud", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u, i) => (isGtx(u) ? gtxEcho(u) : geminiEcho(i)));
    const cache = new LRUCache<string, string>(100);
    cache.set("api|Hello", "Xin chào (GTX)");
    const { router } = makeRouter({ mode: "hybrid", cache });
    const out = await router.translate({ lines: ["Hello"], priority: "upgrade" });
    expect(out.results[0]).toEqual({ text: "VI:Hello", engine: "cloud" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cache.get("cloud|Hello")).toBe("VI:Hello");
  });

  it("upgrade lần 2 trúng cache cloud, không gọi HTTP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const cache = new LRUCache<string, string>(100);
    cache.set("cloud|Hello", "Xin chào (Gemini)");
    const { router } = makeRouter({ mode: "hybrid", cache });
    const out = await router.translate({ lines: ["Hello"], priority: "upgrade" });
    expect(out.results[0]).toEqual({ text: "Xin chào (Gemini)", engine: "cloud" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("upgrade khi chưa có key → lỗi disabled, không gọi gì", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { router } = makeRouter({ mode: "hybrid", key: "" });
    const out = await router.translate({ lines: ["Hello"], priority: "upgrade" });
    expect(out.error?.kind).toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("planTiers: bảng thứ tự tầng theo mode/priority", () => {
    const ids = (m: TranslateMode, p: "tier1" | "tier2" | "upgrade", k = true) => planTiers(m, p, k).map((t) => t.id);
    expect(ids("google", "tier1")).toEqual(["api", "cloud"]);
    expect(ids("google", "tier2", false)).toEqual(["api"]);
    expect(ids("gemini", "tier1")).toEqual(["cloud", "api"]);
    expect(ids("gemini", "tier2", false)).toEqual(["api"]);
    expect(ids("hybrid", "tier1")).toEqual(["api", "cloud"]);
    expect(ids("hybrid", "tier2")).toEqual(["cloud", "api"]);
    expect(ids("hybrid", "upgrade")).toEqual(["cloud"]);
    expect(ids("hybrid", "upgrade", false)).toEqual([]);
    expect(planTiers("google", "tier1", true, "cloud").map((t) => t.id)).toEqual(["cloud", "api"]);
  });
});

// ---------------------------------------------------------------------------
describe("Lỗi 5 — classifyErr chỉ dùng instanceof", () => {
  it("không dò chuỗi message; TypeError do bug không phải network", () => {
    let bug: unknown;
    try {
      (undefined as unknown as { x: number }).x;
    } catch (e) {
      bug = e;
    }
    expect(classifyErr(bug)).toBe("other");
    expect(classifyErr(new Error("Gemini HTTP 400: request aborted by safety"))).toBe("other");
    expect(classifyErr(new Error("Gemini HTTP 400: token 14290 exceeds"))).toBe("other");
    expect(classifyErr(new Error("operation canceled"))).toBe("other");
    expect(classifyErr(new CanceledError())).toBe("canceled");
    expect(classifyErr(new NetworkError())).toBe("network");
    expect(classifyErr(new RateLimitedError())).toBe("blocked");
    expect(classifyErr(new LocalRateLimitError())).toBe("blocked");
  });

  it("errToBreakerOutcome: LocalRateLimit không bao giờ thành 'blocked' cho breaker", () => {
    expect(errToBreakerOutcome(new RateLimitedError("x", 5000))).toEqual({ kind: "blocked", retryAfterMs: 5000 });
    expect(errToBreakerOutcome(new LocalRateLimitError())).toEqual({ kind: "other" });
  });

  it("fetch ném TypeError (mất mạng) → GTX đổi thành NetworkError tại chỗ gọi", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(translateFastGtx("hi", "en")).rejects.toBeInstanceOf(NetworkError);
  });

  it("bug khi parse response GTX KHÔNG làm router bỏ qua Gemini", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, i) =>
      isGtx(u) ? new Response(JSON.stringify({ unexpected: true }), { status: 200 }) : geminiEcho(i)
    );
    const { router } = makeRouter({ mode: "google" });
    const out = await router.translate({ lines: ["Hello"], priority: "tier1" });
    expect(out.results[0].engine).toBe("cloud");
  });
});

// ---------------------------------------------------------------------------
describe("Lỗi 6 — mode gemini không lặng lẽ rơi về GTX khi bucket tạm cạn", () => {
  it("bucket còn 0.5 token → chờ token rồi dịch bằng Gemini", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u, i) => (isGtx(u) ? gtxEcho(u) : geminiEcho(i)));
    const bucket = new TokenBucket(600); // 10 token/giây
    bucket.restore({ tokens: 0.5, lastRefillMs: Date.now() });
    const { router } = makeRouter({ mode: "gemini", bucket, geminiTimeout: 2000 });
    const out = await router.translate({ lines: ["Hello"], priority: "tier1" });
    expect(out.results[0]).toEqual({ text: "VI:Hello", engine: "cloud" });
    expect(fetchSpy.mock.calls.some((c) => isGtx(c[0]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("Lỗi 7 — breaker GTX khóa thì router trả lỗi blocked kèm retryAfterMs", () => {
  it("mode google, chưa có key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const br = new CircuitBreaker();
    br.report({ kind: "blocked" }, false); // khóa 1 phút
    const { router } = makeRouter({ mode: "google", key: "", gtxBreaker: br });
    const out = await router.translate({ lines: ["Hello"], priority: "tier1" });
    expect(out.error?.kind).toBe("blocked");
    expect(out.error?.retryAfterMs).toBeGreaterThan(55_000);
    expect(out.error?.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("port translator_mock_test: BothGTXAndGeminiBlocked → lỗi blocked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const g = new CircuitBreaker();
    g.report({ kind: "blocked" }, false);
    const c = new CircuitBreaker();
    c.report({ kind: "blocked" }, false);
    const { router } = makeRouter({ mode: "google", gtxBreaker: g, geminiBreaker: c });
    const out = await router.translate({ lines: ["Hello"], priority: "tier1" });
    expect(out.error?.kind).toBe("blocked");
    expect(out.results[0].text).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("Lỗi 8 — batch GTX lỗi thì trả về ngay (chỉ lệch dòng mới dịch từng dòng)", () => {
  it("batch HTTP 500 → đúng 1 request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 500 }));
    await expect(googleBatchOrPerLine(["a", "b", "c", "d"], "en")).rejects.toThrow(/HTTP 500/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("port HtmlCaptchaDetection: body HTML (captcha) → RateLimitedError, 1 request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>unusual traffic</html>", { status: 200 })
    );
    await expect(googleBatchOrPerLine(["a", "b"], "en")).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("port MismatchFallback_KeepsPartialProgressOnError: dòng đã dịch được lưu cache dù dòng sau lỗi", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      n++;
      const q = new URL(String(u)).searchParams.get("q") || "";
      if (q.includes("\n")) return gtxBody("chỉ một dòng"); // batch lệch dòng
      if (q === "b") return new Response("x", { status: 429 });
      return gtxBody(`GTX:${q}`);
    });
    const cache = new LRUCache<string, string>(100);
    await expect(googleBatchOrPerLine(["a", "b", "c"], "en", undefined, cache)).rejects.toBeInstanceOf(RateLimitedError);
    expect(cache.get("api|a")).toBe("GTX:a");
    expect(cache.get("api|c")).toBeUndefined();
    expect(n).toBe(3); // batch + a + b
  });

  it("port MismatchFallback_UsesCache: dòng có cache không tốn HTTP", async () => {
    let perLine = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      const q = new URL(String(u)).searchParams.get("q") || "";
      if (q.includes("\n")) return gtxBody("lệch");
      perLine++;
      return gtxBody(`GTX:${q}`);
    });
    const cache = new LRUCache<string, string>(100);
    cache.set("api|a", "CACHED-a");
    const out = await googleBatchOrPerLine(["a", "b"], "en", undefined, cache);
    expect(out).toEqual(["CACHED-a", "GTX:b"]);
    expect(perLine).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("Port translator_mock_test.go — quy tắc chuyển tầng", () => {
  it("GTX429_GeminiSuccess_CachedAndModeCloud", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, i) =>
      isGtx(u) ? new Response("", { status: 429 }) : geminiEcho(i)
    );
    const { router, cache, gtxBreaker } = makeRouter({ mode: "google" });
    const out = await router.translate({ lines: ["Hello", "World"], priority: "tier1" });
    expect(out.results.map((r) => r.engine)).toEqual(["cloud", "cloud"]);
    expect(cache.get("cloud|Hello")).toBe("VI:Hello");
    expect(gtxBreaker.blocked()).toBe(true);
  });

  it("GTXNetworkError_BypassesGemini", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      if (isGtx(u)) throw new TypeError("Failed to fetch");
      return geminiBody([]);
    });
    const { router } = makeRouter({ mode: "google" });
    const out = await router.translate({ lines: ["Hello"], priority: "tier1" });
    expect(out.error?.kind).toBe("network");
    expect(fetchSpy.mock.calls.some((c) => !isGtx(c[0]))).toBe(false);
  });

  it("GeminiMissingLines_Filled (mode gemini): Gemini thiếu dòng → GTX bù đúng dòng thiếu", async () => {
    const gtxCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      if (isGtx(u)) {
        gtxCalls.push(new URL(String(u)).searchParams.get("q") || "");
        return gtxEcho(u);
      }
      return geminiBody([{ id: 0, vi: "VI:A" }]); // thiếu id 1, cả lúc retry
    });
    const { router } = makeRouter({ mode: "gemini" });
    const out = await router.translate({ lines: ["A", "B"], priority: "tier1" });
    expect(out.results).toEqual([
      { text: "VI:A", engine: "cloud" },
      { text: "GTX:B", engine: "api" },
    ]);
    expect(gtxCalls).toEqual(["B"]);
  });

  it("GoogleEmptyLine_NeverWakesNextTier: GTX thành công (fillGaps=false) thì không gọi Gemini", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => gtxEcho(u));
    const { router } = makeRouter({ mode: "google" });
    await router.translate({ lines: ["A", "B"], priority: "tier2" });
    expect(fetchSpy.mock.calls.every((c) => isGtx(c[0]))).toBe(true);
  });

  it("ContextCanceledAfterTier1Error_Tier2NotCalled", async () => {
    const c = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      if (isGtx(u)) {
        c.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return geminiBody([]);
    });
    const { router } = makeRouter({ mode: "google" });
    await expect(router.translate({ lines: ["A"], priority: "tier1", signal: c.signal })).rejects.toBeInstanceOf(CanceledError);
    expect(fetchSpy.mock.calls.some((call) => !isGtx(call[0]))).toBe(false);
  });

  it("AllTiersFail_ReturnsError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("err", { status: 500 }));
    const { router } = makeRouter({ mode: "google" });
    const out = await router.translate({ lines: ["A"], priority: "tier1" });
    expect(out.error).toBeDefined();
    expect(out.error?.message).not.toContain(CFG.apiKey);
  });
});
