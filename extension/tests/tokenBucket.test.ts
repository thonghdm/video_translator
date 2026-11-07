import { describe, it, expect } from "vitest";
import { TokenBucket } from "../src/shared/tokenBucket";

describe("TokenBucket (Port từ gemini_test.go)", () => {
  it("ưu tiên token cho Tier-1: Tier-2 cần >= 3.0 token, Tier-1 cần >= 1.0 token", () => {
    let mockTime = 1000000;
    const tb = new TokenBucket(10, () => mockTime);

    // Khởi tạo có 10 token -> rút bớt còn 2 token bằng snapshot/restore
    tb.restore({ tokens: 2.0, lastRefillMs: mockTime });

    // Tier-2 thử lấy token: phải thất bại vì cần >= 3.0 token (để dự trữ cho Tier-1)
    expect(tb.tryAcquire(false)).toBe(false);

    // Tier-1 thử lấy token: thành công vì chỉ cần >= 1.0 token
    expect(tb.tryAcquire(true)).toBe(true);

    // Giờ còn 1 token: Tier-1 vẫn lấy được nốt
    expect(tb.tryAcquire(true)).toBe(true);

    // Giờ còn 0 token: cả 2 đều không lấy được
    expect(tb.tryAcquire(true)).toBe(false);
    expect(tb.tryAcquire(false)).toBe(false);
  });

  it("nạp lại token theo thời gian dựa vào RPM", () => {
    let mockTime = 1000000;
    // RPM = 60 -> 1 token mỗi giây (1 token / 1000ms)
    const tb = new TokenBucket(60, () => mockTime);

    tb.restore({ tokens: 0, lastRefillMs: mockTime });
    expect(tb.hasTokens()).toBe(false);

    // Thời gian trôi qua 1000ms -> nạp được 1 token
    mockTime += 1000;
    expect(tb.hasTokens()).toBe(true);
    expect(tb.tryAcquire(true)).toBe(true);
    expect(tb.hasTokens()).toBe(false);
  });

  it("acquire: chờ lấy token thành công khi thời gian trôi qua", async () => {
    let mockTime = 1000000;
    const tb = new TokenBucket(60, () => mockTime);
    tb.restore({ tokens: 0, lastRefillMs: mockTime });

    // Cho thời gian tăng dần trong lúc acquire chờ
    const timer = setInterval(() => {
      mockTime += 200;
    }, 20);

    const acquired = await tb.acquire(true, 1000);
    clearInterval(timer);
    expect(acquired).toBe("ok");
  });

  it("acquire: trả về \"aborted\" khi bị abort bởi AbortSignal", async () => {
    let mockTime = 1000000;
    const tb = new TokenBucket(10, () => mockTime);
    tb.restore({ tokens: 0, lastRefillMs: mockTime });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const t0 = Date.now();
    const acquired = await tb.acquire(true, 1000, controller.signal);
    expect(acquired).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(500); // thức dậy ngay khi abort, không chờ hết 1000ms
  });

  it("acquire: signal đã abort từ trước -> \"aborted\" ngay, không tiêu token", async () => {
    const tb = new TokenBucket(12, () => 1_000_000);
    const c = new AbortController();
    c.abort();
    expect(await tb.acquire(true, 1000, c.signal)).toBe("aborted");
    expect(tb.getTokens()).toBe(12);
  });

  it("acquire: đồng hồ đứng yên + hết token -> \"timeout\" (không treo vòng lặp)", async () => {
    const frozen = 1_000_000;
    const tb = new TokenBucket(12, () => frozen);
    tb.restore({ tokens: 0, lastRefillMs: frozen });
    const t0 = Date.now();
    expect(await tb.acquire(false, 120)).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("snapshot và restore", () => {
    let mockTime = 1000000;
    const tb1 = new TokenBucket(12, () => mockTime);
    tb1.tryAcquire(true);
    const snap = tb1.snapshot();

    const tb2 = new TokenBucket(12, () => mockTime);
    tb2.restore(snap);
    expect(tb2.getTokens()).toBeCloseTo(tb1.getTokens(), 2);
  });
});
