/**
 * SubTrans Extension — Circuit Breaker (Ngắt mạch bảo vệ dịch thuật)
 * Port 1:1 từ breaker.go
 */

export interface BreakerConfig {
  baseBackoffMs: number; // Mặc định 1 phút: thời gian khóa cơ sở cho exponential backoff
  maxBackoffMs: number; // Mặc định 10 phút: trần thời gian khóa khi bị rate limit
  probeFailCooldownMs: number; // Mặc định 1 phút: thời gian khóa tiếp khi probe thất bại
  networkCooldownMs: number; // Mặc định 2 phút: thời gian khóa khi gặp 3 lỗi mạng liên tiếp
  consecutiveFailThreshold: number; // Mặc định 3: số lỗi mạng liên tiếp kích hoạt khóa
  maxBackoffStep: number; // Mặc định 6: số bậc lũy thừa tối đa (1m, 2m, 4m, 8m, 16m->10m, 32m->10m)
}

export function defaultBreakerConfig(): BreakerConfig {
  return {
    baseBackoffMs: 60 * 1000,
    maxBackoffMs: 10 * 60 * 1000,
    probeFailCooldownMs: 60 * 1000,
    networkCooldownMs: 2 * 60 * 1000,
    consecutiveFailThreshold: 3,
    maxBackoffStep: 6,
  };
}

export interface BreakerSnapshot {
  blockedUntil: number;
  fails: number;
  backoffStep: number;
}

/**
 * Kết quả của một request, đã được phân loại sẵn (Phase 2: engines/errors.ts → classifyErr).
 * Breaker KHÔNG tự đoán loại lỗi bằng cách dò chuỗi message (dễ phân loại sai).
 * Ánh xạ với breaker.go:
 * - "ok"                → err == nil
 * - "canceled", "empty" → context.Canceled / errEmptyTranslation: bỏ qua
 * - "blocked"           → ErrRateLimited (429/403/503, captcha), kèm retryAfterMs nếu có
 * - "network", "other"  → nhánh default (lỗi mạng, timeout, HTTP lỗi khác)
 */
export type BreakerOutcome =
  | { kind: "ok" }
  | { kind: "canceled" }
  | { kind: "empty" }
  | { kind: "blocked"; retryAfterMs?: number }
  | { kind: "network" }
  | { kind: "other" };

export const OUTCOME_OK: BreakerOutcome = { kind: "ok" };

export class CircuitBreaker {
  private blockedUntil = 0;
  private probing = false;
  private fails = 0;
  private backoffStep = 0;
  private readonly config: BreakerConfig;
  private readonly now: () => number;

  constructor(cfg: Partial<BreakerConfig> = {}, nowFn: () => number = Date.now) {
    this.config = {
      baseBackoffMs: cfg.baseBackoffMs && cfg.baseBackoffMs > 0 ? cfg.baseBackoffMs : 60 * 1000,
      maxBackoffMs: cfg.maxBackoffMs && cfg.maxBackoffMs > 0 ? cfg.maxBackoffMs : 10 * 60 * 1000,
      probeFailCooldownMs:
        cfg.probeFailCooldownMs && cfg.probeFailCooldownMs > 0
          ? cfg.probeFailCooldownMs
          : 60 * 1000,
      networkCooldownMs:
        cfg.networkCooldownMs && cfg.networkCooldownMs > 0 ? cfg.networkCooldownMs : 2 * 60 * 1000,
      consecutiveFailThreshold:
        cfg.consecutiveFailThreshold && cfg.consecutiveFailThreshold > 0
          ? cfg.consecutiveFailThreshold
          : 3,
      maxBackoffStep:
        cfg.maxBackoffStep && cfg.maxBackoffStep > 0 ? cfg.maxBackoffStep : 6,
    };
    this.now = nowFn;
  }

  /**
   * Blocked chỉ đọc trạng thái khóa (read-only, zero side-effect).
   * Tuyệt đối không tiêu tốn lượt probe trong trạng thái Half-Open khi UI hoặc Scheduler truy vấn.
   */
  public blocked(): boolean {
    return this.blockedUntil !== 0 && this.now() < this.blockedUntil;
  }

