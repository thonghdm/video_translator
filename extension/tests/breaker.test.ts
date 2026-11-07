import { describe, it, expect } from "vitest";
import {
  CircuitBreaker,
  defaultBreakerConfig,
  OUTCOME_OK,
} from "../src/shared/breaker";

describe("CircuitBreaker (Port từ breaker_test.go)", () => {
  it("defaultBreakerConfig: cấu hình mặc định tương thích hoàn toàn với Go", () => {
    const cfg = defaultBreakerConfig();
    expect(cfg.baseBackoffMs).toBe(60 * 1000);
    expect(cfg.maxBackoffMs).toBe(10 * 60 * 1000);
    expect(cfg.probeFailCooldownMs).toBe(60 * 1000);
    expect(cfg.networkCooldownMs).toBe(2 * 60 * 1000);
    expect(cfg.consecutiveFailThreshold).toBe(3);
    expect(cfg.maxBackoffStep).toBe(6);
  });

  it("khởi tạo với config rỗng: tự động fallback về giá trị mặc định", () => {
    const cb = new CircuitBreaker({});
    const cfg = cb.getConfig();
    expect(cfg.baseBackoffMs).toBe(60 * 1000);
    expect(cfg.maxBackoffMs).toBe(10 * 60 * 1000);
    expect(cfg.probeFailCooldownMs).toBe(60 * 1000);
    expect(cfg.networkCooldownMs).toBe(2 * 60 * 1000);
    expect(cfg.consecutiveFailThreshold).toBe(3);
    expect(cfg.maxBackoffStep).toBe(6);

    cb.report({ kind: "blocked" }, false);
    expect(cb.blocked()).toBe(true);
  });

  it("nhiều lần 429 đồng thời: không nhảy vọt step", () => {
    let mockTime = 1000000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => mockTime);

    // 3 lần report rate limit liên tiếp từ trạng thái mở
    cb.report({ kind: "blocked" }, false);
    cb.report({ kind: "blocked" }, false);
    cb.report({ kind: "blocked" }, false);

    expect(cb.getBackoffStep()).toBe(1);
    expect(cb.blocked()).toBe(true);
    expect(cb.getBlockedUntil() - mockTime).toBe(60 * 1000);

    // Giả lập cooldown kết thúc, probe thất bại do 429 -> tăng step lên 2
    mockTime += 60 * 1000 + 1;
    cb.report({ kind: "blocked" }, true);
    expect(cb.getBackoffStep()).toBe(2);
    expect(cb.getBlockedUntil() - mockTime).toBe(2 * 60 * 1000);
  });

  it("cooldown đã hết nhưng request thường dính 429: không tăng step", () => {
    let mockTime = 1000000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => mockTime);

    // Bước 1: Khóa lần đầu
    cb.report({ kind: "blocked" }, false);
    expect(cb.getBackoffStep()).toBe(1);

    // Bước 2: Hết cooldown
    mockTime += 65 * 1000;
    expect(cb.blocked()).toBe(false);

    // Bước 3: Request thường gặp 429
    cb.report({ kind: "blocked" }, false);
    expect(cb.getBackoffStep()).toBe(1);

    // Bước 4: Request probe gặp 429 mới được tăng step lên 2
    cb.report({ kind: "blocked" }, true);
    expect(cb.getBackoffStep()).toBe(2);
  });

  it("exponential backoff: kiểm tra chính xác giá trị từng bậc và trần 10 phút", () => {
    let mockTime = 1000000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => mockTime);

    const expectedDurations = [
      1 * 60 * 1000,  // Step 1: 1m
      2 * 60 * 1000,  // Step 2: 2m
      4 * 60 * 1000,  // Step 3: 4m
      8 * 60 * 1000,  // Step 4: 8m
      10 * 60 * 1000, // Step 5: cap 10m
      10 * 60 * 1000, // Step 6: cap 10m
    ];

    for (let i = 0; i < expectedDurations.length; i++) {
      const isProbe = i > 0;
      cb.report({ kind: "blocked" }, isProbe);
      expect(cb.getBackoffStep()).toBe(i + 1);
      expect(cb.getBlockedUntil() - mockTime).toBe(expectedDurations[i]);
    }

    // Gọi thêm 5 lần nữa: step và duration vẫn bị cap ở 6 và 10 phút
    for (let i = 0; i < 5; i++) {
      cb.report({ kind: "blocked" }, true);
      expect(cb.getBackoffStep()).toBe(6);
      expect(cb.getBlockedUntil() - mockTime).toBe(10 * 60 * 1000);
    }
  });

  it("request cũ về muộn: không được phép mở breaker hay reset step", () => {
    const cb = new CircuitBreaker();
    cb.report({ kind: "blocked" }, false);
    expect(cb.blocked()).toBe(true);
    expect(cb.getBackoffStep()).toBe(1);

    // Request cũ về muộn thành công (isProbe = false)
    cb.report(OUTCOME_OK, false);
    expect(cb.blocked()).toBe(true);
    expect(cb.getBackoffStep()).toBe(1);
  });

  it("chỉ probe thành công mới được mở breaker và reset step", () => {
    let mockTime = 1000000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => mockTime);

    cb.report({ kind: "blocked" }, false);
    cb.report({ kind: "blocked" }, true);
    expect(cb.getBackoffStep()).toBe(2);

    // Hết cooldown
    mockTime += 2 * 60 * 1000 + 10;
    const { allowed, isProbe } = cb.allow();
    expect(allowed).toBe(true);
    expect(isProbe).toBe(true);

    // Probe thành công
    cb.report(OUTCOME_OK, isProbe);
    expect(cb.blocked()).toBe(false);
    expect(cb.getBackoffStep()).toBe(0);
  });

  it("retry-after có sàn tối thiểu 15s", () => {
    let mockTime = 1000000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => mockTime);

    // Retry-After 5s -> phải áp dụng sàn 15s
    cb.report({ kind: "blocked", retryAfterMs: 5000 }, false);
    expect(cb.getBlockedUntil() - mockTime).toBe(15000);
  });

  it("snapshot và restore: khôi phục chính xác trạng thái từ storage.session", () => {
    const cb1 = new CircuitBreaker();
    cb1.report({ kind: "blocked" }, false);
    const snap = cb1.snapshot();

    const cb2 = new CircuitBreaker();
    cb2.restore(snap);
    expect(cb2.blocked()).toBe(cb1.blocked());
    expect(cb2.getBackoffStep()).toBe(cb1.getBackoffStep());
    expect(cb2.getBlockedUntil()).toBe(cb1.getBlockedUntil());
  });

  // ===== Các case port thêm từ breaker_test.go (nhánh lỗi mạng / half-open) =====

  /** Đưa breaker về trạng thái "vừa hết cooldown" (half-open candidate) */
  function halfOpen(cb: CircuitBreaker, now: number) {
    cb.restore({ blockedUntil: now - 100, fails: 0, backoffStep: 1 });
  }

  it("ProbeFailure_Cooldown: probe gặp lỗi mạng -> khóa thêm 1 phút và nhả cờ probe", () => {
    const now = 1_000_000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => now);
    halfOpen(cb, now);

    const { allowed, isProbe } = cb.allow();
    expect(allowed).toBe(true);
    expect(isProbe).toBe(true);

    cb.report({ kind: "network" }, isProbe);
    expect(cb.isProbing()).toBe(false);
    expect(cb.blocked()).toBe(true);
    expect(cb.getBlockedUntil() - now).toBe(60 * 1000);
  });

  it("ConsecutiveNetworkFailures: 3 lỗi mạng liên tiếp -> khóa 2 phút, reset fails", () => {
    const now = 1_000_000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => now);

    cb.report({ kind: "network" }, false);
    expect(cb.blocked()).toBe(false);
    expect(cb.getFails()).toBe(1);

    cb.report({ kind: "other" }, false); // timeout / HTTP lỗi khác cũng đếm như Go
    expect(cb.blocked()).toBe(false);
    expect(cb.getFails()).toBe(2);

    cb.report({ kind: "network" }, false);
    expect(cb.blocked()).toBe(true);
    expect(cb.getFails()).toBe(0);
    expect(cb.getBlockedUntil() - now).toBe(2 * 60 * 1000);
  });

  it("thành công giữa chừng reset bộ đếm lỗi mạng", () => {
    const cb = new CircuitBreaker();
    cb.report({ kind: "network" }, false);
    cb.report({ kind: "network" }, false);
    cb.report(OUTCOME_OK, false);
    expect(cb.getFails()).toBe(0);
    cb.report({ kind: "network" }, false);
    expect(cb.blocked()).toBe(false);
  });

  it("IgnoredErrors: canceled và empty không đếm lỗi, không khóa", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 5; i++) {
      cb.report({ kind: "canceled" }, false);
      cb.report({ kind: "empty" }, false);
    }
    expect(cb.getFails()).toBe(0);
    expect(cb.blocked()).toBe(false);
  });

  it("Blocked_NeverConsumesProbe: gọi blocked() nhiều lần không tiêu tốn lượt probe", () => {
    const now = 1_000_000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => now);
    halfOpen(cb, now);

    for (let i = 0; i < 10_000; i++) {
      expect(cb.blocked()).toBe(false);
      expect(cb.isProbing()).toBe(false);
    }
    const { allowed, isProbe } = cb.allow();
    expect(allowed).toBe(true);
    expect(isProbe).toBe(true);
  });

  it("HalfOpen_SingleProbeAndRelease: chỉ 1 caller được probe, Report nhả cờ", () => {
    const now = 1_000_000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => now);
    halfOpen(cb, now);

    const a1 = cb.allow();
    expect(a1).toEqual({ allowed: true, isProbe: true });
    const a2 = cb.allow();
    expect(a2).toEqual({ allowed: false, isProbe: false });

    cb.report({ kind: "blocked" }, a1.isProbe);
    expect(cb.isProbing()).toBe(false);
  });

  it("probe bị canceled (tua video) vẫn nhả cờ probe và không đổi trạng thái khóa", () => {
    const now = 1_000_000;
    const cb = new CircuitBreaker(defaultBreakerConfig(), () => now);
    halfOpen(cb, now);
    const before = cb.getBlockedUntil();
    const { isProbe } = cb.allow();
    cb.report({ kind: "canceled" }, isProbe);
    expect(cb.isProbing()).toBe(false);
    expect(cb.getBlockedUntil()).toBe(before);
    expect(cb.allow()).toEqual({ allowed: true, isProbe: true });
  });
});
