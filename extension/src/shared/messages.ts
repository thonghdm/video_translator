/**
 * SubTrans Extension — Hợp đồng thông điệp giao tiếp (Messages)
 * Phù hợp với Mục 6.2 của PLAN.md
 */

import type {
  Cue,
  EngineError,
  EngineId,
  LineResult,
  Priority,
  TrackRef
} from "./types";

// Content -> Background (qua Port "subtrans")
export type C2B =
  | {
      type: "translate";
      reqId: string;
      trackKey: string;
      srcLang: string;
      lines: string[];
      priority: Priority;
      prefer?: EngineId;
    }
  | { type: "cancel"; reqId: string }
  | { type: "cache.load"; reqId: string; trackKey: string; sourceHash: string }
  | { type: "cache.saveTrack"; track: TrackRef; cues: Cue[]; sourceHash: string }
  | {
      type: "cache.saveLines";
      trackKey: string;
      engineKey: string;
      sourceHash: string;
      total: number;
      updates: Array<[number, string]>;
    }
  | { type: "fetchText"; reqId: string; url: string }; // chỉ http(s), tối đa 2MB

// Background -> Content
export type B2C =
  | {
      type: "translate.result";
      reqId: string;
      results: LineResult[];
      error?: EngineError;
    }
  | {
      type: "cache.loaded";
      reqId: string;
      hit: boolean;
      cues?: Cue[];
      lines?: Record<string /*engineKey*/, (string | null)[]>;
    }
  | {
      type: "fetchText.result";
      reqId: string;
      ok: boolean;
      text?: string;
      error?: string;
    }
  | {
      type: "status";
      breakers: { api: BreakerView; cloud: BreakerView };
      geminiReady: boolean;
    };

export interface BreakerView {
  blocked: boolean;
  until: number; /* epoch ms, 0 nếu không khóa */
}

// Popup/Options -> Background (chrome.runtime.sendMessage, có trả lời)
export type UiReq =
  | { type: "status" }
  | { type: "gemini.test"; apiKey: string; model: string }
  | { type: "gemini.listModels"; apiKey: string }
  | { type: "cache.stats" }
  | { type: "cache.listRecent"; limit?: number }
  | { type: "cache.clear"; trackKey?: string };

// Popup -> Content của tab đang mở (chrome.tabs.sendMessage)
export type PopupToTab =
  | { type: "tab.status" }
  | {
      type: "tab.export";
      format: "srt" | "vtt";
      mode: "source" | "target" | "bilingual";
    };

export interface TabStatus {
  active: boolean;
  platform?: string;
  title?: string;
  total: number;
  translated: number;
  byEngine: { api: number; cloud: number };
  message?: string;
}
