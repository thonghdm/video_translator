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
 * Phân loại lỗi trả về ErrKind chuẩn theo hợp đồng dữ liệu Mục 6.1
 * Port từ classifyErr trong translator.go:434
 */
export function classifyErr(err: unknown): ErrKind {
  if (!err) {
    return "other";
  }

  // 1. Hủy bởi người dùng (signal bị abort hoặc CanceledError)
  if (
    (err as CanceledError).isCanceled === true ||
    (err as Error).name === "AbortError" ||
    (err as Error).name === "CanceledError" ||
    (typeof (err as Error).message === "string" &&
      ((err as Error).message.toLowerCase().includes("abort") ||
        (err as Error).message.toLowerCase().includes("canceled")))
  ) {
    return "canceled";
  }

  // 2. Rate limit (429 / 403 / 503)
  if (
    (err as RateLimitedError).isRateLimit === true ||
    (err as Error).name === "RateLimitedError" ||
    (typeof (err as Error).message === "string" &&
      ((err as Error).message.includes("429") ||
        (err as Error).message.toLowerCase().includes("rate limit")))
  ) {
    return "blocked";
  }

  // 3. Bị vô hiệu hoá (chưa cấu hình API key)
  if (
    (err as DisabledError).isDisabled === true ||
    (err as Error).name === "DisabledError"
  ) {
    return "disabled";
  }

  // 4. Lỗi mạng thuần túy (fetch throw TypeError do mất mạng/DNS, hoặc NetworkError)
  if (
    (err as NetworkError).isNetwork === true ||
    (err as Error).name === "NetworkError" ||
    err instanceof TypeError // Standard fetch network failure
  ) {
    return "network";
  }

  // 5. Timeout (AbortController do timeout) coi là "other", giống Go DeadlineExceeded là other
  return "other";
}

/**
 * Chuyển đổi lỗi sang BreakerOutcome cho CircuitBreaker.report
 */
export function errToBreakerOutcome(err: unknown): BreakerOutcome {
  if (!err) return { kind: "ok" };
  if (err instanceof EmptyTranslationError) return { kind: "empty" };
  const kind = classifyErr(err);
  if (kind === "blocked") {
    const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
    return { kind: "blocked", retryAfterMs };
  }
  if (kind === "canceled") return { kind: "canceled" };
  if (kind === "network") return { kind: "network" };
  return { kind: "other" };
}

