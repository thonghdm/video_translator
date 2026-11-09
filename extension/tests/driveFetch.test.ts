import { describe, it, expect, vi } from "vitest";
import {
  driveFetchText,
  decodeSubtitleBytes,
  DRIVE_MAX_BYTES,
  DRIVE_FETCH_HOSTS,
  DRIVE_FETCH_TIMEOUT_MS,
} from "../src/background/engines/driveFetch";

function makeStreamResponse({
  chunks,
  headers = {},
  url = "https://drive.google.com/uc?export=download&id=valid_id_1234567890",
  status = 200,
  onCancel,
}: {
  chunks: Uint8Array[];
  headers?: Record<string, string>;
  url?: string;
  status?: number;
  onCancel?: () => void;
}): Response {
  let idx = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(chunks[idx++]);
      } else {
        controller.close();
      }
    },
    cancel() {
      onCancel?.();
    },
  });

  const res = new Response(stream, {
    status,
    headers: { "content-type": "text/plain", ...headers },
  });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

describe("decodeSubtitleBytes", () => {
  it("giải mã đúng UTF-8 thông thường", () => {
    const text = "1\r\n00:00:01,000 --> 00:00:04,000\r\nXin chào thế giới";
    const bytes = new TextEncoder().encode(text);
    expect(decodeSubtitleBytes(bytes)).toBe(text);
  });

  it("loại bỏ BOM UTF-8 (EF BB BF)", () => {
    const text = "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello with BOM";
    const raw = new TextEncoder().encode(text);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...raw]);
    expect(decodeSubtitleBytes(withBom)).toBe(text);
  });

  it("giải mã đúng UTF-16LE có BOM (FF FE)", () => {
    const text = "1\r\n00:00:01,000 --> 00:00:04,000\r\nUTF-16LE subtitle";
    const buf = new Uint8Array(2 + text.length * 2);
    buf[0] = 0xff;
    buf[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      buf[2 + i * 2] = code & 0xff;
      buf[2 + i * 2 + 1] = (code >> 8) & 0xff;
    }
    expect(decodeSubtitleBytes(buf)).toBe(text);
  });

  it("giải mã đúng UTF-16BE có BOM (FE FF)", () => {
    const text = "1\r\n00:00:01,000 --> 00:00:04,000\r\nUTF-16BE subtitle";
    const buf = new Uint8Array(2 + text.length * 2);
    buf[0] = 0xfe;
    buf[1] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      buf[2 + i * 2] = (code >> 8) & 0xff;
      buf[2 + i * 2 + 1] = code & 0xff;
    }
    expect(decodeSubtitleBytes(buf)).toBe(text);
  });

  it("fallback sang windows-1252 khi ký tự lỗi UTF-8 > 1%", () => {
    // 0xe9 = é trong windows-1252; đứng đơn độc trong UTF-8 sẽ thành \uFFFD
    const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]); // "Café" trong windows-1252
    expect(decodeSubtitleBytes(bytes)).toBe("Café");
  });
});

