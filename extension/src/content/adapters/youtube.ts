/**
 * SubTrans Extension — Adapter YouTube (youtube.com/watch) — PLAN Phase 5
 *
 * Thứ tự lấy phụ đề (đã kiểm chứng trên YouTube thật, xem NOTES.md › Phase 5):
 *  1. Hook đã bắt được timedtext ĐÚNG track (cùng videoId + lang + kind, không có tlang) → dùng luôn.
 *  2. Hook đã bắt được timedtext KHÁC track của cùng video (URL có `pot`) → đổi lang/kind/tlang trên
 *     URL đó rồi nhờ hook tải trong MAIN world.
 *  3. Chưa bắt được gì → nhờ hook gọi player.loadModule("captions") để player tự tải (có pot), chờ ≤ 6s.
 *     Nếu SubTrans là bên bật phụ đề thì tắt lại khi dispose.
 *  4. Vẫn không có → thông báo "Bật CC (phím C)" và chờ hook bắt được.
 * (baseUrl trong playerResponse KHÔNG dùng được: thiếu pot → HTTP 200 body rỗng.)
 */

import type { Cue, TrackRef } from "../../shared/types";
import type { SiteAdapter, SubtitleSource } from "./types";
import {
  deriveTrackUrl,
  extractVideoId,
  parseTimedtextUrl,
  parseYouTubeTimedtext,
  timedtextMatchesTrack,
} from "./ytParser";

export const HIDE_NATIVE_CC_STYLE_ID = "subtrans-hide-cc";

/** Mọi selector DOM của YouTube gom một chỗ (R10): đổi giao diện chỉ cần sửa ở đây */
export const YT_SELECTORS = {
  player: "movie_player", // id
  adShowingClass: "ad-showing",
  captionWindow: ".ytp-caption-window-container",
} as const;

export interface YtCaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name: string;
}

export interface YtPlayerResponseData {
  videoId?: string;
  title?: string;
  isLiveContent?: boolean;
  isLiveNow?: boolean;
  captionTracks?: YtCaptionTrack[];
}

export interface YouTubeAdapterOptions {
  preferManual?: boolean;
  onNotify?: (message: string | null) => void;
  hookClient?: YouTubeHookClient;
  /** Thời gian chờ player tự tải phụ đề sau loadModule (mặc định 6s) */
  ensureWaitMs?: number;
  /** Số lần/khoảng thử lại khi playerResponse chưa khớp videoId (sau SPA navigation) */
  playerResponseRetries?: number;
  playerResponseRetryMs?: number;
}

interface Captured {
  url: string;
  body: string;
}

/** Chọn track phụ đề tiếng Anh tốt nhất (ưu tiên thủ công trước ASR) */
export function pickYouTubeTrack(tracks: YtCaptionTrack[], preferManual = true): YtCaptionTrack | null {
  if (!tracks || tracks.length === 0) return null;
  const en = tracks.filter((t) => (t.languageCode || "").toLowerCase().startsWith("en"));
  if (en.length === 0) return null;
  if (!preferManual) return en[0];
  return en.find((t) => t.kind !== "asr") || en[0];
}

let reqSeq = 0;
const nextReqId = (p: string) => `${p}_${Date.now().toString(36)}_${(reqSeq++).toString(36)}`;

/** Giao tiếp 2 chiều Content Script ↔ yt-hook (MAIN world) qua window.postMessage */
export class YouTubeHookClient {
  /** videoId → các response timedtext đã bắt (mới nhất ở cuối) */
  private readonly captured = new Map<string, Captured[]>();
  private readonly pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(c: Captured) => void>();
  private readonly onMessage = (event: MessageEvent) => this.handleMessage(event);
  private disposed = false;

  constructor(private readonly win: Window = window) {
    this.win.addEventListener("message", this.onMessage);
    // Request timedtext đầu tiên của player thường chạy TRƯỚC khi content script nghe → xin phát lại
    this.send({ kind: "replay" });
  }

  private send(msg: Record<string, unknown>): void {
    try {
      this.win.postMessage({ source: "subtrans-cs", ...msg }, this.win.location.origin);
    } catch {
      /* bỏ qua */
    }
  }

