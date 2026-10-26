export interface SubtitleItem {
  id: number;
  block: number;
  start_sec: number;
  end_sec: number;
  source_text: string;
  target_text: string;
  translated: boolean;
}

/**
 * Upsert các phụ đề mới vào danh sách hiện tại.
 * - Ghi đè các phần tử có cùng id (ví dụ khi bản dịch tiếng Việt cập nhật đè lên bản STT tiếng Anh).
 * - Luôn duy trì mảng được sắp xếp tăng dần theo start_sec.
 */
export function upsertSubtitles(
  existing: SubtitleItem[],
  incoming: SubtitleItem[]
): SubtitleItem[] {
  if (incoming.length === 0) {
    return existing;
  }

  const map = new Map<number, SubtitleItem>();

  // Nạp toàn bộ danh sách hiện tại vào map
  for (const item of existing) {
    map.set(item.id, item);
  }

  // Ghi đè hoặc chèn mới
  for (const item of incoming) {
    map.set(item.id, item);
  }

  // Chuyển lại thành mảng và sắp xếp theo start_sec
  const result = Array.from(map.values());
  result.sort((a, b) => a.start_sec - b.start_sec);

  return result;
}

/**
 * Tìm kiếm nhị phân phụ đề tương ứng với mốc thời gian currentTime (giây).
 * Phụ đề khớp khi: start_sec <= currentTime <= end_sec.
 */
export function findSubtitleAtTime(
  subtitles: SubtitleItem[],
  currentTime: number
): SubtitleItem | null {
  if (subtitles.length === 0) {
    return null;
  }

  let left = 0;
  let right = subtitles.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const item = subtitles[mid];

    if (currentTime >= item.start_sec && currentTime <= item.end_sec) {
      return item;
    }

    if (currentTime < item.start_sec) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return null;
}
