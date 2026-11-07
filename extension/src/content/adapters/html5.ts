/**
 * SubTrans Extension — Adapter chung cho <video> HTML5 có <track> (PLAN 4.4)
 * - Chọn track subtitles/captions ưu tiên tiếng Anh; bỏ qua track "SubTrans" do chính extension tạo.
 * - Đặt mode = "hidden" để nhận cue mà trình duyệt không tự vẽ phụ đề gốc (khôi phục khi dispose).
 * - Track khác origin không đọc được cue → tải file qua background (fetchText) rồi parse.
 */

import type { Cue, TrackRef } from "../../shared/types";
import { parseSrtOrVtt } from "../../shared/subtitleFormat";
import { decodeHtmlEntities, normalizeLine } from "../../shared/text";
import type { SiteAdapter, SubtitleSource } from "./types";

export const SUBTRANS_TRACK_LABEL = "SubTrans";

export interface CueLike {
  startTime: number;
  endTime: number;
  text?: string;
}

export interface TextTrackLike {
  kind: string;
  label: string;
  language: string;
  mode: string;
  cues: ArrayLike<CueLike> | null;
}

/** Chọn track phù hợp nhất. Trả về -1 nếu không có. */
export function pickTrackIndex(tracks: ArrayLike<TextTrackLike>): number {
  let firstCandidate = -1;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.kind !== "subtitles" && t.kind !== "captions") continue;
    if (t.label === SUBTRANS_TRACK_LABEL) continue;
    if (firstCandidate === -1) firstCandidate = i;
    if ((t.language || "").toLowerCase().startsWith("en")) return i;
  }
  return firstCandidate;
}

const TAG_RE = /<[^>]+>/g;

/** Chuyển danh sách cue của trình duyệt thành Cue[] đã chuẩn hóa, sắp theo thời gian */
export function cueListToCues(list: ArrayLike<CueLike> | null | undefined): Cue[] {
  if (!list) return [];
  const out: Cue[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const raw = typeof c.text === "string" ? c.text : "";
    const text = normalizeLine(decodeHtmlEntities(raw.replace(TAG_RE, " ")));
    if (!text) continue;
    if (!(c.endTime > c.startTime)) continue;
    out.push({ start: c.startTime, end: c.endTime, text });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

export function buildHtml5TrackKey(
  loc: { origin: string; pathname: string },
  trackId: string,
  durationSec: number
): string {
  const d = Number.isFinite(durationSec) ? Math.round(durationSec) : 0;
  return `web:${loc.origin}${loc.pathname}:${trackId}:${d}`;
}

export type FetchTextFn = (url: string) => Promise<string>;

export interface Html5SourceOptions {
  /** Thời gian chờ tối đa để trình duyệt nạp cue (mặc định 10s) */
  waitMs?: number;
  pollMs?: number;
  fetchText?: FetchTextFn;
}

function findTrackElement(video: HTMLVideoElement, track: TextTrack): HTMLTrackElement | null {
  const els = video.querySelectorAll("track");
  for (let i = 0; i < els.length; i++) {
    if (els[i].track === track) return els[i];
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class Html5TrackSource implements SubtitleSource {
  public readonly track: TrackRef;
  private readonly originalMode: string;
  private disposed = false;
  private readonly timers = new Set<ReturnType<typeof setInterval>>();

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly textTrack: TextTrack,
    index: number,
    private readonly opts: Html5SourceOptions = {}
  ) {
    this.originalMode = textTrack.mode;
    const el = findTrackElement(video, textTrack);
    const trackId = textTrack.label || el?.getAttribute("src") || `track${index}`;
    const lang = textTrack.language || el?.srclang || "und";
    this.track = {
      trackKey: buildHtml5TrackKey(location, trackId, video.duration),
      platform: "web",
      videoId: `${location.origin}${location.pathname}`,
      title: document.title || location.hostname,
      lang,
      kind: "html5",
    };
  }

  public async load(): Promise<Cue[]> {
    // "disabled" thì trình duyệt không nạp cue; "showing" thì nó tự vẽ đè lên overlay
    if (this.textTrack.mode !== "hidden") this.textTrack.mode = "hidden";

    const waitMs = this.opts.waitMs ?? 10_000;
    const pollMs = this.opts.pollMs ?? 250;
    const el = findTrackElement(this.video, this.textTrack);
    let lastLen = -1;
    for (let waited = 0; waited <= waitMs && !this.disposed; waited += pollMs) {
      const len = this.textTrack.cues?.length ?? 0;
      // Có cue và số lượng đã ổn định qua 2 lần poll → xong
      if (len > 0 && len === lastLen) break;
      // <track> lỗi (thường do khác origin không có CORS) → thôi chờ
      if (el && el.readyState === 3 /* ERROR */) break;
      lastLen = len;
      await sleep(pollMs);
    }
    if (this.disposed) return [];

    const cues = cueListToCues(this.textTrack.cues);
    if (cues.length > 0) return cues;

    // Không đọc được cue: thử tải file qua background (bỏ qua CORS, credentials: omit)
    const src = el?.src;
    if (src && this.opts.fetchText && /^https?:/i.test(src)) {
      try {
        const text = await this.opts.fetchText(src);
        return parseSrtOrVtt(text);
      } catch (err) {
        if (import.meta.env?.DEV) console.warn("[SubTrans][html5] fetchText lỗi:", err);
      }
    }
    return [];
  }

  public onCuesChanged(cb: (cues: Cue[]) => void): () => void {
    let lastLen = this.textTrack.cues?.length ?? 0;
    const id = setInterval(() => {
      const len = this.textTrack.cues?.length ?? 0;
      if (len !== lastLen) {
        lastLen = len;
        cb(cueListToCues(this.textTrack.cues));
      }
    }, 2000);
    this.timers.add(id);
    return () => {
      clearInterval(id);
      this.timers.delete(id);
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.timers) clearInterval(id);
    this.timers.clear();
    try {
      this.textTrack.mode = this.originalMode as TextTrackMode;
    } catch {
      /* track đã bị gỡ */
    }
  }
}

export function createHtml5Adapter(fetchText?: FetchTextFn): SiteAdapter {
  return {
    name: "html5",
    matches: () => true,
    getOverlayContainer: () => null,
    async listSources(video) {
      const tracks = video.textTracks;
      if (!tracks || tracks.length === 0) return [];
      const idx = pickTrackIndex(tracks as unknown as ArrayLike<TextTrackLike>);
      if (idx < 0) return [];
      return [new Html5TrackSource(video, tracks[idx], idx, { fetchText })];
    },
  };
}
