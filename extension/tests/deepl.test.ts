import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEEPL_MAX_TEXTS,
  DEEPL_MAX_BODY_BYTES,
  DEEPL_TIMEOUT_MS,
  DEEPL_SEND_MODEL_TYPE,
  deeplBaseUrl,
  toDeepLSourceLang,
  chunkForDeepL,
  DeepLEngine,
} from "../src/background/engines/deepl";
import {
  RateLimitedError,
  DisabledError,
  InvalidResponseIdsError,
  CanceledError,
  NetworkError,
  DeepLQuotaError,
} from "../src/background/engines/errors";

describe("Phase 12 G1 — DeepL Engine Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // 1. deeplBaseUrl: abc:fx -> api-free, abc -> api
  it("Group 1 — deeplBaseUrl: phân biệt endpoint free (:fx) và pro", () => {
    expect(DEEPL_MAX_TEXTS).toBe(50);
    expect(DEEPL_MAX_BODY_BYTES).toBe(120 * 1024);
    expect(DEEPL_TIMEOUT_MS).toBe(8000);
    expect(deeplBaseUrl("my-secret-key:fx")).toBe("https://api-free.deepl.com");
    expect(deeplBaseUrl("  my-secret-key:fx  ")).toBe("https://api-free.deepl.com");
    expect(deeplBaseUrl("my-pro-key")).toBe("https://api.deepl.com");
    expect(deeplBaseUrl("abc")).toBe("https://api.deepl.com");
  });

  // 2. toDeepLSourceLang: auto, "", en, en-US, EN
  it("Group 2 — toDeepLSourceLang: chuẩn hóa mã ngôn ngữ nguồn", () => {
    expect(toDeepLSourceLang("auto")).toBeUndefined();
    expect(toDeepLSourceLang("Auto")).toBeUndefined();
    expect(toDeepLSourceLang("")).toBeUndefined();
    expect(toDeepLSourceLang("   ")).toBeUndefined();
    expect(toDeepLSourceLang("en")).toBe("EN");
    expect(toDeepLSourceLang("en-US")).toBe("EN");
    expect(toDeepLSourceLang("en_GB")).toBe("EN");
    expect(toDeepLSourceLang("EN")).toBe("EN");
    expect(toDeepLSourceLang("zh-CN")).toBe("ZH");
  });

  // 3. body/header/credentials đúng
  it("Group 3 — Request gửi đi có đúng header, body JSON §1 và credentials: omit", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          translations: [{ detected_source_language: "EN", text: "Xin chào" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const apiKey = "test-key-12345:fx";
    const engine = new DeepLEngine({ apiKey }, mockFetch as unknown as typeof fetch);

    const out = await engine.translateLines(["Hello"], "en-US");
    expect(out).toEqual(["Xin chào"]);

    expect(capturedUrl).toBe("https://api-free.deepl.com/v2/translate");
    expect(capturedInit).toBeDefined();
    expect(capturedInit?.credentials).toBe("omit");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`DeepL-Auth-Key ${apiKey}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const parsedBody = JSON.parse(capturedInit?.body as string);
    expect(parsedBody.text).toEqual(["Hello"]);
    expect(parsedBody.target_lang).toBe("VI");
    expect(parsedBody.source_lang).toBe("EN");
    expect(parsedBody.split_sentences).toBe("nonewlines");
    expect(parsedBody.preserve_formatting).toBe(true);
    if (DEEPL_SEND_MODEL_TYPE) {
      expect(parsedBody.model_type).toBe("quality_optimized");
    } else {
      expect(parsedBody.model_type).toBeUndefined();
    }
  });

  // 4. 3 dòng đúng thứ tự
  it("Group 4 — 3 dòng gửi đi trả về 3 bản dịch đúng thứ tự", async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          translations: [
            { text: "Dòng một" },
            { text: "Dòng hai" },
            { text: "Dòng ba" },
          ],
        }),
        { status: 200 }
      );
    });

    const engine = new DeepLEngine({ apiKey: "key:fx" }, mockFetch as unknown as typeof fetch);
    const results = await engine.translateLines(["Line 1", "Line 2", "Line 3"], "en");
    expect(results).toEqual(["Dòng một", "Dòng hai", "Dòng ba"]);
  });

  // 5. dòng rỗng giữa: không có trong body, trả "" đúng vị trí
  it("Group 5 — Dòng rỗng ở giữa không gửi lên API, kết quả trả về chuỗi rỗng đúng vị trí", async () => {
    let capturedTexts: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedTexts = body.text;
      return new Response(
        JSON.stringify({
          translations: [
            { text: "Dòng đầu" },
            { text: "Dòng cuối" },
          ],
        }),
        { status: 200 }
      );
    });

    const engine = new DeepLEngine({ apiKey: "key:fx" }, mockFetch as unknown as typeof fetch);
    const input = ["First line", "", "   ", "Last line"];
    const results = await engine.translateLines(input, "en");

    expect(capturedTexts).toEqual(["First line", "Last line"]);
    expect(results).toEqual(["Dòng đầu", "", "", "Dòng cuối"]);
  });

  // 6. 120 dòng -> 3 request 50/50/20, kết quả ghép đúng thứ tự
  it("Group 6 — 120 dòng được chia thành 3 request (50/50/20) và ghép đúng thứ tự", async () => {
    const batchSizes: number[] = [];
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(init?.body as string);
      batchSizes.push(body.text.length);
      return new Response(
        JSON.stringify({
          translations: body.text.map((t: string) => ({ text: `Dịch: ${t}` })),
        }),
        { status: 200 }
      );
    });

    const engine = new DeepLEngine({ apiKey: "key:fx" }, mockFetch as unknown as typeof fetch);
    const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`);
    const results = await engine.translateLines(lines, "en");

    expect(callCount).toBe(3);
    expect(batchSizes).toEqual([50, 50, 20]);
    expect(results.length).toBe(120);
    expect(results[0]).toBe("Dịch: Line 1");
    expect(results[49]).toBe("Dịch: Line 50");
    expect(results[50]).toBe("Dịch: Line 51");
    expect(results[119]).toBe("Dịch: Line 120");
  });

  // 7. dòng rất dài tách theo byte
  it("Group 7 — chunkForDeepL tách các dòng rất dài theo giới hạn byte (120 KiB)", () => {
    // Tạo 2 dòng, mỗi dòng xấp xỉ 70 KiB
    const long1 = "A".repeat(70 * 1024);
    const long2 = "B".repeat(70 * 1024);

    const chunks = chunkForDeepL([long1, long2]);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual([long1]);
    expect(chunks[1]).toEqual([long2]);

    // Dòng ngắn kết hợp dòng dài
    const shortLine = "Short text";
    const chunks2 = chunkForDeepL([long1, shortLine]);
    // long1 (~70KB) + shortLine (<1KB) <= 120KB -> cùng 1 chunk
    expect(chunks2.length).toBe(1);
    expect(chunks2[0]).toEqual([long1, shortLine]);
  });

  // 8. Từng mã HTTP trong bảng §1 -> đúng lớp lỗi; 429 đọc Retry-After; 456 -> DeepLQuotaError 6h
  describe("Group 8 — Ánh xạ mã HTTP lỗi", () => {
    it.each([
      [400, "DeepL HTTP 400"],
      [413, "DeepL HTTP 413"],
      [500, "DeepL HTTP 500"],
      [529, "DeepL HTTP 529"],
    ])("HTTP %i ném ra Error thông thường", async (status) => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Server error", { status })
      );
      const engine = new DeepLEngine({ apiKey: "key:fx" }, mockFetch as unknown as typeof fetch);
      await expect(engine.translateLines(["Hello"], "en")).rejects.toThrowError(
        `DeepL HTTP ${status}`
      );
    });

    it.each([401, 403])("HTTP %i ném ra DisabledError", async (status) => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Auth failed", { status })
      );
      const engine = new DeepLEngine({ apiKey: "key:fx" }, mockFetch as unknown as typeof fetch);
      await expect(engine.translateLines(["Hello"], "en")).rejects.toThrow(DisabledError);
    });

    it("HTTP 429 không có header Retry-After -> RateLimitedError mặc định 5 giây (5000ms)", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Too Many Requests", { status: 429 })
      );
      const engine = new DeepLEngine({ apiKey: "key:fx" }, mockFetch as unknown as typeof fetch);
      try {
        await engine.translateLines(["Hello"], "en");
        expect.unreachable("Phải ném lỗi 429");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitedError);
        expect((err as RateLimitedError).retryAfterMs).toBe(5000);
      }
    });

    it("HTTP 429 có header Retry-After số giây -> RateLimitedError với đúng thời gian", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "15" },
        })
      );
      const engine = new DeepLEngine({ apiKey: "key:fx" }, mockFetch as unknown as typeof fetch);
      try {
        await engine.translateLines(["Hello"], "en");
        expect.unreachable("Phải ném lỗi 429");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitedError);
        expect((err as RateLimitedError).retryAfterMs).toBe(15000);
      }
    });

    it("HTTP 456 hết hạn mức tháng -> DeepLQuotaError với retryAfterMs 6 giờ", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Quota exceeded", { status: 456 })
      );
      const engine = new DeepLEngine({ apiKey: "key:fx" }, mockFetch as unknown as typeof fetch);
      try {
        await engine.translateLines(["Hello"], "en");
        expect.unreachable("Phải ném lỗi 456");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepLQuotaError);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect((err as DeepLQuotaError).retryAfterMs).toBe(6 * 60 * 60 * 1000);
      }
    });
  });

  // 9. Số phần tử sai / JSON hỏng -> InvalidResponseIdsError
  it("Group 9 — Số phần tử phản hồi không khớp hoặc JSON hỏng ném ra InvalidResponseIdsError", async () => {
    // Không khớp số lượng (gửi 2 nhận 1)
    const mockMismatch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ translations: [{ text: "Một" }] }), { status: 200 })
    );
    const engine1 = new DeepLEngine({ apiKey: "key:fx" }, mockMismatch as unknown as typeof fetch);
    await expect(engine1.translateLines(["One", "Two"], "en")).rejects.toThrow(
      InvalidResponseIdsError
    );

    // JSON hỏng
    const mockCorrupt = vi.fn().mockResolvedValue(
      new Response("invalid json {", { status: 200 })
    );
    const engine2 = new DeepLEngine({ apiKey: "key:fx" }, mockCorrupt as unknown as typeof fetch);
    await expect(engine2.translateLines(["One"], "en")).rejects.toThrow(
      InvalidResponseIdsError
    );
  });

  // 10. TypeError/abort/timeout
  it("Group 10 — TypeError ném NetworkError, caller abort ném CanceledError, timeout ném timeout Error", async () => {
    // TypeError (mất mạng)
    const mockNetworkFail = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const engine1 = new DeepLEngine({ apiKey: "key:fx" }, mockNetworkFail as unknown as typeof fetch);
    await expect(engine1.translateLines(["Hello"], "en")).rejects.toThrow(NetworkError);

    // Caller abort
    const controller = new AbortController();
    controller.abort();
    const mockAbort = vi.fn().mockImplementation((_url, init) => {
      const sig = init?.signal;
      if (sig?.aborted) throw new Error("aborted");
      return new Promise(() => {});
    });
    const engine2 = new DeepLEngine({ apiKey: "key:fx" }, mockAbort as unknown as typeof fetch);
    await expect(engine2.translateLines(["Hello"], "en", controller.signal)).rejects.toThrow(
      CanceledError
    );

    // Timeout (mô phỏng timeout signal của engine kích hoạt)
    const mockTimeout = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_, reject) => {
        const sig = init?.signal as AbortSignal;
        sig.addEventListener("abort", () => {
          reject(sig.reason);
        });
      });
    });
    const engine3 = new DeepLEngine({ apiKey: "key:fx" }, mockTimeout as unknown as typeof fetch);
    // Cho timeout ngắn bằng mock timer
    vi.useFakeTimers();
    const promise = engine3.translateLines(["Hello"], "en");
    vi.advanceTimersByTime(DEEPL_TIMEOUT_MS + 100);
    await expect(promise).rejects.toThrowError(/timed out/i);
    vi.useRealTimers();
  });

  // 11. Key bị che trong thông báo lỗi
  it("Group 11 — API Key không bao giờ xuất hiện trong thông báo lỗi", async () => {
    const rawKey = "SuperSecretDeepLKey99999:fx";
    const mockErr = vi.fn().mockResolvedValue(
      new Response(`Error at endpoint with key ${rawKey}`, { status: 400 })
    );
    const engine = new DeepLEngine({ apiKey: rawKey }, mockErr as unknown as typeof fetch);

    try {
      await engine.translateLines(["Hello"], "en");
      expect.unreachable("Phải ném lỗi");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(rawKey);
      expect(msg).toContain("[REDACTED_API_KEY]");
    }
  });

  // 12. testConnection OK và 403
  it("Group 12 — testConnection: thành công trả về used/limit/sample, lỗi 403 trả về { ok: false } che key", async () => {
    const rawKey = "ValidKey12345:fx";

    // Trường hợp OK
    const mockOk = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v2/usage")) {
        return new Response(
          JSON.stringify({ character_count: 12500, character_limit: 500000 }),
          { status: 200 }
        );
      }
      if (url.includes("/v2/translate")) {
        return new Response(
          JSON.stringify({ translations: [{ text: "Chào thế giới" }] }),
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const resOk = await DeepLEngine.testConnection(rawKey, mockOk as unknown as typeof fetch);
    expect(resOk.ok).toBe(true);
    if (resOk.ok) {
      expect(resOk.used).toBe(12500);
      expect(resOk.limit).toBe(500000);
      expect(resOk.sample).toBe("Chào thế giới");
      expect(typeof resOk.latencyMs).toBe("number");
    }

    // Trường hợp 403 Forbidden
    const badKey = "BadSecretKey403403:fx";
    const mock403 = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v2/usage")) {
        return new Response(`Forbidden key ${badKey}`, { status: 403 });
      }
      return new Response("", { status: 403 });
    });

    const resFail = await DeepLEngine.testConnection(badKey, mock403 as unknown as typeof fetch);
    expect(resFail.ok).toBe(false);
    if (!resFail.ok) {
      expect(resFail.error).toContain("403");
      expect(resFail.error).not.toContain(badKey);
    }
  });
});