  /**
   * Allow kiểm tra và cấp quyền gửi request tới nhà cung cấp dịch vụ.
   * - Closed (bình thường): allowed = true, isProbe = false.
   * - Open (đang bị khóa): allowed = false, isProbe = false.
   * - Half-Open (vừa hết cooldown): duy nhất 1 caller nhận allowed = true, isProbe = true; các caller khác nhận false, false.
   */
  public allow(): { allowed: boolean; isProbe: boolean } {
    if (this.blockedUntil === 0) {
      return { allowed: true, isProbe: false };
    }
    if (this.now() < this.blockedUntil) {
      return { allowed: false, isProbe: false };
    }
    if (!this.probing) {
      this.probing = true;
      return { allowed: true, isProbe: true };
    }
    return { allowed: false, isProbe: false };
  }

  /**
   * Report cập nhật trạng thái breaker sau khi thực hiện request.
   * Luôn giải phóng cờ probe khi isProbe == true.
   */
  public report(outcome: BreakerOutcome, isProbe: boolean): void {
    if (isProbe) {
      this.probing = false;
    }

    if (outcome.kind === "ok") {
      this.fails = 0;
      if (isProbe) {
        // Chỉ reset breaker và backoff khi request probe thành công
        this.blockedUntil = 0;
        this.backoffStep = 0;
      }
      return;
    }

    // Tua video / hủy tác vụ hoặc câu dịch rỗng: không phải lỗi của nhà cung cấp
    if (outcome.kind === "canceled" || outcome.kind === "empty") {
      return;
    }

    if (outcome.kind === "blocked") {
      // Nếu breaker đã bị khóa hoặc đang half-open (blockedUntil != 0) và không phải probe thì bỏ qua
      if (!isProbe && this.blockedUntil !== 0) {
        return;
      }

      const retryAfterMs = outcome.retryAfterMs;
      if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        let dur = retryAfterMs;
        // Đặt sàn tối thiểu 15s để tránh đóng-mở liên tục nếu Retry-After quá ngắn
        if (dur < 15 * 1000) {
          dur = 15 * 1000;
        }
        if (dur > this.config.maxBackoffMs) {
          dur = this.config.maxBackoffMs;
        }

        if (isProbe) {
          this.backoffStep = Math.min(this.backoffStep + 1, this.config.maxBackoffStep);
          let expDur = this.config.baseBackoffMs * (1 << (this.backoffStep - 1));
          if (expDur > this.config.maxBackoffMs || expDur <= 0) {
            expDur = this.config.maxBackoffMs;
          }
          if (expDur > dur) {
            dur = expDur;
          }
          this.blockedUntil = this.now() + dur;
          return;
        }

        if (this.backoffStep < 1) {
          this.backoffStep = 1;
        }
        this.blockedUntil = this.now() + dur;
        return;
      }

      // Exponential backoff thông thường: Bậc 1: 1m, Bậc 2: 2m, Bậc 3: 4m, Bậc 4: 8m, Bậc 5: 16m (cap 10m)...
      this.backoffStep = Math.min(this.backoffStep + 1, this.config.maxBackoffStep);
      let dur = this.config.baseBackoffMs * (1 << (this.backoffStep - 1));
      if (dur > this.config.maxBackoffMs || dur <= 0) {
        dur = this.config.maxBackoffMs;
      }
      this.blockedUntil = this.now() + dur;
      return;
    }

    // "network" | "other": lỗi mạng, timeout, HTTP lỗi khác (nhánh default của Go)
    if (isProbe) {
      this.blockedUntil = this.now() + this.config.probeFailCooldownMs;
    } else {
      this.fails++;
      if (this.fails >= this.config.consecutiveFailThreshold) {
        this.blockedUntil = this.now() + this.config.networkCooldownMs;
        this.fails = 0;
      }
    }
  }

  public getBlockedUntil(): number {
    return this.blockedUntil;
  }

  public getBackoffStep(): number {
    return this.backoffStep;
  }

  public getFails(): number {
    return this.fails;
  }

  /** Chỉ dùng cho test: cờ probe half-open đang được giữ hay không */
  public isProbing(): boolean {
    return this.probing;
  }

  public getConfig(): BreakerConfig {
    return { ...this.config };
  }

  public snapshot(): BreakerSnapshot {
    return {
      blockedUntil: this.blockedUntil,
      fails: this.fails,
      backoffStep: this.backoffStep,
    };
  }

  public restore(snapshot: BreakerSnapshot): void {
    this.blockedUntil = snapshot.blockedUntil || 0;
    this.fails = snapshot.fails || 0;
    this.backoffStep = snapshot.backoffStep || 0;
    this.probing = false;
  }
}
