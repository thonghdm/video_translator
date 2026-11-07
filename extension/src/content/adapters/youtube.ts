/**
 * SubTrans Extension — Adapter cho YouTube (youtube.com/watch) — PLAN Phase 5
 * - Bắt timedtext từ hook MAIN world (yt-hook.ts)
 * - Tự động fetch fmt=json3 trong MAIN world
 * - Nếu bị chặn (pot token), thông báo người dùng bấm CC (phím C)
 * - Tự động phát hiện chuyển video (SPA navigation qua yt-navigate-finish)
 * - Ẩn phụ đề CC gốc của YouTube theo cài đặt hideNativeCaptions
 * - Phát hiện quảng cáo (ad-showing)
 */

import type { Cue, TrackRef } from "../../shared/types";
import type { SiteAdapter, SubtitleSource } from "./types";
import {
  extractVideoId,
  parseTimedtextUrl,
  parseYouTubeTimedtext,
} from "./ytParser";

export const HIDE_NATIVE_CC_STYLE_ID = "subtrans-hide-cc";

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
  captionTracks?: YtCaptionTrack[];
}

export interface YouTubeAdapterOptions {
  preferManual?: boolean;
  onNotify?: (message: string | null) => void;
  hookClient?: YouTubeHookClient;
}

/** Chọn track phụ đề tiếng Anh tốt nhất (ưu tiên thủ công trước ASR) */
export function pickYouTubeTrack(
  tracks: YtCaptionTrack[],
  preferManual = true
): YtCaptionTrack | null {
  if (!tracks || tracks.length === 0) return null;
  const enTracks = tracks.filter((t) =>
    (t.languageCode || "").toLowerCase().startsWith("en")
  );
  if (enTracks.length === 0) return null;
  if (!preferManual) return enTracks[0];

  const manual = enTracks.find((t) => t.kind !== "asr");
  return manual || enTracks[0];
}

/** Quản lý giao tiếp hai chiều giữa Content Script và yt-hook (MAIN world) */
export class YouTubeHookClient {
  private readonly capturedTimedtext = new Map<string, { url: string; body: string }>();
  private readonly pendingRequests = new Map<
    string,
    { resolve: (val: any) => void; reject: (err: any) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly timedtextListeners = new Set<(ev: { url: string; body: string }) => void>();
  private disposed = false;
  private messageListener: ((ev: MessageEvent) => void) | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    if (typeof window === "undefined") return;
    this.messageListener = (event: MessageEvent) => {
      try {
        if (event.source && event.source !== window) return;
        if (
          event.origin &&
          location.origin &&
          location.origin !== "null" &&
          event.origin !== location.origin
        ) {
          return;
        }
        const msg = event.data;
        if (!msg || msg.source !== "subtrans-yt") return;

        if (msg.kind === "timedtext") {
          const { url, body } = msg;
          if (typeof url === "string" && typeof body === "string") {
            const params = parseTimedtextUrl(url);
            if (params.videoId) {
              this.capturedTimedtext.set(params.videoId, { url, body });
            }
            this.capturedTimedtext.set(url, { url, body });
            for (const listener of this.timedtextListeners) {
              listener({ url, body });
            }
          }
        } else if (msg.kind === "playerResponse" || msg.kind === "fetchTimedtext.result") {
          const p = this.pendingRequests.get(msg.reqId);
          if (p) {
            clearTimeout(p.timer);
            this.pendingRequests.delete(msg.reqId);
            p.resolve(msg);
          }
        }
      } catch {
        // an toàn
      }
    };
    window.addEventListener("message", this.messageListener);
  }

  public getCaptured(videoId: string): { url: string; body: string } | null {
    return this.capturedTimedtext.get(videoId) || null;
  }

  public clearCapturedFor(videoId: string): void {
    this.capturedTimedtext.delete(videoId);
  }

  public onTimedtextCaptured(cb: (ev: { url: string; body: string }) => void): () => void {
    this.timedtextListeners.add(cb);
    return () => this.timedtextListeners.delete(cb);
  }

  public requestPlayerResponse(timeoutMs = 3000): Promise<YtPlayerResponseData | null> {
    if (this.disposed || typeof window === "undefined") return Promise.resolve(null);
    const reqId = `pr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<YtPlayerResponseData | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        resolve: (msg: any) => resolve(msg?.data || null),
        reject: () => resolve(null),
        timer,
      });

      window.postMessage(
        { source: "subtrans-cs", kind: "getPlayerResponse", reqId },
        location.origin
      );
    });
  }

  public fetchTimedtext(url: string, timeoutMs = 8000): Promise<string | null> {
    if (this.disposed || typeof window === "undefined") return Promise.resolve(null);
    const reqId = `ft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        resolve: (msg: any) => {
          if (msg && msg.ok && typeof msg.text === "string") resolve(msg.text);
          else resolve(null);
        },
        reject: () => resolve(null),
        timer,
      });

      window.postMessage(
        { source: "subtrans-cs", kind: "fetchTimedtext", reqId, url },
        location.origin
      );
    });
  }

  public dispose(): void {
    this.disposed = true;
    if (this.messageListener && typeof window !== "undefined") {
      window.removeEventListener("message", this.messageListener);
      this.messageListener = null;
    }
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pendingRequests.clear();
    this.timedtextListeners.clear();
    this.capturedTimedtext.clear();
  }
}

