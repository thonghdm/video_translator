import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranslationRouter } from "../src/background/router";
import { LRUCache } from "../src/shared/lru";
import { CircuitBreaker } from "../src/shared/breaker";
import { GtxQueue } from "../src/background/engines/gtx";
import { GeminiEngine } from "../src/background/engines/gemini";
import { TokenBucket } from "../src/shared/tokenBucket";
import { CanceledError } from "../src/background/engines/errors";

describe("Translation Router (Port từ translator_mock_test.go)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createTestRouter(mode: "google" | "gemini" | "hybrid" = "google") {
    const phraseCache = new LRUCache<string, string>(100);
    const gtxBreaker = new CircuitBreaker();
    const gtxQueue = new GtxQueue(2, 0); // gapMs = 0 cho test nhanh
    const geminiBreaker = new CircuitBreaker();
    const geminiBucket = new TokenBucket(12);

    const geminiEngine = new GeminiEngine(
      {
        apiKey: "valid_gemini_key",
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
      geminiEngine
    );

    return {
      router,
      phraseCache,
      gtxBreaker,
      geminiBreaker,
      geminiEngine,
    };
  }

  it("Google mode: GTX thành công -> trả về engine 'api'", async () => {
    const { router } = createTestRouter("google");

    const mockGtxResponse = [[["Xin chào", "Hello"]], null, "en"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(mockGtxResponse), { status: 200 }))
    );

    const { results } = await router.translate({
      lines: ["Hello"],
      priority: "tier1",
    });

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("Xin chào");
    expect(results[0].engine).toBe("api");
  });

  it("Google mode: GTX bị 429 rate limit -> tự động fallback sang Gemini ('cloud')", async () => {
    const { router } = createTestRouter("google");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // GTX request bị 429
        if (url.includes("translate.googleapis.com")) {
          return new Response("Too Many Requests", { status: 429 });
        }
        // Gemini request thành công
        const geminiResp = {
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: JSON.stringify([{ id: 0, vi: "Xin chào từ Gemini" }]) }] },
            },
          ],
        };
        return new Response(JSON.stringify(geminiResp), { status: 200 });
      })
    );

    const { results } = await router.translate({
      lines: ["Hello"],
      priority: "tier1",
    });

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("Xin chào từ Gemini");
    expect(results[0].engine).toBe("cloud");
  });

  it("GTX lỗi mạng (NetworkError) -> bỏ qua Cloud và trả về lỗi network ngay", async () => {
    const { router } = createTestRouter("google");
    let geminiCalled = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("translate.googleapis.com")) {
          // fetch ném TypeError khi mất mạng hoặc không phân giải được DNS
          throw new TypeError("Failed to fetch");
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          geminiCalled = true;
          return new Response("{}", { status: 200 });
        }
        return new Response("", { status: 500 });
      })
    );

    const { results, error } = await router.translate({
      lines: ["Hello"],
      priority: "tier1",
    });

    expect(geminiCalled).toBe(false);
    expect(error).toBeDefined();
    expect(error?.kind).toBe("network");
    expect(results[0].text).toBe("");
  });

  it("bị hủy (abort) giữa chừng -> dừng ngay, không chuyển tầng", async () => {
    const { router } = createTestRouter("google");
    const controller = new AbortController();
    controller.abort();

    await expect(
      router.translate({
        lines: ["Hello"],
        priority: "tier1",
        signal: controller.signal,
      })
    ).rejects.toThrow(CanceledError);
  });

  it("câu tiếng động hoặc nốt nhạc -> trả về rỗng không gửi qua API", async () => {
    const { router } = createTestRouter("google");
    let fetchCalled = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      })
    );

    const { results } = await router.translate({
      lines: ["[Music]", "♪♪♪", "   "],
      priority: "tier1",
    });

    expect(fetchCalled).toBe(false);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ text: "", engine: null });
    expect(results[1]).toEqual({ text: "", engine: null });
    expect(results[2]).toEqual({ text: "", engine: null });
  });
});
