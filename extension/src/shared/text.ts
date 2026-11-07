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
 * Giải mã các HTML entities thông dụng trong timedtext của YouTube
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
