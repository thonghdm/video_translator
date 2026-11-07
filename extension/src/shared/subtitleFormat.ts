/**
 * SubTrans Extension — Phân tích và tạo định dạng phụ đề SRT / WebVTT
 * Port 1:1 từ sub_extractor.go và app.go
 */

import type { Cue, SubtitleItem } from "./types";
import { isVietnamese } from "./text";

const TIMESTAMP_LINE_RE =
  /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/;
const HTML_TAG_RE = /<[^>]+>/g;

function pad(num: number, size: number): string {
  let s = num.toString();
  while (s.length < size) s = "0" + s;
  return s;
}

function parseHMSMs(
  hStr?: string,
  mStr = "0",
  sStr = "0",
  msStr = "0"
): number {
  let h = 0;
  if (hStr) {
    h = parseInt(hStr.replace(":", ""), 10) || 0;
  }
  const m = parseInt(mStr, 10) || 0;
  const s = parseInt(sStr, 10) || 0;
  const ms = parseInt(msStr, 10) || 0;
  return h * 3600 + m * 60 + s + ms / 1000;
}

/**
 * Format số giây sang HH:MM:SS,mmm cho file SRT
 * Port 1:1 từ FormatSRTTime trong app.go:801
 */
export function formatSrtTime(sec: number): string {
  if (sec < 0) {
    sec = 0;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  let ms = Math.round((sec - Math.floor(sec)) * 1000);
  if (ms >= 1000) {
    ms = 999;
  }
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/**
 * Format số giây sang HH:MM:SS.mmm cho file WebVTT
 * Port 1:1 từ FormatVTTTime trong app.go:816
 */
export function formatVttTime(sec: number): string {
  if (sec < 0) {
    sec = 0;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  let ms = Math.round((sec - Math.floor(sec)) * 1000);
  if (ms >= 1000) {
    ms = 999;
  }
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/**
 * Phân tích nội dung SRT hoặc WebVTT thành danh sách Cue
 * Port 1:1 từ ParseSRTorVTT trong sub_extractor.go:296 (không kèm lọc Whisper hallucination)
 */
export function parseSrtOrVtt(content: string): Cue[] {
  let normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Bỏ UTF-8 BOM nếu có
  if (normalized.charCodeAt(0) === 0xfeff) {
    normalized = normalized.slice(1);
  }

  const blocks = normalized.split("\n\n");
  const cues: Cue[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) {
      continue;
    }

    let timeLineIdx = -1;
    let startSec = 0;
    let endSec = 0;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(TIMESTAMP_LINE_RE);
      if (match) {
        startSec = parseHMSMs(match[1], match[2], match[3], match[4]);
        endSec = parseHMSMs(match[5], match[6], match[7], match[8]);
        timeLineIdx = i;
        break;
      }
    }

    if (timeLineIdx === -1 || endSec <= startSec) {
      continue;
    }

    const textParts: string[] = [];
    for (let i = timeLineIdx + 1; i < lines.length; i++) {
      const cleaned = lines[i].replace(HTML_TAG_RE, "").trim();
      if (cleaned) {
        textParts.push(cleaned);
      }
    }

    if (textParts.length === 0) {
      continue;
    }

    const fullText = textParts.join(" ");
    cues.push({
      start: startSec,
      end: endSec,
      text: fullText,
    });
  }

  return cues;
}

/**
 * Phân tích file phụ đề song ngữ (ví dụ file _bilingual.srt xuất từ Desktop).
 * Nếu một block có >= 2 dòng và dòng cuối là tiếng Việt thì tách thành {source, target}.
 */
export function parseSrtOrVttBilingual(content: string): SubtitleItem[] {
  let normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.charCodeAt(0) === 0xfeff) {
    normalized = normalized.slice(1);
  }

  const blocks = normalized.split("\n\n");
  const items: SubtitleItem[] = [];
  let id = 0;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) {
      continue;
    }

    let timeLineIdx = -1;
    let startSec = 0;
    let endSec = 0;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(TIMESTAMP_LINE_RE);
      if (match) {
        startSec = parseHMSMs(match[1], match[2], match[3], match[4]);
        endSec = parseHMSMs(match[5], match[6], match[7], match[8]);
        timeLineIdx = i;
        break;
      }
    }

    if (timeLineIdx === -1 || endSec <= startSec) {
      continue;
    }

    const rawLines: string[] = [];
    for (let i = timeLineIdx + 1; i < lines.length; i++) {
      const cleaned = lines[i].replace(HTML_TAG_RE, "").trim();
      if (cleaned) {
        rawLines.push(cleaned);
      }
    }

    if (rawLines.length === 0) {
      continue;
    }

    let sourceText = "";
    let targetText = "";

    if (rawLines.length >= 2 && isVietnamese(rawLines[rawLines.length - 1])) {
      // File song ngữ (Desktop _bilingual.srt): dòng cuối là tiếng Việt
      targetText = rawLines[rawLines.length - 1];
      sourceText = rawLines.slice(0, -1).join(" ");
    } else if (rawLines.every((l) => isVietnamese(l))) {
      // File chỉ có tiếng Việt (Desktop .vi.srt): coi là bản dịch, không đem đi dịch lại
      targetText = rawLines.join(" ");
      sourceText = "";
    } else {
      sourceText = rawLines.join(" ");
      targetText = "";
    }

    const hasVi = targetText !== "";
    items.push({
      id: id++,
      block: 0,
      start_sec: startSec,
      end_sec: endSec,
      source_text: sourceText,
      target_text: targetText,
      translated: hasVi,
      engine: hasVi ? "file" : null,
    });
  }

  return items;
}

/**
 * Tạo nội dung file .srt hoặc .vtt theo 3 chế độ: "source", "target", "bilingual"
 * Port 1:1 từ BuildSubtitleContent trong app.go:831
 */
export function buildSubtitleContent(
  items: SubtitleItem[],
  format: "srt" | "vtt",
  mode: "source" | "target" | "bilingual"
): string {
  const isVTT = format.toLowerCase().trim() === "vtt";
  const lines: string[] = [];

  if (isVTT) {
    lines.push("WEBVTT\n");
  }

  let idx = 1;
  for (const it of items) {
    let text = "";
    switch (mode) {
      case "source":
        text = it.source_text;
        break;
      case "target":
        text = it.target_text !== "" ? it.target_text : it.source_text;
        break;
      case "bilingual":
        if (it.target_text !== "") {
          text = `${it.source_text}\n${it.target_text}`;
        } else {
          text = it.source_text;
        }
        break;
      default:
        text = it.target_text !== "" ? it.target_text : it.source_text;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      continue;
    }

    lines.push(`${idx}`);
    if (isVTT) {
      lines.push(`${formatVttTime(it.start_sec)} --> ${formatVttTime(it.end_sec)}`);
    } else {
      lines.push(`${formatSrtTime(it.start_sec)} --> ${formatSrtTime(it.end_sec)}`);
    }
    lines.push(trimmed);
    lines.push(""); // Dòng trống giữa các block
    idx++;
  }

  // Go ghi mỗi block là "idx\ntime\ntext\n\n" -> file kết thúc bằng "\n\n" (khớp byte-to-byte)
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
