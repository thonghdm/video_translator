/**
 * SubTrans Extension — Quản lý danh sách phụ đề
 * Tái sử dụng logic từ frontend/src/lib/subtitles.ts và mở rộng cho Extension.
 */

import type { Cue, SubtitleItem } from "./types";
import { isIgnoredSubtitle } from "./text";

export type { SubtitleItem };

/**
 * Chuyển danh sách Cue thô sang danh sách SubtitleItem chuẩn hoá
 */
export function cuesToItems(cues: Cue[]): SubtitleItem[] {
  return cues.map((cue, idx) => ({
    id: idx,
    block: 0,
    start_sec: cue.start,
    end_sec: cue.end,
    source_text: cue.text,
    target_text: "",
    translated: false,
    engine: null,
    ignored: isIgnoredSubtitle(cue.text),
  }));
}

/**
 * Đường nhanh: mọi phần tử incoming đã tồn tại trong existing (cùng id và cùng start_sec)
 * -> chỉ thay thế tại chỗ trên bản sao, không cần dựng Map hay sort lại.
 * Trả về null nếu có phần tử thực sự mới / đổi start_sec (khi đó rơi về nhánh merge + sort đầy đủ).
 */
export function tryReplaceInPlace(
  existing: SubtitleItem[],
  incoming: SubtitleItem[]
): SubtitleItem[] | null {
  const positions: number[] = [];
  for (const item of incoming) {
    let lo = 0;
    let hi = existing.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (existing[mid].start_sec < item.start_sec) lo = mid + 1;
      else hi = mid;
    }
    let found = -1;
    for (let j = lo; j < existing.length && existing[j].start_sec === item.start_sec; j++) {
      if (existing[j].id === item.id) {
        found = j;
        break;
      }
    }
    if (found < 0) return null;
    positions.push(found);
  }
  const result = existing.slice();
  for (let i = 0; i < incoming.length; i++) {
    result[positions[i]] = incoming[i];
  }
  return result;
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

  const fast = tryReplaceInPlace(existing, incoming);
  if (fast) return fast;

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
