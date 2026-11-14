export const UNREAD_UPDATE_KEY = "unreadUpdate";

export interface UnreadUpdate {
  version: string;
  previousVersion: string;
}

export function parseUnreadUpdate(value: unknown): UnreadUpdate | null {
  if (!value || typeof value !== "object") return null;
  const update = value as Partial<UnreadUpdate>;
  return typeof update.version === "string" && update.version.length > 0 &&
    typeof update.previousVersion === "string"
    ? { version: update.version, previousVersion: update.previousVersion }
    : null;
}

// Add an entry here with each release; unknown versions still show the update notice.
const CHANGELOG: Record<string, readonly string[]> = {
  "0.1.2": [
    "Thông báo nội dung cập nhật ngay trong popup.",
    "Hướng dẫn tải lại trang khi tiện ích mất kết nối sau cập nhật.",
  ],
};

export function changelogFor(version: string): readonly string[] {
  return CHANGELOG[version] ?? ["SubTrans đã được cập nhật lên phiên bản mới."];
}
