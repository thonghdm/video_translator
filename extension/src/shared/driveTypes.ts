/**
 * SubTrans Extension — Kiểu dữ liệu và hợp đồng cho tính năng Google Drive Sidecar
 * Phase 9.5 D2
 */

export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;

export type SidecarFailReason =
  | "disabled"
  | "not_drive"
  | "index_unavailable"
  | "no_match"
  | "ambiguous"
  | "not_permitted"
  | "not_found"
  | "too_large"
  | "timeout"
  | "bad_format"
  | "network";

export type DriveLookupReq = { type: "drive.lookup"; videoDocId?: string };

export type DriveLookupRes =
  | { ok: true; indexed: number; result: "match"; id: string; name: string }
  | { ok: true; indexed: number; result: "none" | "ambiguous" }
  | { ok: false };

/**
 * Type guard kiểm tra message có phải là DriveLookupReq hợp lệ không:
 * - type đúng là "drive.lookup"
 * - videoDocId (nếu có) phải là string khớp DRIVE_ID_RE
 */
export function isDriveLookupReq(m: unknown): m is DriveLookupReq {
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    return false;
  }
  const obj = m as Record<string, unknown>;
  if (obj.type !== "drive.lookup") {
    return false;
  }
  if ("videoDocId" in obj && obj.videoDocId !== undefined) {
    if (typeof obj.videoDocId !== "string" || !DRIVE_ID_RE.test(obj.videoDocId)) {
      return false;
    }
  }
  return true;
}
