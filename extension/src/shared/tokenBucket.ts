/**
 * SubTrans Extension — Token Bucket Rate Limiter
 * Port 1:1 từ TokenBucket trong gemini.go:58
 */

export interface TokenBucketSnapshot {
  tokens: number;
  lastRefillMs: number;
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
   * Trả về true nếu lấy thành công, false nếu hết timeout hoặc bị abort.
   */
  public async acquire(
    isTier1: boolean,
    waitMs = 3000,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (this.tryAcquire(isTier1)) {
      return true;
    }
    if (signal?.aborted) {
      return false;
    }

    const start = this.now();
    while (this.now() - start < waitMs) {
      if (signal?.aborted) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (this.tryAcquire(isTier1)) {
        return true;
      }
    }

    return false;
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
