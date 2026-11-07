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
    expect(acquired).toBe(true);
  });

  it("acquire: trả về false khi bị abort bởi AbortSignal", async () => {
    let mockTime = 1000000;
    const tb = new TokenBucket(10, () => mockTime);
    tb.restore({ tokens: 0, lastRefillMs: mockTime });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const acquired = await tb.acquire(true, 1000, controller.signal);
    expect(acquired).toBe(false);
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
