/**
 * SubTrans Extension — HTTP Client bảo mật cho các API dịch thuật
 * Bắt buộc tuân thủ Quy tắc bất biến Mục 3.4 trong PLAN.md
 */

/**
 * apiFetch thực thi fetch với các cấu hình bảo mật bắt buộc:
 * - credentials: "omit" (KHÔNG gửi cookie Google của người dùng để tránh bị gắn bot/CAPTCHA)
 * - cache: "no-store"
 * - referrerPolicy: "no-referrer"
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const enforcedInit: RequestInit = {
    ...init,
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  };
  return fetch(input, enforcedInit);
}

/**
 * Tạo Signal kết hợp giữa timeoutMs và caller signal (nếu có).
 */
export function createTimeoutSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout sau ${timeoutMs}ms`));
  }, timeoutMs);

  let onCallerAbort: (() => void) | undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      onCallerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}
