/**
 * SubTrans Extension — Tiện ích kiểm tra frame và trích xuất ID trên Google Drive
 * Phase 9.5 D4
 */

import { DRIVE_ID_RE } from "../../shared/driveTypes";

/**
 * Tên tham số query chứa ID file video trong URL của iframe preview (từ khảo sát D0).
 * Rỗng nếu T2 âm tính (không có query param cố định).
 */
export const DOC_ID_PARAM = "";

/**
 * Kiểm tra xem window hiện tại có phải là top frame của Google Drive hay không.
 */
export function isDriveTopFrame(win: Window): boolean {
  try {
    return win.top === win && win.location.hostname === "drive.google.com";
  } catch {
    return false;
  }
}

/**
 * Kiểm tra xem window hiện tại có phải là iframe phát video của Google Drive hay không.
 * Điều kiện: không phải top frame và ancestorOrigins chứa "https://drive.google.com".
 */
export function isDrivePlayerFrame(win: Window): boolean {
  try {
    if (win.top === win) return false;
    const origins = win.location.ancestorOrigins;
    if (!origins) return false;
    if (typeof origins.contains === "function") {
      return origins.contains("https://drive.google.com");
    }
    for (let i = 0; i < origins.length; i++) {
      if (origins[i] === "https://drive.google.com") return true;
    }
    return false;
  } catch {
    return false;
  }
}

const FOLDER_ID_RE = /\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,128})(?:[/?#]|$)/;

/**
 * Trích xuất folder ID từ URL Google Drive (/drive/(u/\d+/)?folders/{id}).
 * Trả về ID nếu hợp lệ và khớp DRIVE_ID_RE, ngược lại trả về null.
 */
export function getFolderId(url: string): string | null {
  try {
    const parsed = new URL(url, "https://drive.google.com");
    const match = parsed.pathname.match(FOLDER_ID_RE);
    if (!match) return null;
    const id = match[1];
    return DRIVE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

const FILE_PATH_RE = /\/file\/d\/([A-Za-z0-9_-]{10,128})(?:[/?#]|$)/;

/**
 * Trích xuất id file video từ URL của frame player.
 * Thứ tự: pathname `/file/d/{id}/...` (D0-T2: iframe preview của Drive có dạng `/file/d/<id>/preview`)
 * → query DOC_ID_PARAM (nếu có) → query `docid` (player YouTube embed của Drive).
 * Mọi giá trị phải khớp DRIVE_ID_RE, nếu không → null.
 */
export function getVideoDocId(url: string): string | null {
  try {
    const parsed = new URL(url, "https://drive.google.com");
    const m = parsed.pathname.match(FILE_PATH_RE);
    if (m && DRIVE_ID_RE.test(m[1])) return m[1];
    for (const key of [DOC_ID_PARAM, "docid"]) {
      if (!key) continue;
      const val = parsed.searchParams.get(key);
      if (val && DRIVE_ID_RE.test(val)) return val;
    }
    return null;
  } catch {
    return null;
  }
}
