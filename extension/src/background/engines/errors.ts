/**
 * SubTrans Extension — Phân loại và định nghĩa các lỗi engine dịch
 * Port từ classifyErr và các định nghĩa lỗi trong translator.go / gemini.go
 */

import type { ErrKind } from "../../shared/types";
import type { BreakerOutcome } from "../../shared/breaker";

export class RateLimitedError extends Error {
  public readonly isRateLimit = true;
  public readonly retryAfterMs?: number;

  constructor(message = "Rate limited (429)", retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class NetworkError extends Error {
  public readonly isNetwork = true;

  constructor(message = "Network error") {
    super(message);
    this.name = "NetworkError";
  }
}

export class CanceledError extends Error {
  public readonly isCanceled = true;

  constructor(message = "Operation canceled") {
    super(message);
    this.name = "CanceledError";
  }
}

export class DisabledError extends Error {
  public readonly isDisabled = true;

  constructor(message = "Engine disabled or missing API key") {
    super(message);
    this.name = "DisabledError";
  }
}

export class EmptyTranslationError extends Error {
  constructor(message = "Empty translation result") {
    super(message);
    this.name = "EmptyTranslationError";
  }
}

export class InvalidResponseIdsError extends Error {
  constructor(message = "Invalid or duplicate IDs in LLM response") {
    super(message);
    this.name = "InvalidResponseIdsError";
  }
}

/**
 * Hết token trong bucket cục bộ (Go: ErrRateLimitedLocal).
 * KHÔNG phải lỗi của nhà cung cấp → không phạt breaker; router chuyển tầng.
 */
export class LocalRateLimitError extends Error {
  public readonly retryAfterMs?: number;

  constructor(message = "Local rate limit (out of tokens)", retryAfterMs?: number) {
    super(message);
    this.name = "LocalRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Hết hạn mức tháng của DeepL (HTTP 456).
 * Kế thừa RateLimitedError với retryAfterMs mặc định 6 giờ.
 */
export class DeepLQuotaError extends RateLimitedError {
  constructor(message = "DeepL quota exceeded (456)", retryAfterMs = 6 * 60 * 60 * 1000) {
    super(message, retryAfterMs);
    this.name = "DeepLQuotaError";
  }
}

/**
 * Phân loại lỗi trả về ErrKind (Mục 6.1). Port từ classifyErr trong translator.go:434.
 *
 * CHỈ dựa vào lớp lỗi (instanceof) do chính engine ném ra — KHÔNG dò chuỗi message và KHÔNG coi
 * mọi TypeError là lỗi mạng (TypeError cũng có thể là bug trong code). Việc đổi lỗi của fetch
 * thành NetworkError/CanceledError/timeout được làm ngay tại chỗ gọi apiFetch.
 */
export function classifyErr(err: unknown): ErrKind {
  if (err instanceof CanceledError) return "canceled";
  if (err instanceof RateLimitedError || err instanceof LocalRateLimitError) return "blocked";
  if (err instanceof DisabledError) return "disabled";
  if (err instanceof NetworkError) return "network";
  // Timeout, HTTP lỗi khác, JSON hỏng, ID sai, bug... → "other" (Go: nhánh default)
  return "other";
}

/**
 * Chuyển lỗi sang BreakerOutcome cho CircuitBreaker.report (chỉ dùng cho lỗi của NHÀ CUNG CẤP).
 * LocalRateLimitError không bao giờ được report (xem router/gemini).
 */
export function errToBreakerOutcome(err: unknown): BreakerOutcome {
  if (!err) return { kind: "ok" };
  if (err instanceof EmptyTranslationError) return { kind: "empty" };
  if (err instanceof CanceledError) return { kind: "canceled" };
  if (err instanceof RateLimitedError) return { kind: "blocked", retryAfterMs: err.retryAfterMs };
  if (err instanceof NetworkError) return { kind: "network" };
  return { kind: "other" };
}

/** retryAfterMs của lỗi (nếu có) */
export function retryAfterOf(err: unknown): number | undefined {
  if (err instanceof RateLimitedError || err instanceof LocalRateLimitError) return err.retryAfterMs;
  return undefined;
}
