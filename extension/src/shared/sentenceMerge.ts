/**
 * SubTrans Extension — Gộp các đoạn phụ đề ASR (Auto-generated) thành câu hoàn chỉnh
 * Phù hợp với đặc tả tại Mục 7 (Phase 1 & Phase 5) của PLAN.md
 */

import type { Cue } from "./types";

export interface MergeAsrOptions {
  maxGapSec?: number; // Khoảng lặng tối đa giữa 2 cue (mặc định 1.2s)
  maxDurSec?: number; // Độ dài thời gian tối đa của 1 câu gộp (mặc định 7s)
  maxChars?: number;  // Độ dài ký tự tối đa của 1 câu gộp (mặc định 120 ký tự)
}

const SENTENCE_END_RE = /[.?!…]["']?\s*$/;

/**
 * Gộp các cue ASR liên tiếp thành câu mạch lạc hơn.
 * Ngắt nhóm khi:
 * 1. Cue trước đó kết thúc bằng dấu câu (. ? ! …)
 * 2. Khoảng lặng giữa 2 cue vượt quá maxGapSec
 * 3. Thêm cue tiếp theo làm tổng thời lượng vượt quá maxDurSec hoặc tổng ký tự vượt maxChars
 */
export function mergeAsrCues(
  cues: Cue[],
  opts: MergeAsrOptions = {}
): Cue[] {
  if (cues.length === 0) {
    return [];
  }

  const maxGapSec = opts.maxGapSec ?? 1.2;
  const maxDurSec = opts.maxDurSec ?? 7;
  const maxChars = opts.maxChars ?? 120;

  const merged: Cue[] = [];
  let curStart = cues[0].start;
  let curEnd = cues[0].end;
  let curText = cues[0].text.trim();

  for (let i = 1; i < cues.length; i++) {
    const cue = cues[i];
    const nextText = cue.text.trim();
    if (!nextText) {
      continue;
    }

    const prevEndedSentence = SENTENCE_END_RE.test(curText);
    const gap = cue.start - curEnd;
    const isGapExceeded = gap > maxGapSec;
    const wouldExceedDur = cue.end - curStart > maxDurSec;
    const combinedLength = curText.length + 1 + nextText.length;
    const wouldExceedChars = combinedLength > maxChars;

    if (prevEndedSentence || isGapExceeded || wouldExceedDur || wouldExceedChars) {
      merged.push({
        start: curStart,
        end: curEnd,
        text: curText,
      });
      curStart = cue.start;
      curEnd = cue.end;
      curText = nextText;
    } else {
      curEnd = Math.max(curEnd, cue.end);
      curText = `${curText} ${nextText}`;
    }
  }

  if (curText) {
    merged.push({
      start: curStart,
      end: curEnd,
      text: curText,
    });
  }

  return merged;
}
