/**
 * SubTrans Extension — Ghép phụ đề EN + VI theo thời gian (Phase 9.6 E2)
 * Hàm thuần toán, không DOM, không chrome API, không fetch, không Date.
 */

import type { SubtitleItem } from "./types";
import { parseSrtOrVtt } from "./subtitleFormat";

export interface PairStats {
  total: number;
  matched: number;
  ratio: number;
}

export interface SidecarFile {
  name: string;
  text: string;
}

export const PAIR_MIN_OVERLAP = 0.5; // Tỷ lệ chồng lấn tối thiểu (so với câu ngắn hơn)
export const PAIR_MIN_RATIO = 0.6; // Dưới ngưỡng này coi như 2 file lệch → không dùng VI

/**
 * Phân tích nội dung file VI thành các SubtitleItem ép kiểu tiếng Việt:
 * source_text = "", target_text = toàn bộ chữ của câu, translated = true, engine = "file".
 * Không lọc qua isVietnamese vì các câu không dấu (như "AWS", "OK") vẫn thuộc file VI.
 */
export function parseViForced(content: string): SubtitleItem[] {
  const cues = parseSrtOrVtt(content);
  return cues.map((cue, idx) => ({
    id: idx,
    block: 0,
    start_sec: cue.start,
    end_sec: cue.end,
    source_text: "",
    target_text: cue.text,
    translated: true,
    engine: "file",
  }));
}

/**
 * Ghép danh sách câu EN và VI theo độ chồng lấn thời gian (O(n + m) two-pointer).
 * - en: các câu từ file EN (đã sắp xếp theo start_sec)
 * - vi: các câu từ file VI (đã sắp xếp theo start_sec, thường lấy từ parseViForced)
 *
 * Bảo toàn: id, số lượng, thời gian, source_text của mảng EN không đổi.
 */
export function mergeEnVi(
  en: SubtitleItem[],
  vi: SubtitleItem[]
): { items: SubtitleItem[]; stats: PairStats } {
  if (en.length === 0) {
    return {
      items: [],
      stats: { total: 0, matched: 0, ratio: 0 },
    };
  }

  // Danh sách các đoạn text VI được gán vào từng câu EN (theo CHỈ SỐ GỐC của mảng EN)
  const viAssigned: string[][] = Array.from({ length: en.length }, () => []);

  // File .srt không bắt buộc sắp theo thời gian (có file đảo/chèn câu). Thuật toán 2 con trỏ cần cả hai
  // phía đã sắp xếp → sắp CHỈ SỐ của EN (không đổi mảng EN) và bản sao của VI; câu VI cùng thời điểm giữ thứ tự gốc.
  const enOrder = en.map((_, i) => i).sort((a, b) => en[a].start_sec - en[b].start_sec || a - b);
  const viSorted = vi
    .map((v, j) => ({ v, j }))
    .sort((a, b) => a.v.start_sec - b.v.start_sec || a.j - b.j)
    .map((x) => x.v);

  let enStart = 0;

  for (let j = 0; j < viSorted.length; j++) {
    const v = viSorted[j];
    const durB = v.end_sec - v.start_sec;
    if (durB <= 0) continue;

    // Bỏ qua các câu EN đã kết thúc trước khi câu VI bắt đầu
    while (enStart < enOrder.length && en[enOrder[enStart]].end_sec <= v.start_sec) {
      enStart++;
    }

    let bestOverlap = 0;
    let bestEnIdx = -1;

    for (let k = enStart; k < enOrder.length; k++) {
      const i = enOrder[k];
      const a = en[i];
      // Do en đã sắp xếp theo start_sec, nếu a.start_sec >= v.end_sec thì không câu EN nào phía sau có thể chồng lấn với v
      if (a.start_sec >= v.end_sec) {
        break;
      }

      const durA = a.end_sec - a.start_sec;
      if (durA <= 0) continue;

      const overlap = Math.max(
        0,
        Math.min(a.end_sec, v.end_sec) - Math.max(a.start_sec, v.start_sec)
      );
      const minDur = Math.min(durA, durB);
      if (minDur > 0 && overlap / minDur >= PAIR_MIN_OVERLAP) {
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestEnIdx = i;
        }
      }
    }

    if (bestEnIdx !== -1) {
      const text = (v.target_text || v.source_text || "").trim();
      if (text) {
        viAssigned[bestEnIdx].push(text);
      }
    }
  }

  let matchedCount = 0;
  const items: SubtitleItem[] = [];

  for (let i = 0; i < en.length; i++) {
    const a = en[i];
    const assigned = viAssigned[i];

    if (assigned && assigned.length > 0) {
      matchedCount++;
      items.push({
        id: a.id,
        block: a.block,
        start_sec: a.start_sec,
        end_sec: a.end_sec,
        source_text: a.source_text,
        target_text: assigned.join(" "),
        translated: true,
        engine: "file",
        ...(a.ignored !== undefined ? { ignored: a.ignored } : {}),
      });
    } else {
      // Giữ nguyên câu gốc: nếu đã song ngữ / dịch thì giữ nguyên, nếu chưa thì translated = false
      items.push({
        id: a.id,
        block: a.block,
        start_sec: a.start_sec,
        end_sec: a.end_sec,
        source_text: a.source_text,
        target_text: a.target_text,
        translated: a.translated,
        engine: a.engine,
        ...(a.ignored !== undefined ? { ignored: a.ignored } : {}),
      });
    }
  }

  const stats: PairStats = {
    total: en.length,
    matched: matchedCount,
    ratio: en.length === 0 ? 0 : matchedCount / en.length,
  };

  return { items, stats };
}
