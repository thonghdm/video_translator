/**
 * SubTrans Extension — Client điều phối xin phụ đề Google Drive trong Frame Video
 * Phase 9.5 D5
 */

import type { B2C, C2B } from "../../shared/messages";
import type {
  SidecarFailReason,
  SidecarFile,
  SidecarMode,
} from "../../shared/driveTypes";

type Req = Extract<C2B, { type: "drive.sidecar" }>;
type Res = Extract<B2C, { type: "drive.sidecar.result" }>;

export type SidecarClientResult =
  | {
      ok: true;
      mode: SidecarMode;
      en?: SidecarFile;
      vi?: SidecarFile;
      bi?: SidecarFile;
    }
  | { ok: false; reason: SidecarFailReason };

export interface SidecarClientDeps {
  request(msg: Req): Promise<Res>;
  sleep(ms: number, signal: AbortSignal): Promise<void>; // reject khi abort
  newReqId(): string;
}

export const SIDECAR_RETRY_DELAY_MS = 2000;
export const SIDECAR_TOTAL_TIMEOUT_MS = 12000;

/**
 * Hàm sleep có hỗ trợ AbortSignal, reject AbortError khi signal bị abort.
 */
export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Gửi yêu cầu tìm và tải phụ đề sidecar từ Background Service Worker:
 * - Thử lần 1. Nếu index_unavailable hoặc no_match với indexed === 0 → sleep(2000) → thử lại đúng 1 lần với reqId mới.
 * - Toàn bộ bọc trong timeout 12s; hết giờ → { ok: false, reason: "timeout" }.
 * - signal bị abort → reject AbortError (caller sẽ bỏ qua).
 * - request ném lỗi (port đóng/timeout) → { ok: false, reason: "network" }.
 */
export async function requestSidecar(
  videoDocId: string | undefined,
  deps: SidecarClientDeps,
  signal: AbortSignal
): Promise<SidecarClientResult> {
  if (signal.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), SIDECAR_TOTAL_TIMEOUT_MS);
  });

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const runRequest = async (): Promise<SidecarClientResult> => {
    // Lần 1
    let res: Res;
    try {
      res = await deps.request({
        type: "drive.sidecar",
        reqId: deps.newReqId(),
        videoDocId,
      });
    } catch {
      return { ok: false, reason: "network" };
    }

    if (res.ok) {
      return {
        ok: true,
        mode: res.mode,
        en: res.en,
        vi: res.vi,
        bi: res.bi,
      };
    }

    // Nếu index_unavailable, hoặc no_match với indexed === 0 → sleep(2000) → gửi lại đúng 1 lần
    const shouldRetry =
      res.reason === "index_unavailable" ||
      (res.reason === "no_match" && res.indexed === 0);

    if (!shouldRetry) {
      return { ok: false, reason: res.reason };
    }

    if (signal.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    await deps.sleep(SIDECAR_RETRY_DELAY_MS, signal);

    if (signal.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    // Lần 2 (với reqId mới)
    let res2: Res;
    try {
      res2 = await deps.request({
        type: "drive.sidecar",
        reqId: deps.newReqId(),
        videoDocId,
      });
    } catch {
      return { ok: false, reason: "network" };
    }

    if (res2.ok) {
      return {
        ok: true,
        mode: res2.mode,
        en: res2.en,
        vi: res2.vi,
        bi: res2.bi,
      };
    }
    return { ok: false, reason: res2.reason };
  };

  try {
    return await Promise.race([runRequest(), timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    // signal là của scope video (sống lâu) → gỡ listener, không tích lũy qua mỗi lần xin phụ đề
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
