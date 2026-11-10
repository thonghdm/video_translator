import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranslationRouter } from "../src/background/router";
import { LRUCache } from "../src/shared/lru";
import { CircuitBreaker } from "../src/shared/breaker";
import { GtxQueue } from "../src/background/engines/gtx";
import { GeminiEngine } from "../src/background/engines/gemini";
import { DeepLEngine } from "../src/background/engines/deepl";
import { TokenBucket } from "../src/shared/tokenBucket";
import {
  CanceledError,
  DisabledError,
  RateLimitedError,
  DeepLQuotaError,
} from "../src/background/engines/errors";

describe("Phase 12 G3 — Router DeepL Fallback Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  interface RouterSetupOptions {
    mode?: "google" | "gemini" | "hybrid";
    deeplApiKey?: string;
    deeplEnabled?: boolean;
    deeplPrefer?: boolean;
  }

  function setupRouter(opts: RouterSetupOptions = {}) {
    const {
      mode = "google",
      deeplApiKey = "mock-key:fx",
      deeplEnabled = true,
      deeplPrefer = false,
    } = opts;

    const phraseCache = new LRUCache<string, string>(100);
    const gtxBreaker = new CircuitBreaker();
    const gtxQueue = new GtxQueue(2, 0);

    const deeplBreaker = new CircuitBreaker();
    const deeplQueue = new GtxQueue(1, 0);
    const deeplEngine = new DeepLEngine({ apiKey: deeplApiKey });

    let prefs = { enabled: deeplEnabled, prefer: deeplPrefer };

    const geminiBreaker = new CircuitBreaker();
    const geminiBucket = new TokenBucket(12);
    const geminiEngine = new GeminiEngine(
      {
        apiKey: "gemini_key",
        model: "gemini-3.5-flash-lite",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
        timeoutTier1Ms: 3500,
        timeoutTier2Ms: 8000,
        maxItemsTier1: 10,
        maxItemsTier2: 20,
      },
      geminiBreaker,
      geminiBucket
    );

    const router = new TranslationRouter(
      { mode, geminiModel: "gemini-3.5-flash-lite" },
      phraseCache,
      gtxBreaker,
      gtxQueue,
      geminiEngine,
      {
        engine: deeplEngine,
        breaker: deeplBreaker,
        queue: deeplQueue,
        getPrefs: () => prefs,
      }
    );

    return {
      router,
      phraseCache,
      gtxBreaker,
      gtxQueue,
      deeplBreaker,
      deeplQueue,
      deeplEngine,
      geminiEngine,
      setPrefs: (newPrefs: { enabled: boolean; prefer: boolean }) => {
        prefs = newPrefs;
      },
    };
  }

  // Case 1: Không key DeepL: GTX 429 → lỗi blocked như cũ, DeepL không được gọi
  it("1. Không key DeepL: GTX 429 → lỗi blocked y như trước, DeepL không được gọi", async () => {
    const { router, deeplEngine } = setupRouter({ deeplApiKey: "" });
    const deeplSpy = vi.spyOn(deeplEngine, "translateLines");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too Many Requests", { status: 429 }))
    );

    // Không có Gemini key để tier chỉ có api
    vi.spyOn((router as any).geminiEngine, "hasKey").mockReturnValue(false);

    const { results, error } = await router.translate({
      lines: ["Hello world"],
      priority: "tier1",
    });

    expect(deeplSpy).not.toHaveBeenCalled();
    expect(results[0].text).toBe("");
    expect(error?.kind).toBe("blocked");
  });

  // Case 2: Có key: GTX 429 → DeepL dịch → kết quả engine: "api", không lỗi
  it("2. Có key: GTX 429 → DeepL dịch → kết quả engine: 'api', không lỗi", async () => {
    const { router, deeplEngine } = setupRouter();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("translate.googleapis.com")) {
          return new Response("Too Many Requests", { status: 429 });
        }
        return new Response("Not found", { status: 404 });
      })
    );

    const deeplSpy = vi
      .spyOn(deeplEngine, "translateLines")
      .mockResolvedValue(["Xin chào thế giới"]);

    const { results, error } = await router.translate({
      lines: ["Hello world"],
      priority: "tier1",
    });

    expect(deeplSpy).toHaveBeenCalledTimes(1);
    expect(error).toBeUndefined();
    expect(results[0].text).toBe("Xin chào thế giới");
    expect(results[0].engine).toBe("api");
  });

  // Case 3: Có key: breaker GTX mở → DeepL được gọi, GTX không gọi HTTP
  it("3. Có key: breaker GTX mở → DeepL được gọi, GTX không gọi HTTP", async () => {
    const { router, gtxBreaker, deeplEngine } = setupRouter();

    // Khóa breaker GTX
    gtxBreaker.report({ kind: "blocked", retryAfterMs: 60000 }, false);
    expect(gtxBreaker.blocked()).toBe(true);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const deeplSpy = vi
      .spyOn(deeplEngine, "translateLines")
      .mockResolvedValue(["Đã dịch qua DeepL"]);

    const { results, error } = await router.translate({
      lines: ["Hello world"],
      priority: "tier1",
    });

    // GTX không gọi fetch vì breaker chặn ngay từ đầu
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deeplSpy).toHaveBeenCalledTimes(1);
    expect(error).toBeUndefined();
    expect(results[0].text).toBe("Đã dịch qua DeepL");
    expect(results[0].engine).toBe("api");
  });

  // Case 4: prefer: true → DeepL trước; DeepL 456 → GTX dịch
  it("4. prefer: true → DeepL trước; DeepL 456 → GTX dịch", async () => {
    const { router, deeplEngine } = setupRouter({ deeplPrefer: true });

    const deeplSpy = vi
      .spyOn(deeplEngine, "translateLines")
      .mockRejectedValue(new DeepLQuotaError("Quota exceeded (456)"));

    const mockGtxResponse = [[["Dịch từ Google", "Hello world"]], null, "en"];
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("translate.googleapis.com")) {
        return new Response(JSON.stringify(mockGtxResponse), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { results, error } = await router.translate({
      lines: ["Hello world"],
      priority: "tier1",
    });

    expect(deeplSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalled();
    expect(error).toBeUndefined();
    expect(results[0].text).toBe("Dịch từ Google");
    expect(results[0].engine).toBe("api");
  });

  // Case 5: enabled: false → như không có key
  it("5. enabled: false → như không có key, DeepL không được gọi", async () => {
    const { router, deeplEngine } = setupRouter({ deeplEnabled: false });
    const deeplSpy = vi.spyOn(deeplEngine, "translateLines");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too Many Requests", { status: 429 }))
    );
    vi.spyOn((router as any).geminiEngine, "hasKey").mockReturnValue(false);

    const { results, error } = await router.translate({
      lines: ["Hello world"],
      priority: "tier1",
    });

    expect(deeplSpy).not.toHaveBeenCalled();
    expect(results[0].text).toBe("");
    expect(error?.kind).toBe("blocked");
  });

  // Case 6: GTX NetworkError → không gọi DeepL; lỗi network
  it("6. GTX NetworkError → không gọi DeepL; lỗi network", async () => {
    const { router, deeplEngine } = setupRouter();
    const deeplSpy = vi.spyOn(deeplEngine, "translateLines");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch (no internet)");
      })
    );

    const { results, error } = await router.translate({
      lines: ["Hello world"],
      priority: "tier1",
    });

    expect(deeplSpy).not.toHaveBeenCalled();
    expect(results[0].text).toBe("");
    expect(error?.kind).toBe("network");
  });

  // Case 7: Cả hai 429 (GTX retry 30 s, DeepL retry 5 s) → lỗi blocked, retryAfterMs = 5 s
  it("7. Cả hai 429 (GTX retry 30s, DeepL retry 5s) → lỗi blocked với retryAfterMs nhỏ nhất (5s)", async () => {
    const { router, deeplEngine } = setupRouter();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      })
    );

    vi.spyOn(deeplEngine, "translateLines").mockRejectedValue(
      new RateLimitedError("DeepL rate limit", 5000)
    );

    // Bỏ qua gemini để lỗi dừng ở api
    vi.spyOn((router as any).geminiEngine, "hasKey").mockReturnValue(false);

    const { results, error } = await router.translate({
      lines: ["Hello world"],
      priority: "tier1",
    });

    expect(results[0].text).toBe("");
    expect(error?.kind).toBe("blocked");
    expect(error?.retryAfterMs).toBe(5000);
  });

  // Case 8: DeepL 403 → breaker DeepL không bị report; lỗi cuối là lỗi của GTX
  it("8. DeepL 403 → breaker DeepL không bị report; lỗi cuối là lỗi của GTX", async () => {
    const { router, deeplEngine, deeplBreaker } = setupRouter();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("Too Many Requests", { status: 429 });
      })
    );

    const breakerReportSpy = vi.spyOn(deeplBreaker, "report");

    vi.spyOn(deeplEngine, "translateLines").mockRejectedValue(
      new DisabledError("DeepL: key không hợp lệ (HTTP 403)")
    );
    vi.spyOn((router as any).geminiEngine, "hasKey").mockReturnValue(false);

    const { results, error } = await router.translate({
      lines: ["Hello world"],
      priority: "tier1",
    });

    expect(breakerReportSpy).not.toHaveBeenCalled();
    expect(error?.kind).toBe("blocked");
    expect(results[0].text).toBe("");
  });

  // Case 9: Hủy (signal.abort) trong lúc DeepL chạy → CanceledError
  it("9. Hủy (signal.abort) trong lúc DeepL chạy → ném CanceledError", async () => {
    const { router, deeplEngine } = setupRouter();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too Many Requests", { status: 429 }))
    );

    const controller = new AbortController();

    vi.spyOn(deeplEngine, "translateLines").mockImplementation(async () => {
      controller.abort();
      throw new CanceledError();
    });

    await expect(
      router.translate({
        lines: ["Hello world"],
        priority: "tier1",
        signal: controller.signal,
      })
    ).rejects.toThrow(CanceledError);
  });

  // Case 10: Kết quả DeepL vào phraseCache với khóa "api|…"; lần sau trúng cache, không gọi lại
  it("10. Kết quả DeepL vào phraseCache với khóa 'api|…'; lần sau trúng cache không gọi lại", async () => {
    const { router, deeplEngine, phraseCache } = setupRouter();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too Many Requests", { status: 429 }))
    );

    const deeplSpy = vi
      .spyOn(deeplEngine, "translateLines")
      .mockResolvedValue(["Xin chào"]);

    const res1 = await router.translate({
      lines: ["Hello"],
      priority: "tier1",
    });

    expect(deeplSpy).toHaveBeenCalledTimes(1);
    expect(res1.results[0].text).toBe("Xin chào");
    expect(res1.results[0].engine).toBe("api");
    expect(phraseCache.get("api|Hello")).toBe("Xin chào");

    // Lần 2: gọi lại câu "Hello" -> lấy từ cache
    deeplSpy.mockClear();
    const res2 = await router.translate({
      lines: ["Hello"],
      priority: "tier1",
    });

    expect(deeplSpy).not.toHaveBeenCalled();
    expect(res2.results[0].text).toBe("Xin chào");
    expect(res2.results[0].engine).toBe("api");
  });

  // Case 11: Chế độ gemini/hybrid: tầng cloud không đổi; tầng api dự phòng vẫn dùng DeepL
  it("11. Chế độ gemini/hybrid: tầng cloud không đổi; tầng api dự phòng vẫn dùng DeepL", async () => {
    const { router, deeplEngine, geminiEngine } = setupRouter({ mode: "hybrid" });

    // Trong hybrid mode với priority tier1: tiers là [api, cloud]
    // Giả lập GTX 429 -> DeepL dịch thành công ở tầng api
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("translate.googleapis.com")) {
          return new Response("Too Many Requests", { status: 429 });
        }
        return new Response("{}", { status: 200 });
      })
    );

    const deeplSpy = vi
      .spyOn(deeplEngine, "translateLines")
      .mockResolvedValue(["Dịch bởi DeepL trong Hybrid"]);

    const geminiSpy = vi.spyOn(geminiEngine, "translateLines");

    const { results, error } = await router.translate({
      lines: ["Testing hybrid"],
      priority: "tier1",
    });

    expect(error).toBeUndefined();
    expect(deeplSpy).toHaveBeenCalledTimes(1);
    // Tầng 1 (api) đã dịch thành công nên không đánh thức tầng cloud
    expect(geminiSpy).not.toHaveBeenCalled();
    expect(results[0].text).toBe("Dịch bởi DeepL trong Hybrid");
    expect(results[0].engine).toBe("api");
  });
});