let sharedHookClient: YouTubeHookClient | null = null;
export function getSharedHookClient(): YouTubeHookClient {
  if (!sharedHookClient) {
    sharedHookClient = new YouTubeHookClient();
  }
  return sharedHookClient;
}

export class YouTubeSubtitleSource implements SubtitleSource {
  public readonly track: TrackRef;
  private readonly videoId: string;
  private readonly isAsr: boolean;
  private disposed = false;
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly captionTrack: YtCaptionTrack,
    videoId: string,
    videoTitle: string,
    private readonly hookClient: YouTubeHookClient,
    private readonly onNotify?: (message: string | null) => void
  ) {
    this.videoId = videoId;
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

  public async load(): Promise<Cue[]> {
    if (this.disposed) return [];

    // Bước 1: Nếu hook đã bắt được timedtext của đúng videoId này
    const captured = this.hookClient.getCaptured(this.videoId);
    if (captured && captured.body) {
      const cues = parseYouTubeTimedtext(captured.body, this.isAsr);
      if (cues.length > 0) return cues;
    }

    // Bước 2: Thử fetch baseUrl + &fmt=json3 trong MAIN world qua hook
    let fetchUrl = this.captionTrack.baseUrl;
    if (fetchUrl) {
      fetchUrl = fetchUrl.includes("fmt=")
        ? fetchUrl.replace(/fmt=[^&]+/, "fmt=json3")
        : `${fetchUrl}&fmt=json3`;

      try {
        const text = await this.hookClient.fetchTimedtext(fetchUrl);
        if (this.disposed) return [];
        if (text) {
          const cues = parseYouTubeTimedtext(text, this.isAsr);
          if (cues.length > 0) return cues;
        }
      } catch {
        // Chuyển sang bước 3
      }
    }

    // Bước 3: Đòi pot token / fetch thất bại -> Báo người dùng bật CC (phím C)
    if (this.disposed) return [];
    this.onNotify?.("Bật phụ đề CC của YouTube (phím C) để SubTrans lấy phụ đề");

    return new Promise<Cue[]>((resolve) => {
      let resolved = false;
      const done = (cues: Cue[]) => {
        if (resolved) return;
        resolved = true;
        this.onNotify?.(null);
        resolve(cues);
      };

      const off = this.hookClient.onTimedtextCaptured((item) => {
        const params = parseTimedtextUrl(item.url);
        if (params.videoId === this.videoId && item.body) {
          const cues = parseYouTubeTimedtext(item.body, this.isAsr);
          if (cues.length > 0) {
            off();
            done(cues);
          }
        }
      });

      this.cleanups.push(() => {
        off();
        done([]);
      });
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }
}

/** Bật/tắt ẩn phụ đề CC gốc của YouTube */
export function setYouTubeNativeCaptionsHidden(hide: boolean, doc: Document = document): void {
  let style = doc.getElementById(HIDE_NATIVE_CC_STYLE_ID);
  if (hide) {
    if (!style) {
      style = doc.createElement("style");
      style.id = HIDE_NATIVE_CC_STYLE_ID;
      style.textContent = ".ytp-caption-window-container{display:none!important}";
      doc.head?.appendChild(style);
    }
  } else {
    style?.remove();
  }
}

/** Tạo adapter cho YouTube */
export function createYouTubeAdapter(opts: YouTubeAdapterOptions = {}): SiteAdapter {
  const hookClient = opts.hookClient || getSharedHookClient();

  return {
    name: "youtube",
    matches(loc: Location): boolean {
      return (
        loc.hostname.includes("youtube.com") &&
        (loc.pathname === "/watch" || loc.pathname.startsWith("/watch/"))
      );
    },
    getOverlayContainer(video: HTMLVideoElement): HTMLElement | null {
      const doc = video.ownerDocument;
      return doc.getElementById("movie_player");
    },
    isAdPlaying(): boolean {
      const player = document.getElementById("movie_player");
      return Boolean(player?.classList.contains("ad-showing"));
    },
    onNavigate(cb: () => void): () => void {
      let lastHref = location.href;
      let lastVideoId = extractVideoId(lastHref);

      const check = () => {
        const currentHref = location.href;
        const currentVideoId = extractVideoId(currentHref);
        if (currentVideoId !== lastVideoId || currentHref !== lastHref) {
          lastHref = currentHref;
          if (lastVideoId && lastVideoId !== currentVideoId) {
            hookClient.clearCapturedFor(lastVideoId);
          }
          lastVideoId = currentVideoId;
          cb();
        }
      };

      document.addEventListener("yt-navigate-finish", check);
      const timer = setInterval(check, 1000);

      return () => {
        document.removeEventListener("yt-navigate-finish", check);
        clearInterval(timer);
      };
    },
    async listSources(_video: HTMLVideoElement): Promise<SubtitleSource[]> {
      const videoId = extractVideoId(location.href);
      if (!videoId) return [];

      const playerResponse = await hookClient.requestPlayerResponse();
      if (!playerResponse) return [];

      // Bỏ qua livestream (PLAN 5.2)
      if (playerResponse.isLiveContent) return [];

      const tracks = playerResponse.captionTracks || [];
      const bestTrack = pickYouTubeTrack(tracks, opts.preferManual ?? true);
      if (!bestTrack) return [];

      const title = playerResponse.title || document.title || "YouTube Video";
      return [
        new YouTubeSubtitleSource(
          bestTrack,
          videoId,
          title,
          hookClient,
          opts.onNotify
        ),
      ];
    },
  };
}
