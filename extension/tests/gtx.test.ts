import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  translateFastGtx,
  googleBatchOrPerLine,
} from "../src/background/engines/gtx";
import { LRUCache } from "../src/shared/lru";
import { RateLimitedError } from "../src/background/engines/errors";

describe("GTX Engine", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("translateFastGtx: parse đúng định dạng phản hồi chuẩn của GTX", async () => {
    // Response chuẩn từ Phụ lục B
    const mockJson = [[["Xin chào thế giới", "Hello world", null, null, 10]], null, "en"];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(mockJson), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const out = await translateFastGtx("Hello world", "en");
    expect(out).toBe("Xin chào thế giới");
  });

  it("translateFastGtx: gặp HTTP 429 ném ra RateLimitedError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("Too Many Requests", { status: 429 });
      })
    );

    await expect(translateFastGtx("Hello")).rejects.toThrow(RateLimitedError);
  });

  it("googleBatchOrPerLine: batch thành công khi số dòng khớp", async () => {
    const mockJson = [
      [
        ["Dòng một\n", "Line one\n"],
        ["Dòng hai", "Line two"],
      ],
      null,
      "en",
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(mockJson), { status: 200 });
      })
    );

    const cache = new LRUCache<string, string>(100);
    const lines = ["Line one", "Line two"];
    const out = await googleBatchOrPerLine(lines, "en", undefined, cache);

    expect(out).toEqual(["Dòng một", "Dòng hai"]);
    expect(cache.get("api|Line one")).toBe("Dòng một");
    expect(cache.get("api|Line two")).toBe("Dòng hai");
  });

  it("googleBatchOrPerLine: lệch dòng thì chuyển sang dịch từng dòng và dùng cache", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        callCount++;
        // Lần đầu (batch có \n -> %0A): trả về gộp chỉ có 1 dòng (lệch dòng)
        if (url.includes("%0A")) {
          return new Response(
            JSON.stringify([[["Gộp cả đoạn", "Line 1\nLine 2"]]]),
            { status: 200 }
          );
        }
        if (url.includes("Line%201")) {
          return new Response(
            JSON.stringify([[["Dòng 1", "Line 1"]]]),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify([[["Dòng 2", "Line 2"]]]),
          { status: 200 }
        );
      })
    );

    const cache = new LRUCache<string, string>(100);
    // Điền sẵn cache cho Line 1 -> chỉ cần gọi fetch cho Line 2
    cache.set("api|Line 1", "Dòng 1 (cached)");

    const lines = ["Line 1", "Line 2"];
    const out = await googleBatchOrPerLine(lines, "en", undefined, cache);

    expect(out).toEqual(["Dòng 1 (cached)", "Dòng 2"]);
    expect(cache.get("api|Line 2")).toBe("Dòng 2");
    // 1 lần gọi batch + 1 lần gọi per-line cho Line 2 (Line 1 đã có cache)
    expect(callCount).toBe(2);
  });
});