  private handleMessage(event: MessageEvent): void {
    try {
      // Chrome: source === window; jsdom: null. Trang chạy cùng cửa sổ nên kiểm tra này chỉ để lọc nhiễu.
      if (event.source !== this.win && event.source !== null) return;
      const msg = event.data;
      if (!msg || msg.source !== "subtrans-yt") return;
      if (msg.kind === "timedtext") {
        if (typeof msg.url !== "string" || typeof msg.body !== "string" || !msg.body) return;
        const vid = parseTimedtextUrl(msg.url).videoId;
        if (!vid) return;
        const list = this.captured.get(vid) ?? [];
        if (!list.some((c) => c.url === msg.url)) {
          list.push({ url: msg.url, body: msg.body });
          if (list.length > 8) list.shift();
          this.captured.set(vid, list);
        }
        for (const fn of this.listeners) fn({ url: msg.url, body: msg.body });
        return;
      }
      if (typeof msg.reqId === "string") {
        const p = this.pending.get(msg.reqId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.reqId);
          p.resolve(msg);
        }
      }
    } catch {
      /* an toàn */
    }
  }

  private request<T>(kind: string, extra: Record<string, unknown>, timeoutMs: number, map: (msg: Record<string, unknown>) => T, fallback: T): Promise<T> {
    if (this.disposed) return Promise.resolve(fallback);
    const reqId = nextReqId(kind);
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(fallback);
      }, timeoutMs);
      this.pending.set(reqId, { resolve: (m) => resolve(map(m)), timer });
      this.send({ kind, reqId, ...extra });
    });
  }

  /** Mọi response đã bắt của video (mới nhất cuối) */
  public getCapturedList(videoId: string): Captured[] {
    return this.captured.get(videoId) ?? [];
  }

  /** Response đã bắt đúng track (bỏ qua bản tự dịch tlang) */
  public findCaptured(videoId: string, track: { languageCode: string; kind?: string }): Captured | null {
    const list = this.getCapturedList(videoId);
    for (let i = list.length - 1; i >= 0; i--) {
      if (timedtextMatchesTrack(parseTimedtextUrl(list[i].url), track)) return list[i];
    }
    return null;
  }

  /** URL có pot bất kỳ của video (để dựng URL track khác) */
  public findPotUrl(videoId: string): string | null {
    const list = this.getCapturedList(videoId);
    for (let i = list.length - 1; i >= 0; i--) {
      if (parseTimedtextUrl(list[i].url).hasPot) return list[i].url;
    }
    return list.length ? list[list.length - 1].url : null;
  }

  public clearCapturedFor(videoId: string): void {
    this.captured.delete(videoId);
  }

  public onTimedtextCaptured(cb: (c: Captured) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  public requestPlayerResponse(timeoutMs = 2000): Promise<YtPlayerResponseData | null> {
    return this.request("getPlayerResponse", {}, timeoutMs, (m) => (m?.data as YtPlayerResponseData) ?? null, null);
  }

  /** Tải timedtext trong MAIN world (cùng cookie/origin của trang). null nếu lỗi hoặc body rỗng. */
  public fetchTimedtext(url: string, timeoutMs = 8000): Promise<string | null> {
    return this.request("fetchTimedtext", { url }, timeoutMs, (m) => (m?.ok && typeof m.text === "string" && m.text ? m.text : null), null);
  }

  /** Nhờ player tự tải phụ đề. Trả về wasOn = phụ đề đã bật sẵn từ trước (do người dùng). */
  public ensureCaptions(timeoutMs = 1500): Promise<{ ok: boolean; wasOn: boolean }> {
    return this.request("ensureCaptions", {}, timeoutMs, (m) => ({ ok: Boolean(m?.ok), wasOn: Boolean(m?.wasOn) }), { ok: false, wasOn: true });
  }

  public restoreCaptions(): void {
    this.send({ kind: "restoreCaptions" });
  }

  public dispose(): void {
    this.disposed = true;
    this.win.removeEventListener("message", this.onMessage);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.listeners.clear();
    this.captured.clear();
  }
}

