/**
 * SubTrans Extension — Hợp đồng dữ liệu cốt lõi (Types)
 * Phù hợp với Mục 6.1 của PLAN.md
 */

export type EngineId = "api" | "cloud";
export type TranslateMode = "google" | "gemini" | "hybrid";
export type SubtitleMode = "bilingual" | "vi" | "en" | "off";
export type Priority = "tier1" | "tier2" | "upgrade";

export interface Cue {
  start: number; // Giây
  end: number;
  text: string; // Đã gộp dòng, đã bỏ thẻ HTML
}

// Mở rộng từ SubtitleItem của Desktop (giữ tên field snake_case để tương thích)
export interface SubtitleItem {
  id: number; // Chỉ số cue (ổn định trong một track)
  block: number; // Luôn 0 trong extension (giữ để tương thích)
  start_sec: number;
  end_sec: number;
  source_text: string;
  target_text: string; // Rỗng khi chưa dịch
  translated: boolean;
  engine: EngineId | null; // Engine đã dịch dòng này
  ignored?: boolean; // true nếu isIgnoredSubtitle
}

export type TrackKind = "manual" | "asr" | "html5" | "imported";

export interface TrackRef {
  trackKey: string;
  platform: "youtube" | "web" | "file";
  videoId: string;
  title: string;
  lang: string;
  kind: TrackKind;
}

export interface LineResult {
  text: string;
  engine: EngineId | null;
}

export type ErrKind = "canceled" | "blocked" | "network" | "disabled" | "other";

export interface EngineError {
  kind: ErrKind;
  message: string;
  retryAfterMs?: number;
}
