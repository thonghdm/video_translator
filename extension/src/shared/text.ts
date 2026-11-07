/**
 * SubTrans Extension — Xử lý văn bản (Text Utilities)
 * Port 1:1 từ translator.go và các hàm tiện ích tiếng Việt
 */

const VIETNAMESE_REGEX = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/i;

/**
 * Kiểm tra xem một dòng phụ đề có phải là tiếng động hoặc nốt nhạc cần bỏ qua hay không.
 * Port 1:1 từ isIgnoredSubtitle trong translator.go:1022
 */
export function isIgnoredSubtitle(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") {
    return true;
  }

  // Chỉ loại dòng nằm trọn vẹn trong ngoặc [...] hoặc (...)
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    return true;
  }

  // Chỉ loại khi toàn bộ chuỗi chỉ gồm nốt nhạc và dấu cách/gạch nối
  if (/^[♪\s\-_]+$/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Chuẩn hoá khoảng trắng trong một dòng, tương đương strings.Fields trong Go
 */
export function normalizeLine(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Kiểm tra xem một chuỗi có chứa ký tự tiếng Việt có dấu hay không
 */
export function isVietnamese(s: string): boolean {
  return VIETNAMESE_REGEX.test(s);
}

/**
 * Giải mã các HTML entities thông dụng trong timedtext của YouTube.
 * `&amp;` được giải mã CUỐI CÙNG để không giải mã 2 lần ("&amp;lt;" -> "&lt;", không phải "<").
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (m, n: string) => safeCodePoint(parseInt(n, 10), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(cp: number, fallback: string): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback;
  }
}