let sharedHookClient: YouTubeHookClient | null = null;
export function getSharedHookClient(): YouTubeHookClient {
  if (!sharedHookClient) sharedHookClient = new YouTubeHookClient();
  return sharedHookClient;
}

export class YouTubeSubtitleSource implements SubtitleSource {
  public readonly track: TrackRef;
  private readonly isAsr: boolean;
  private disposed = false;
  private enabledCaptionsBySubtrans = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly captionTrack: YtCaptionTrack,
    private readonly videoId: string,
    videoTitle: string,
    private readonly hook: YouTubeHookClient,
    private readonly onNotify?: (message: string | null) => void,
    private readonly ensureWaitMs = 6000
  ) {
    this.isAsr = captionTrack.kind === "asr";
    const kind = this.isAsr ? "asr" : "manual";
    this.track = {
      trackKey: `yt:${videoId}:${captionTrack.languageCode}:${kind}`,
      platform: "youtube",
      videoId,
      title: videoTitle || "YouTube Video",
      lang: captionTrack.languageCode,
      kind,
    };
  }

  private parse(body: string | null | undefined): Cue[] {
    return body ? parseYouTubeTimedtext(body, this.isAsr) : [];
  }

  /** Bước 1 + 2: từ những gì hook đã bắt được */
  private async fromCaptured(): Promise<Cue[]> {
    const exact = this.hook.findCaptured(this.videoId, this.captionTrack);
    const cues = this.parse(exact?.body);
    if (cues.length > 0) return cues;
    const potUrl = this.hook.findPotUrl(this.videoId);
    if (!potUrl) return [];
    const url = deriveTrackUrl(potUrl, this.captionTrack);
    if (!url) return [];
    return this.parse(await this.hook.fetchTimedtext(url));
  }

  /** Chờ hook bắt được timedtext của video này (tối đa waitMs; Infinity = tới khi dispose) */
  private waitForCapture(waitMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (v: boolean) => {
        off();
        if (timer) clearTimeout(timer);
        const i = this.cleanups.indexOf(cancel);
        if (i >= 0) this.cleanups.splice(i, 1);
        resolve(v);
      };
      const off = this.hook.onTimedtextCaptured((c) => {
        if (parseTimedtextUrl(c.url).videoId === this.videoId) finish(true);
      });
      const cancel = () => finish(false);
      this.cleanups.push(cancel);
      if (Number.isFinite(waitMs)) timer = setTimeout(() => finish(false), waitMs);
    });
  }

  public async load(): Promise<Cue[]> {
    if (this.disposed) return [];

    // 1 + 2
    let cues = await this.fromCaptured();
    if (cues.length > 0 || this.disposed) return cues;

    // 3. Nhờ player tự tải phụ đề (có pot)
    const waiting = this.waitForCapture(this.ensureWaitMs);
    const ens = await this.hook.ensureCaptions();
    if (ens.ok && !ens.wasOn) this.enabledCaptionsBySubtrans = true;
    if (await waiting) {
      if (this.disposed) return [];
      cues = await this.fromCaptured();
      if (cues.length > 0 || this.disposed) return cues;
    }

    // 4. Báo người dùng bật CC và chờ (không giới hạn, tới khi dispose)
    while (!this.disposed) {
      this.onNotify?.("Bật phụ đề CC của YouTube (phím C) để SubTrans lấy phụ đề");
      const got = await this.waitForCapture(Infinity);
      if (!got || this.disposed) return [];
      cues = await this.fromCaptured();
      if (cues.length > 0) {
        this.onNotify?.(null);
        return cues;
      }
    }
    return [];
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cleanups.splice(0)) c();
    // Chỉ tắt phụ đề nếu chính SubTrans đã bật (không đụng lựa chọn của người dùng)
    if (this.enabledCaptionsBySubtrans) this.hook.restoreCaptions();
  }
}