describe("driveFetchText", () => {
  const validId = "1a2b3c4d5e6f7g8h9i0j_valid_id";

  it("ném lỗi khi id sai định dạng DRIVE_ID_RE", async () => {
    await expect(driveFetchText("bad/id")).rejects.toThrow("Invalid Drive file ID");
    await expect(driveFetchText("short")).rejects.toThrow("Invalid Drive file ID");
    await expect(driveFetchText("")).rejects.toThrow("Invalid Drive file ID");
  });

  it("gửi request với URL và fetch options chuẩn (§3.2)", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      const data = new TextEncoder().encode("1\r\n00:00:00,000 --> 00:00:01,000\r\nHello");
      return makeStreamResponse({ chunks: [data] });
    });

    const res = await driveFetchText(validId, mockFetch as unknown as typeof fetch);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("Hello");
    }

    expect(capturedUrl).toBe(`https://drive.google.com/uc?export=download&id=${validId}`);
    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.credentials).toBe("include");
    expect(capturedInit?.cache).toBe("no-store");
    expect(capturedInit?.referrerPolicy).toBe("no-referrer");
    expect(capturedInit?.redirect).toBe("follow");
    expect(capturedInit?.signal).toBeDefined();
  });

  it("map HTTP 404 thành not_found", async () => {
    const mockFetch = vi.fn(async () =>
      makeStreamResponse({ chunks: [], status: 404 })
    );
    const res = await driveFetchText(validId, mockFetch as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("map HTTP 401/403 thành not_permitted", async () => {
    const mock401 = vi.fn(async () =>
      makeStreamResponse({ chunks: [], status: 401 })
    );
    const res401 = await driveFetchText(validId, mock401 as unknown as typeof fetch);
    expect(res401).toEqual({ ok: false, reason: "not_permitted" });

    const mock403 = vi.fn(async () =>
      makeStreamResponse({ chunks: [], status: 403 })
    );
    const res403 = await driveFetchText(validId, mock403 as unknown as typeof fetch);
    expect(res403).toEqual({ ok: false, reason: "not_permitted" });
  });

  it("map HTTP 500 hoặc !res.ok khác thành network", async () => {
    const mockFetch = vi.fn(async () =>
      makeStreamResponse({ chunks: [], status: 500 })
    );
    const res = await driveFetchText(validId, mockFetch as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, reason: "network" });
  });

  it("từ chối redirect sang host lạ (không thuộc DRIVE_FETCH_HOSTS) → not_permitted", async () => {
    const mockFetch = vi.fn(async () =>
      makeStreamResponse({
        chunks: [new TextEncoder().encode("content")],
        url: "https://evil.example.com/steal",
      })
    );
    const res = await driveFetchText(validId, mockFetch as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, reason: "not_permitted" });
  });

  it("chấp nhận redirect sang drive.usercontent.google.com", async () => {
    const text = "1\r\n00:00:00,000 --> 00:00:01,000\r\nAccepted";
    const mockFetch = vi.fn(async () =>
      makeStreamResponse({
        chunks: [new TextEncoder().encode(text)],
        url: "https://drive.usercontent.google.com/download/xxx",
      })
    );
    const res = await driveFetchText(validId, mockFetch as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, text });
  });

  it("từ chối response có content-type text/html → not_permitted", async () => {
    const mockFetch = vi.fn(async () =>
      makeStreamResponse({
        chunks: [new TextEncoder().encode("login page")],
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    );
    const res = await driveFetchText(validId, mockFetch as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, reason: "not_permitted" });
  });

  it("từ chối body bắt đầu bằng <!DOCTYPE html hoặc <html dù header là text/plain → not_permitted", async () => {
    const mockFetch1 = vi.fn(async () =>
      makeStreamResponse({
        chunks: [new TextEncoder().encode("   \n <!DOCTYPE html><html><body>login</body></html>")],
        headers: { "content-type": "text/plain" },
      })
    );
    const res1 = await driveFetchText(validId, mockFetch1 as unknown as typeof fetch);
    expect(res1).toEqual({ ok: false, reason: "not_permitted" });

    const mockFetch2 = vi.fn(async () =>
      makeStreamResponse({
        chunks: [new TextEncoder().encode("<html lang=\"en\"><body>Google Account</body></html>")],
        headers: { "content-type": "text/plain" },
      })
    );
    const res2 = await driveFetchText(validId, mockFetch2 as unknown as typeof fetch);
    expect(res2).toEqual({ ok: false, reason: "not_permitted" });
  });

  it("hủy stream (reader.cancel) và trả too_large khi body vượt quá DRIVE_MAX_BYTES (1MB)", async () => {
    let cancelCalled = false;
    const chunk = new Uint8Array(600 * 1024); // 600 KB mỗi chunk

    const mockFetch = vi.fn(async () => {
      let idx = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          // Gửi vô tận cho đến khi bị cancel
          controller.enqueue(chunk);
          idx++;
        },
        cancel() {
          cancelCalled = true;
        },
      });

      const res = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
      Object.defineProperty(res, "url", {
        value: "https://drive.google.com/uc?export=download&id=" + validId,
      });
      return res;
    });

    const res = await driveFetchText(validId, mockFetch as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, reason: "too_large" });
    expect(cancelCalled).toBe(true);
  });

  it("xử lý timeout (AbortError) → timeout", async () => {
    const mockFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    vi.useFakeTimers();
    try {
      const promise = driveFetchText(validId, mockFetch as unknown as typeof fetch);
      vi.advanceTimersByTime(DRIVE_FETCH_TIMEOUT_MS + 100);
      const res = await promise;
      expect(res).toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("map lỗi TypeError / lỗi mạng bất ngờ thành network", async () => {
    const mockFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const res = await driveFetchText(validId, mockFetch as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, reason: "network" });
  });

  it("DRIVE_FETCH_HOSTS chứa drive.google.com và drive.usercontent.google.com", () => {
    expect(DRIVE_FETCH_HOSTS).toContain("drive.google.com");
    expect(DRIVE_FETCH_HOSTS).toContain("drive.usercontent.google.com");
    expect(DRIVE_MAX_BYTES).toBe(1024 * 1024);
  });
  it("Review D3: content-type text/html → từ chối mà KHÔNG đọc hết body", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 50) return c.close();
        c.enqueue(new Uint8Array(10000));
      },
    });
    const res = new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    Object.defineProperty(res, "url", { value: "https://drive.google.com/uc" });
    const r = await driveFetchText("abcdefghij12", (async () => res) as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "not_permitted" });
    expect(pulled).toBeLessThan(5);
  });
});
