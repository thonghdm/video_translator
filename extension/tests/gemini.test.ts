import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GeminiEngine,
  cleanJSONText,
  parseRetryDelayFromBody,
  sanitizeApiKey,
} from "../src/background/engines/gemini";
import { CircuitBreaker } from "../src/shared/breaker";
import { TokenBucket } from "../src/shared/tokenBucket";
import {
  RateLimitedError,
  InvalidResponseIdsError,
} from "../src/background/engines/errors";

describe("Gemini Engine (Port từ gemini_test.go)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("cleanJSONText: bóc tách chính xác mảng JSON bên trong Markdown codeblock", () => {
    const raw = '```json\n[{"id": 0, "vi": "Xin chào"}]\n```';
    expect(cleanJSONText(raw)).toBe('[{"id": 0, "vi": "Xin chào"}]');

    const withPreamble = 'Đây là kết quả:\n[{"id": 0, "vi": "A"}]\nHy vọng bạn hài lòng!';
    expect(cleanJSONText(withPreamble)).toBe('[{"id": 0, "vi": "A"}]');
  });

  it("parseRetryDelayFromBody: trích xuất đúng retryDelay dạng số giây", () => {
    const body = '{"error": {"details": [{"@type": "...", "retryDelay": "15.5s"}]}}';
    expect(parseRetryDelayFromBody(body)).toBe(15500);

    const bodyNoDelay = '{"error": {"message": "Resource exhausted"}}';
    expect(parseRetryDelayFromBody(bodyNoDelay)).toBeUndefined();
  });

  it("sanitizeApiKey: che API key trong mọi thông báo lỗi", () => {
    const key = "AIzaSySecretApiKey123456";
    const msg = `Lỗi kết nối tới endpoint với key ${key} thất bại`;
    expect(sanitizeApiKey(msg, key)).toBe(
      "Lỗi kết nối tới endpoint với key [REDACTED_API_KEY] thất bại"
    );
  });

  it("doRequest: phát hiện ID lạ không có trong danh sách gửi", async () => {
    const breaker = new CircuitBreaker();
    const bucket = new TokenBucket(12);
    const engine = new GeminiEngine(
      {
        apiKey: "test_key",
        model: "gemini-3.5-flash-lite",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
        timeoutTier1Ms: 3500,
        timeoutTier2Ms: 8000,
        maxItemsTier1: 10,
        maxItemsTier2: 20,
      },
      breaker,
      bucket
    );

    // Gửi item ID: 0, nhưng Gemini trả về ID: 99
    const mockResponse = {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [{ text: JSON.stringify([{ id: 99, vi: "Lạ" }]) }],
          },
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    await expect(
      engine.doRequest([{ id: 0, text: "Hello" }], [], 3500)
    ).rejects.toThrow(InvalidResponseIdsError);
  });

  it("doRequest: phát hiện ID trùng lặp trong phản hồi", async () => {
    const breaker = new CircuitBreaker();
    const bucket = new TokenBucket(12);
    const engine = new GeminiEngine(
      {
        apiKey: "test_key",
        model: "gemini-3.5-flash-lite",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
        timeoutTier1Ms: 3500,
        timeoutTier2Ms: 8000,
        maxItemsTier1: 10,
        maxItemsTier2: 20,
      },
      breaker,
      bucket
    );

    const mockResponse = {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                text: JSON.stringify([
                  { id: 0, vi: "A" },
                  { id: 0, vi: "B" },
                ]),
              },
            ],
          },
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    await expect(
      engine.doRequest([{ id: 0, text: "Hello" }], [], 3500)
    ).rejects.toThrow(InvalidResponseIdsError);
  });

  it("translateLines: retry riêng các ID thiếu khi còn token", async () => {
    const breaker = new CircuitBreaker();
    const bucket = new TokenBucket(12);
    const engine = new GeminiEngine(
      {
        apiKey: "test_key",
        model: "gemini-3.5-flash-lite",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
        timeoutTier1Ms: 3500,
        timeoutTier2Ms: 8000,
        maxItemsTier1: 10,
        maxItemsTier2: 20,
      },
      breaker,
      bucket
    );

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          // Lần đầu chỉ trả về ID 0, thiếu ID 1
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: "STOP",
                  content: { parts: [{ text: JSON.stringify([{ id: 0, vi: "Xin chào" }]) }] },
                },
              ],
            }),
            { status: 200 }
          );
        }
        // Lần 2 (retry cho ID 1) trả về ID 1
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ text: JSON.stringify([{ id: 1, vi: "Thế giới" }]) }] },
              },
            ],
          }),
          { status: 200 }
        );
      })
    );

    const lines = ["Hello", "World"];
    const out = await engine.translateLines(lines, [], true);

    expect(out).toEqual(["Xin chào", "Thế giới"]);
    expect(callCount).toBe(2);
  });

  it("gặp lỗi HTTP 429 kèm retryDelay: kích hoạt RateLimitedError với retryAfterMs", async () => {
    const breaker = new CircuitBreaker();
    const bucket = new TokenBucket(12);
    const engine = new GeminiEngine(
      {
        apiKey: "test_key",
        model: "gemini-3.5-flash-lite",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
        timeoutTier1Ms: 3500,
        timeoutTier2Ms: 8000,
        maxItemsTier1: 10,
        maxItemsTier2: 20,
      },
      breaker,
      bucket
    );

    const errorPayload = {
      error: {
        code: 429,
        message: "Resource exhausted",
        details: [{ retryDelay: "20s" }],
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(errorPayload), { status: 429 }))
    );

    try {
      await engine.translateLines(["Hello"], [], true);
      expect.fail("Kỳ vọng throw RateLimitedError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterMs).toBe(20000);
    }
  });
});
