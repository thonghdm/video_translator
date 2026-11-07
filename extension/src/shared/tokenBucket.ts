/**
 * SubTrans Extension — Token Bucket Rate Limiter
 * Port 1:1 từ TokenBucket trong gemini.go:58
 */

export interface TokenBucketSnapshot {
  tokens: number;
  lastRefillMs: number;
}

export type AcquireResult = "ok" | "timeout" | "aborted";

const POLL_MS = 40;

/** Ngủ ms mili-giây; trả về true nếu bị abort trong lúc ngủ (thức dậy ngay khi abort) */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TokenBucket {
  private capacity: number;
  private tokens: number;
  private fillRate: number; // Token nạp mỗi millisecond
  private lastRefillMs: number;
  private readonly now: () => number;

  constructor(rpm = 12, nowFn: () => number = Date.now) {
    if (rpm <= 0) {
      rpm = 12;
    }
    this.capacity = rpm;
    this.tokens = rpm;
    this.fillRate = rpm / 60000;
    this.now = nowFn;
    this.lastRefillMs = this.now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = current - this.lastRefillMs;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.fillRate);
      this.lastRefillMs = current;
    }
  }

  /**
   * Kiểm tra xem bucket hiện có ít nhất 1 token hay không
   */
  public hasTokens(): boolean {
    this.refill();
    return this.tokens >= 1.0;
  }

  /**
   * Kiểm tra và tiêu tốn 1 token.
   * - Tier-1 (ưu tiên): chỉ cần >= 1.0 token.
   * - Tier-2: bắt buộc >= 3.0 token (dự trữ ít nhất 2 token cho Tier-1).
   */
  public tryAcquire(isTier1: boolean): boolean {
    this.refill();
    const minTokens = isTier1 ? 1.0 : 3.0;
    if (this.tokens >= minTokens) {
      this.tokens -= 1.0;
      return true;
    }
    return false;
  }

  /**
   * Chờ lấy token trong khoảng waitMs (poll mỗi 40ms, giống Go).
   * Kết quả tách bạch như Go:
   * - "ok":      lấy được token
   * - "timeout": hết thời gian chờ (Go: ErrRateLimitedLocal) -> tầng sau xử lý, KHÔNG phạt breaker
   * - "aborted": bị hủy (Go: ctx.Err()) -> dừng ngay, không chuyển tầng
   * Số vòng chờ tính theo số lần poll (không phụ thuộc đồng hồ inject), nên không thể treo
   * khi test dùng đồng hồ giả đứng yên.
   */
  public async acquire(
    isTier1: boolean,
    waitMs = 3000,
    signal?: AbortSignal
  ): Promise<AcquireResult> {
    if (signal?.aborted) {
      return "aborted";
    }
    if (this.tryAcquire(isTier1)) {
      return "ok";
    }

    const maxPolls = Math.max(1, Math.ceil(waitMs / POLL_MS));
    for (let i = 0; i < maxPolls; i++) {
      const aborted = await sleep(POLL_MS, signal);
      if (aborted) {
        return "aborted";
      }
      if (this.tryAcquire(isTier1)) {
        return "ok";
      }
    }
    return "timeout";
  }

  /** Số ms ước tính cho tới khi đủ token (Tier-1 cần 1, Tier-2 cần 3) */
  public msUntilToken(isTier1: boolean): number {
    this.refill();
    const need = (isTier1 ? 1.0 : 3.0) - this.tokens;
    if (need <= 0) return 0;
    return Math.ceil(need / this.fillRate);
  }

  /** Đổi RPM khi người dùng sửa settings (giữ số token hiện có, cắt theo dung lượng mới) */
  public setRpm(rpm: number): void {
    if (!(rpm > 0)) return;
    this.refill();
    this.capacity = rpm;
    this.fillRate = rpm / 60000;
    this.tokens = Math.min(this.tokens, rpm);
  }

  public getTokens(): number {
    this.refill();
    return this.tokens;
  }

  public snapshot(): TokenBucketSnapshot {
    this.refill();
    return {
      tokens: this.tokens,
      lastRefillMs: this.lastRefillMs,
    };
  }

  public restore(s: TokenBucketSnapshot): void {
    this.tokens = Math.min(this.capacity, Math.max(0, s.tokens));
    this.lastRefillMs = s.lastRefillMs;
    this.refill();
  }
}
