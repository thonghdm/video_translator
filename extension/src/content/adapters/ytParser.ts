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

/** /embed/videoseries?list=…, /embed/live_stream?channel=… không phải id của một video */
const EMBED_NON_VIDEO = new Set(["videoseries", "live_stream"]);

/** Trích xuất videoId từ chuỗi URL (ví dụ /watch?v=..., /embed/..., /api/timedtext?v=..., youtu.be/...) */
export function extractVideoId(urlStr: string): string | null {
  try {
    const u = new URL(urlStr, "https://www.youtube.com");
    const v = u.searchParams.get("v");
    if (v) return v;

    // Hỗ trợ /embed/{id} (YouTube Embed player trên Google Drive hoặc các trang nhúng)
    const embedMatch = u.pathname.match(/\/embed\/([^/?&#]+)/);
    if (embedMatch && !EMBED_NON_VIDEO.has(embedMatch[1])) return embedMatch[1];

    // Hỗ trợ youtu.be/{id}
    if (u.hostname === "youtu.be" && u.pathname.length > 1) {
      return u.pathname.slice(1).split("/")[0];
    }
  } catch {
    // Fallback regex bên dưới
  }

  const matchV = /[?&]v=([^&#]+)/.exec(urlStr);
  if (matchV) return decodeURIComponent(matchV[1]);

  const matchEmbed = /\/embed\/([^/?&#]+)/.exec(urlStr);
  if (matchEmbed && !EMBED_NON_VIDEO.has(matchEmbed[1])) return decodeURIComponent(matchEmbed[1]);

  return null;
}

export interface TimedtextUrlParams {
  videoId: string | null;
  lang: string | null;
  fmt: string | null;
  /** "asr" cho phụ đề tự động; null cho phụ đề thủ công */
  kind: string | null;
  /** Có tlang = bản YouTube tự dịch sang ngôn ngữ khác → KHÔNG phải phụ đề gốc */
  tlang: string | null;
  hasPot: boolean;
}

/** Đọc các tham số chính của URL /api/timedtext */
export function parseTimedtextUrl(urlStr: string): TimedtextUrlParams {
  try {
    const u = new URL(urlStr, "https://www.youtube.com");
    const q = u.searchParams;
    return {
      videoId: q.get("v"),
      lang: q.get("lang"),
      fmt: q.get("fmt"),
      kind: q.get("kind") || null,
      tlang: q.get("tlang") || null,
      hasPot: q.has("pot"),
    };
  } catch {
    const get = (k: string) => {
      const m = new RegExp(`[?&]${k}=([^&#]*)`).exec(urlStr);
      return m ? decodeURIComponent(m[1]) : null;
    };
    return {
      videoId: get("v"),
      lang: get("lang"),
      fmt: get("fmt"),
      kind: get("kind") || null,
      tlang: get("tlang") || null,
      hasPot: /[?&]pot=/.test(urlStr),
    };
  }
}

export interface TrackIdentity {
  languageCode: string;
  kind?: string;
}

/** URL timedtext có đúng là track gốc (không tự dịch) cần tìm không */
export function timedtextMatchesTrack(params: TimedtextUrlParams, track: TrackIdentity): boolean {
  if (params.tlang) return false;
  if ((params.lang || "") !== track.languageCode) return false;
  const wantAsr = track.kind === "asr";
  return wantAsr === (params.kind === "asr");
}

/**
 * Dựng URL tải track mong muốn từ một URL timedtext đã bắt được của CÙNG video.
 * Đã kiểm chứng trên YouTube thật (NOTES.md, Phase 5): URL do player gửi có `pot` (proof-of-origin);
 * đổi lang/kind/tlang trên URL đó vẫn tải được, còn baseUrl trong playerResponse (không có pot)
 * trả về HTTP 200 nhưng body RỖNG.
 */
export function deriveTrackUrl(capturedUrl: string, track: TrackIdentity): string | null {
  try {
    const u = new URL(capturedUrl, "https://www.youtube.com");
    u.searchParams.set("lang", track.languageCode);
    if (track.kind === "asr") u.searchParams.set("kind", "asr");
    else u.searchParams.delete("kind");
    u.searchParams.delete("tlang");
    u.searchParams.set("fmt", "json3");
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Chuẩn hóa timeline: sắp xếp, cắt phần chồng lấn (end = start của cue sau), bỏ cue quá ngắn.
 * Bắt buộc với YouTube: json3 dùng "cửa sổ cuộn" nên ~98% event chồng thời gian lên event sau
 * (đo trên video thật) — nếu không cắt, tìm nhị phân findSubtitleAtTime sẽ bỏ sót dòng.
 */
export function normalizeTimeline(cues: Cue[], minDurSec = 0.05): Cue[] {
  // Bỏ cue rác (quá ngắn) TRƯỚC khi cắt chồng lấn, để nó không cắt cụt cue hợp lệ đang hiển thị
  const sorted = cues
    .filter(
      (c) =>
        c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start >= minDurSec
    )
    .map((c) => ({ ...c }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < sorted.length - 1; i++) {
    const next = sorted[i + 1];
    if (next.start < sorted[i].end) sorted[i].end = next.start;
  }
  return sorted.filter((c) => c.end - c.start >= minDurSec);
}

function finalize(rawCues: Cue[], isAsr: boolean): Cue[] {
  const merged = isAsr
    ? mergeAsrCues(rawCues, { maxGapSec: 1.2, maxDurSec: 7, maxChars: 120 })
    : mergeAsrCues(rawCues, { maxGapSec: 0, maxDurSec: 7, maxChars: 120 });
  return normalizeTimeline(merged);
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

  // Gộp câu (PLAN 5.2) rồi chuẩn hóa timeline (bỏ chồng lấn)
  return finalize(rawCues, isAsr);
}

const TAG_RE = /<[^>]+>/g;

/**
 * Parse XML timedtext của YouTube:
 * - srv1: <transcript><text start="1.2" dur="2.5">…</text></transcript> (giây)
 * - srv3: <timedtext format="3"><body><p t="1200" d="2500">…<s>…</s></p></body></timedtext> (mili-giây)
 */
export function parseXmlTimedtext(xmlText: string, isAsr = false): Cue[] {
  const rawCues: Cue[] = [];
  const push = (start: number, end: number, raw: string) => {
    const text = normalizeLine(decodeHtmlEntities(raw.replace(TAG_RE, " ")));
    if (text && Number.isFinite(start) && end > start) rawCues.push({ start, end, text });
  };

  let parsedWithDom = false;
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(xmlText, "text/xml");
      if (!doc.getElementsByTagName("parsererror").length) {
        parsedWithDom = true;
        const textEls = doc.getElementsByTagName("text");
        for (let i = 0; i < textEls.length; i++) {
          const el = textEls[i];
          const start = parseFloat(el.getAttribute("start") || "0");
          const dur = parseFloat(el.getAttribute("dur") || "0");
          push(start, dur > 0 ? start + dur : start + 0.1, el.textContent || "");
        }
        const pEls = doc.getElementsByTagName("p");
        for (let i = 0; i < pEls.length; i++) {
          const el = pEls[i];
          const t = parseFloat(el.getAttribute("t") || "NaN");
          const d = parseFloat(el.getAttribute("d") || "0");
          if (!Number.isFinite(t)) continue;
          push(t / 1000, d > 0 ? (t + d) / 1000 : t / 1000 + 0.1, el.textContent || "");
        }
      }
    } catch {
      parsedWithDom = false;
    }
  }

  // Dự phòng regex (môi trường không có DOMParser hoặc XML hỏng)
  if (!parsedWithDom || rawCues.length === 0) {
    const srv1 = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let m: RegExpExecArray | null;
    while ((m = srv1.exec(xmlText)) !== null) {
      const start = parseFloat(/\bstart="([^"]+)"/.exec(m[1])?.[1] ?? "0");
      const dur = parseFloat(/\bdur="([^"]+)"/.exec(m[1])?.[1] ?? "0");
      push(start, dur > 0 ? start + dur : start + 0.1, m[2]);
    }
    const srv3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((m = srv3.exec(xmlText)) !== null) {
      const t = parseFloat(/\bt="([^"]+)"/.exec(m[1])?.[1] ?? "NaN");
      const d = parseFloat(/\bd="([^"]+)"/.exec(m[1])?.[1] ?? "0");
      if (!Number.isFinite(t)) continue;
      push(t / 1000, d > 0 ? (t + d) / 1000 : t / 1000 + 0.1, m[2]);
    }
  }

  return finalize(rawCues, isAsr);
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
    if (parsed.length > 0) return finalize(parsed, isAsr);
  }

  // 3. XML timedtext
  if (trimmed.includes("<text") || trimmed.includes("<transcript") || trimmed.includes("<timedtext")) {
    return parseXmlTimedtext(trimmed, isAsr);
  }

  return [];
}