describe("Phase 12 G3 — review", () => {
  function make(deeplBreaker = new CircuitBreaker()) {
    const deeplEngine = new DeepLEngine({ apiKey: "mock-key:fx" });
    const geminiEngine = new GeminiEngine(
      { apiKey: "", model: "m", endpoint: "https://x", timeoutTier1Ms: 1000, timeoutTier2Ms: 1000, maxItemsTier1: 10, maxItemsTier2: 20 },
      new CircuitBreaker(),
      new TokenBucket(12)
    );
    const router = new TranslationRouter(
      { mode: "google", geminiModel: "m" },
      new LRUCache<string, string>(100),
      new CircuitBreaker(),
      new GtxQueue(2, 0),
      geminiEngine,
      { engine: deeplEngine, breaker: deeplBreaker, queue: new GtxQueue(1, 0), getPrefs: () => ({ enabled: true, prefer: false }) }
    );
    return { router, deeplEngine, deeplBreaker };
  }

  it("DeepL key sai trong lượt probe half-open → trả lượt probe (breaker không kẹt), không phạt breaker", async () => {
    let now = 1_000_000;
    const deeplBreaker = new CircuitBreaker({}, () => now);
    deeplBreaker.report({ kind: "blocked", retryAfterMs: 20_000 }, false); // khóa 20 s
    now += 60_000; // hết cooldown → half-open
    const { router, deeplEngine } = make(deeplBreaker);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Too Many Requests", { status: 429 })));
    vi.spyOn(deeplEngine, "translateLines").mockRejectedValue(new DisabledError("DeepL: key không hợp lệ (HTTP 403)"));

    await router.translate({ lines: ["Hello"], priority: "tier1" });
    // Lượt probe phải được trả: caller kế tiếp vẫn nhận được probe
    expect(deeplBreaker.allow()).toEqual({ allowed: true, isProbe: true });
    vi.unstubAllGlobals();
  });

  it("GTX lỗi tạm thời (HTTP 500) + DeepL hết hạn mức (456) → lỗi 'other' (thử lại sớm), KHÔNG tạm nghỉ 6 giờ", async () => {
    const { router, deeplEngine } = make();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    vi.spyOn(deeplEngine, "translateLines").mockRejectedValue(new DeepLQuotaError());
    const { error } = await router.translate({ lines: ["Hello"], priority: "tier1" });
    expect(error?.kind).toBe("other");
    expect(error?.retryAfterMs).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("Chỉ có lỗi DisabledError của DeepL + GTX 429 → vẫn là 'blocked' của GTX", async () => {
    const { router, deeplEngine } = make();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Too Many Requests", { status: 429 })));
    vi.spyOn(deeplEngine, "translateLines").mockRejectedValue(new DisabledError("x"));
    const { error } = await router.translate({ lines: ["Hello"], priority: "tier1" });
    expect(error?.kind).toBe("blocked");
    vi.unstubAllGlobals();
  });
});