/** Bật/tắt ẩn phụ đề CC gốc của YouTube */
export function setYouTubeNativeCaptionsHidden(hide: boolean, doc: Document = document): void {
  let style = doc.getElementById(HIDE_NATIVE_CC_STYLE_ID);
  if (hide) {
    if (!style) {
      style = doc.createElement("style");
      style.id = HIDE_NATIVE_CC_STYLE_ID;
      style.textContent = `${YT_SELECTORS.captionWindow}{display:none!important}`;
      (doc.head ?? doc.documentElement).appendChild(style);
    }
  } else {
    style?.remove();
  }
}

export function isYouTubeHost(hostname: string): boolean {
  if (!hostname) return false;
  return (
    hostname === "www.youtube.com" ||
    hostname === "youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "youtube.googleapis.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname.endsWith(".youtube-nocookie.com")
  );
}

export function isYouTubeWatch(loc: Pick<Location, "hostname" | "pathname" | "href">): boolean {
  if (!isYouTubeHost(loc.hostname)) return false;
  const vid = extractVideoId(loc.href);
  if (!vid) return false;
  // Trang /watch thông thường
  if (loc.pathname === "/watch") return true;
  // Trang /embed/{id} (nhúng YouTube trong Google Drive hoặc các trang web khác)
  if (loc.pathname.startsWith("/embed/")) return true;
  return false;
}

/**
 * Theo dõi đổi video trên YouTube (SPA): chỉ báo khi videoId (hoặc trạng thái "đang ở /watch") đổi —
 * KHÔNG báo khi chỉ đổi tham số khác (vd. &t=, &list=).
 */
export function watchYouTubeNavigation(
  onChange: (videoId: string | null) => void,
  hook?: YouTubeHookClient
): () => void {
  let last = isYouTubeWatch(location) ? extractVideoId(location.href) : null;
  const check = () => {
    const cur = isYouTubeWatch(location) ? extractVideoId(location.href) : null;
    if (cur === last) return;
    if (last) hook?.clearCapturedFor(last);
    last = cur;
    onChange(cur);
  };
  document.addEventListener("yt-navigate-finish", check);
  const timer = setInterval(check, 1000);
  return () => {
    document.removeEventListener("yt-navigate-finish", check);
    clearInterval(timer);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tạo adapter cho YouTube */
export function createYouTubeAdapter(opts: YouTubeAdapterOptions = {}): SiteAdapter {
  const hook = opts.hookClient || getSharedHookClient();
  const retries = opts.playerResponseRetries ?? 10;
  const retryMs = opts.playerResponseRetryMs ?? 500;

  return {
    name: "youtube",
    // YouTube phát quảng cáo/đổi video trên CÙNG thẻ <video> → không dựng lại session theo loadstart;
    // đổi video được xử lý bằng watchYouTubeNavigation.
    rebuildOnSourceChange: false,
    matches: (loc) => isYouTubeWatch(loc),
    getOverlayContainer: (video) => video.ownerDocument.getElementById(YT_SELECTORS.player),
    isAdPlaying: () =>
      Boolean(document.getElementById(YT_SELECTORS.player)?.classList.contains(YT_SELECTORS.adShowingClass)),
    async listSources(_video) {
      const videoId = extractVideoId(location.href);
      if (!videoId) return [];

      // Sau SPA navigation, getPlayerResponse() có thể vẫn trả video CŨ một lúc → chờ tới khi khớp
      let pr: YtPlayerResponseData | null = null;
      for (let i = 0; i <= retries; i++) {
        pr = await hook.requestPlayerResponse();
        if (pr?.videoId === videoId) break;
        pr = null;
        if (extractVideoId(location.href) !== videoId) return []; // người dùng đã chuyển tiếp
        await sleep(retryMs);
      }
      if (!pr) return [];
      if (pr.isLiveNow) return []; // đang livestream: không có track đầy đủ

      const best = pickYouTubeTrack(pr.captionTracks || [], opts.preferManual ?? true);
      if (!best) return [];
      return [
        new YouTubeSubtitleSource(
          best,
          videoId,
          pr.title || document.title || "YouTube Video",
          hook,
          opts.onNotify,
          opts.ensureWaitMs
        ),
      ];
    },
  };
}
