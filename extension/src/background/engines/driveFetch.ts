/**
 * SubTrans Extension — Tải phụ đề từ Google Drive trong Service Worker
 * Phase 9.5 D3 — Ngoại lệ bảo mật duy nhất cho phép credentials: "include"
 */

import { DRIVE_ID_RE } from "../../shared/driveTypes";
import { createTimeoutSignal } from "./http";

export const DRIVE_FETCH_HOSTS: readonly string[] = [
  "drive.google.com",
  "drive.usercontent.google.com",
] as const;

export const DRIVE_MAX_BYTES = 1024 * 1024; // 1 MB
export const DRIVE_FETCH_TIMEOUT_MS = 8000; // 8s

export type DriveFetchResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_permitted"
        | "too_large"
        | "timeout"
        | "network";
    };

/**
 * Giải mã bytes của file phụ đề:
 * - Hỗ trợ BOM UTF-16LE / UTF-16BE / UTF-8
 * - Tự động phát hiện và fallback sang windows-1252 nếu UTF-8 bị lỗi ký tự > 1%
 */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    // UTF-16LE: FF FE
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes);
    }
    // UTF-16BE: FE FF
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes);
    }
  }

  // UTF-8 có BOM: EF BB BF
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }

  // Mặc định giải mã UTF-8
  const utf8Text = new TextDecoder("utf-8").decode(bytes);

  // Đếm ký tự thay thế \uFFFD (ký tự lỗi UTF-8)
  let replacementCount = 0;
  for (let i = 0; i < utf8Text.length; i++) {
    if (utf8Text.charCodeAt(i) === 0xfffd) {
      replacementCount++;
    }
  }

  // Nếu số ký tự lỗi > 1% thì giải mã lại bằng windows-1252
  if (utf8Text.length > 0 && replacementCount / utf8Text.length > 0.01) {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch {
      return utf8Text;
    }
  }

  return utf8Text;
}

/**
 * Tải nội dung text của file phụ đề từ Google Drive:
 * - Chạy duy nhất trong Service Worker với credentials: "include"
 * - Chỉ chấp nhận id khớp DRIVE_ID_RE
 * - Giới hạn kích thước tối đa 1 MB, timeout 8s
 * - Kiểm tra host sau redirect và từ chối nội dung HTML/đăng nhập
 */
export async function driveFetchText(
  id: string,
  fetchFn: typeof fetch = fetch
): Promise<DriveFetchResult> {
  if (!DRIVE_ID_RE.test(id)) {
    throw new Error("Invalid Drive file ID");
  }

  const { signal, cleanup } = createTimeoutSignal(DRIVE_FETCH_TIMEOUT_MS);

  try {
    const url = `https://drive.google.com/uc?export=download&id=${id}`;
    const res = await fetchFn(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "follow",
      signal,
    });

    if (res.status === 404) {
      return { ok: false, reason: "not_found" };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "not_permitted" };
    }
    if (!res.ok) {
      return { ok: false, reason: "network" };
    }

    // Kiểm tra host sau redirect
    try {
      const finalHost = new URL(res.url).hostname;
      if (!DRIVE_FETCH_HOSTS.includes(finalHost)) {
        return { ok: false, reason: "not_permitted" };
      }
    } catch {
      return { ok: false, reason: "not_permitted" };
    }

    // Trang HTML (đăng nhập / thông báo lỗi của Google) → từ chối NGAY, không đọc body
    const contentType = res.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("text/html")) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "not_permitted" };
    }

    // Đọc body dạng stream, tối đa DRIVE_MAX_BYTES
    let bytes: Uint8Array;
    const reader = res.body?.getReader();
    if (!reader) {
      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength > DRIVE_MAX_BYTES) {
        return { ok: false, reason: "too_large" };
      }
      bytes = new Uint8Array(arrayBuf);
    } else {
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.length;
          if (totalBytes > DRIVE_MAX_BYTES) {
            await reader.cancel();
            return { ok: false, reason: "too_large" };
          }
          chunks.push(value);
        }
      }
      bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
    }

    const text = decodeSubtitleBytes(bytes);

    const trimmedHead = text.trimStart().toLowerCase();
    if (trimmedHead.startsWith("<!doctype") || trimmedHead.startsWith("<html")) {
      return { ok: false, reason: "not_permitted" };
    }

    return { ok: true, text };
  } catch (err: unknown) {
    if (signal.aborted || (err as Error)?.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network" };
  } finally {
    cleanup();
  }
}
