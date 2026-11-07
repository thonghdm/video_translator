import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFetch } from "../src/background/engines/http";

describe("apiFetch security enforcement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("bắt buộc credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'", async () => {
    let capturedInit: RequestInit | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response("OK", { status: 200 });
      })
    );

    // Kể cả caller cố tình truyền credentials: "include", apiFetch vẫn phải override thành "omit"
    await apiFetch("https://translate.googleapis.com/test", {
      method: "POST",
      credentials: "include",
      headers: { "x-test": "1" },
    });

    expect(capturedInit).toBeDefined();
    expect(capturedInit?.credentials).toBe("omit");
    expect(capturedInit?.cache).toBe("no-store");
    expect(capturedInit?.referrerPolicy).toBe("no-referrer");
    expect((capturedInit?.headers as Record<string, string>)?.["x-test"]).toBe("1");
  });
});
