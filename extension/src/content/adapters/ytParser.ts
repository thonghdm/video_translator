/**
 * SubTrans Extension — Bộ phân tích phụ đề YouTube timedtext (PLAN 5.2)
 * Hỗ trợ các định dạng:
 * 1. json3 (chuẩn hiện đại của YouTube): events[] -> segs[].utf8
 * 2. xml (<transcript><text start dur>...</text></transcript>)
 * 3. vtt / srt (parseSrtOrVtt)
 * Áp dụng mergeAsrCues cho cả ASR (maxGap=1.2s) và thủ công (maxGap=0s).
 */

import type { Cue } from "../../shared/types";
import { decodeHtmlEntities, normalizeLine } from "../../shared/text";
import { mergeAsrCues } from "../../shared/sentenceMerge";
import { parseSrtOrVtt } from "../../shared/subtitleFormat";

export interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

export interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  wWinId?: number;
  aAppend?: number;
  segs?: Json3Seg[];
}

export interface Json3Payload {
  events?: Json3Event[];
}

/** Trích xuất videoId từ chuỗi URL (ví dụ /watch?v=... hoặc /api/timedtext?v=...) */
export function extractVideoId(urlStr: string): string | null {
  try {
    const u = new URL(urlStr, "https://www.youtube.com");
    return u.searchParams.get("v");
  } catch {
    const match = /[?&]v=([^&#]+)/.exec(urlStr);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

/** Đọc các tham số chính của URL /api/timedtext */
export function parseTimedtextUrl(urlStr: string): {
  videoId: string | null;
  lang: string | null;
  fmt: string | null;
} {
  try {
    const u = new URL(urlStr, "https://www.youtube.com");
    return {
      videoId: u.searchParams.get("v"),
      lang: u.searchParams.get("lang"),
      fmt: u.searchParams.get("fmt"),
    };
  } catch {
    const vMatch = /[?&]v=([^&#]+)/.exec(urlStr);
    const langMatch = /[?&]lang=([^&#]+)/.exec(urlStr);
    const fmtMatch = /[?&]fmt=([^&#]+)/.exec(urlStr);
    return {
      videoId: vMatch ? decodeURIComponent(vMatch[1]) : null,
      lang: langMatch ? decodeURIComponent(langMatch[1]) : null,
      fmt: fmtMatch ? decodeURIComponent(fmtMatch[1]) : null,
    };
  }
}

/** Parse định dạng JSON3 của YouTube */
export function parseJson3(jsonText: string, isAsr = false): Cue[] {
  let data: Json3Payload;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const events = data?.events;
  if (!Array.isArray(events)) return [];

  const rawCues: Cue[] = [];

  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs) || ev.segs.length === 0) continue;

    // Ghép các phân đoạn segs[].utf8
    let rawText = "";
    for (const seg of ev.segs) {
      if (typeof seg.utf8 === "string") {
        rawText += seg.utf8;
      }
    }

    // Bỏ qua event chỉ chứa ký tự xuống dòng hoặc khoảng trắng
    if (!rawText || rawText === "\n" || !rawText.trim()) continue;

    const text = normalizeLine(decodeHtmlEntities(rawText));
    if (!text) continue;

    const startMs = typeof ev.tStartMs === "number" ? ev.tStartMs : 0;
    const durMs = typeof ev.dDurationMs === "number" ? ev.dDurationMs : 0;
    const start = Math.max(0, startMs / 1000);
    const end = durMs > 0 ? (startMs + durMs) / 1000 : start + 0.1;

    if (end > start) {
      rawCues.push({ start, end, text });
    }
  }

  rawCues.sort((a, b) => a.start - b.start || a.end - b.end);

  // Áp dụng merge theo đặc tả PLAN 5.2
  return isAsr
    ? mergeAsrCues(rawCues, { maxGapSec: 1.2, maxDurSec: 7, maxChars: 120 })
    : mergeAsrCues(rawCues, { maxGapSec: 0, maxDurSec: 7, maxChars: 120 });
}

const TAG_RE = /<[^>]+>/g;

/** Parse định dạng XML timedtext cổ điển của YouTube (<text start dur>...</text>) */
export function parseXmlTimedtext(xmlText: string, isAsr = false): Cue[] {
  const rawCues: Cue[] = [];

  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, "text/xml");
      const textEls = doc.getElementsByTagName("text");
      for (let i = 0; i < textEls.length; i++) {
        const el = textEls[i];
        const startAttr = el.getAttribute("start");
        const durAttr = el.getAttribute("dur");
        const start = parseFloat(startAttr || "0");
        const dur = parseFloat(durAttr || "0");
        const end = dur > 0 ? start + dur : start + 0.1;
        const rawContent = el.textContent || "";
        const cleanContent = rawContent.replace(TAG_RE, " ");
        const text = normalizeLine(decodeHtmlEntities(cleanContent));
        if (text && end > start && !isNaN(start)) {
          rawCues.push({ start, end, text });
        }
      }
    } catch {
      // Fallback regex bên dưới nếu DOMParser lỗi
    }
  }

  // Fallback regex nếu DOMParser chưa ra kết quả
  if (rawCues.length === 0) {
    const textTagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match: RegExpExecArray | null;
    while ((match = textTagRe.exec(xmlText)) !== null) {
      const attrs = match[1];
      const content = match[2];
      const startMatch = /\bstart="([^"]+)"/.exec(attrs);
      const durMatch = /\bdur="([^"]+)"/.exec(attrs);
      const start = parseFloat(startMatch ? startMatch[1] : "0");
      const dur = parseFloat(durMatch ? durMatch[1] : "0");
      const end = dur > 0 ? start + dur : start + 0.1;
      const cleanContent = content.replace(TAG_RE, " ");
      const text = normalizeLine(decodeHtmlEntities(cleanContent));
      if (text && end > start && !isNaN(start)) {
        rawCues.push({ start, end, text });
      }
    }
  }

  rawCues.sort((a, b) => a.start - b.start || a.end - b.end);

  return isAsr
    ? mergeAsrCues(rawCues, { maxGapSec: 1.2, maxDurSec: 7, maxChars: 120 })
    : mergeAsrCues(rawCues, { maxGapSec: 0, maxDurSec: 7, maxChars: 120 });
}

/** Tự động nhận diện định dạng và parse phụ đề timedtext YouTube */
export function parseYouTubeTimedtext(content: string, isAsr = false): Cue[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // 1. JSON3
  if (trimmed.startsWith("{") || trimmed.includes('"events"')) {
    const cues = parseJson3(trimmed, isAsr);
    if (cues.length > 0) return cues;
  }

  // 2. VTT hoặc SRT
  if (trimmed.startsWith("WEBVTT") || trimmed.includes("-->")) {
    const parsed = parseSrtOrVtt(trimmed);
    if (parsed.length > 0) {
      return isAsr
        ? mergeAsrCues(parsed, { maxGapSec: 1.2, maxDurSec: 7, maxChars: 120 })
        : mergeAsrCues(parsed, { maxGapSec: 0, maxDurSec: 7, maxChars: 120 });
    }
  }

  // 3. XML timedtext
  if (trimmed.includes("<text") || trimmed.includes("<transcript")) {
    return parseXmlTimedtext(trimmed, isAsr);
  }

  return [];
}
