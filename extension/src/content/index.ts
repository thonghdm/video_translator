/**
 * SubTrans Extension — Điểm vào content script (ISOLATED world, mọi frame) — PLAN 4.11 & Phase 5
 * Luồng: settings → dò video → adapter (YouTube / HTML5) → overlay + session.
 * Phase 5: Hỗ trợ adapter YouTube, bắt timedtext, tự fetch json3 trong MAIN world,
 * ẩn CC gốc theo cài đặt hideNativeCaptions, phát hiện quảng cáo và chuyển trang SPA.
 */

import { loadSettings, onSettingsChanged, type Settings } from "../shared/settings";
import { Disposer } from "../shared/disposer";
import { VideoDetector } from "./videoDetector";
import { createHtml5Adapter } from "./adapters/html5";
import {
  createYouTubeAdapter,
  getSharedHookClient,
  isYouTubeHost,
  setYouTubeNativeCaptionsHidden,
  watchYouTubeNavigation,
} from "./adapters/youtube";
import type { SiteAdapter, SubtitleSource } from "./adapters/types";
import { OverlayHost } from "./overlay/mount";
import { OverlayStore } from "./overlay/store";
import { NativeTrackFallback } from "./overlay/nativeTrackFallback";
import { Session } from "./pipeline/session";
import { BackgroundPort, newReqId } from "./port";
import type { B2C } from "../shared/messages";

const log = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.log("[SubTrans]", ...args);
};

function isEnabledFor(settings: Settings, hostname: string): boolean {
  return settings.enabled && !settings.disabledHosts.includes(hostname);
}

class ContentController {
  private settings!: Settings;
  private readonly root = new Disposer();
  private active: Disposer | null = null;
  private videoScope: Disposer | null = null;
  private port: BackgroundPort | null = null;
  private store: OverlayStore | null = null;
  private session: Session | null = null;
  private currentVideo: HTMLVideoElement | null = null;
  private generation = 0;

  public async init(): Promise<void> {
    // Content script KHÔNG đọc API key (PLAN 3.4)
    this.settings = await loadSettings({ includeApiKey: false });
    this.root.add(
      onSettingsChanged((s) => this.applySettings(s), { includeApiKey: false })
    );
    if (isEnabledFor(this.settings, location.hostname)) this.activate();
  }

  private applySettings(next: Settings): void {
    const wasOn = isEnabledFor(this.settings, location.hostname);
    this.settings = next;
    const isOn = isEnabledFor(next, location.hostname);
    if (wasOn && !isOn) return this.deactivate();
    if (!wasOn && isOn) return this.activate();
    if (this.store) {
      this.store.setState({ mode: next.subtitleMode, style: next.style });
      this.session?.onModeChanged(next.subtitleMode);
    }
    this.updateNativeCaptions();
  }

  private activate(): void {
    if (this.active) return;
    const d = (this.active = this.root.child());
    const detector = new VideoDetector(document, (video) => this.onVideo(video));
    d.add(() => detector.dispose());
    d.add(() => this.teardownVideo());
    d.add(() => {
      this.port?.dispose();
      this.port = null;
    });

    // YouTube là SPA: cùng 1 thẻ <video> phát nhiều video. Theo dõi đổi videoId trên MỌI trang YouTube
    // (kể cả khi vào từ trang chủ), không phụ thuộc trang lúc kích hoạt.
    if (isYouTubeHost(location.hostname)) {
      const offNav = watchYouTubeNavigation((videoId) => {
        log("YouTube đổi video →", videoId);
        const v = detector.getCurrent() || this.currentVideo || document.querySelector("video");
        this.onVideo(v);
      }, getSharedHookClient());
      d.add(offNav);
    }

    detector.start();
    log("đã kích hoạt trên", location.hostname);
  }

  private deactivate(): void {
    this.active?.disposeAll();
    this.active = null;
    log("đã tắt trên", location.hostname);
  }

  private getPort(): BackgroundPort {
    if (!this.port) this.port = new BackgroundPort();
    return this.port;
  }

  private fetchText = async (url: string): Promise<string> => {
    const res = await this.getPort().request<Extract<B2C, { type: "fetchText.result" }>>({
      type: "fetchText",
      reqId: newReqId(),
      url,
    });
    if (!res.ok || typeof res.text !== "string") throw new Error(res.error || "fetchText lỗi");
    return res.text;
  };

  private pickAdapter(): SiteAdapter {
    if (typeof location !== "undefined") {
      const yt = createYouTubeAdapter({
        preferManual: this.settings.youtube?.preferManual ?? true,
        onNotify: (msg) => this.store?.setState({ message: msg }),
      });
      if (yt.matches(location)) {
        return yt;
      }
    }
    return createHtml5Adapter(this.fetchText);
  }

  private updateNativeCaptions(): void {
    if (!isYouTubeHost(location.hostname)) return;
    const hide =
      (this.settings.youtube?.hideNativeCaptions ?? true) &&
      this.settings.subtitleMode !== "off" &&
      this.session !== null &&
      this.session.getItems().length > 0;
    setYouTubeNativeCaptionsHidden(hide, document);
  }

  private teardownVideo(): void {
    this.generation++;
    this.currentVideo = null;
    if (isYouTubeHost(location.hostname)) setYouTubeNativeCaptionsHidden(false, document);
    this.session?.dispose();
    this.session = null;
    this.videoScope?.disposeAll();
    this.videoScope = null;
    this.store?.dispose();
    this.store = null;
  }

  private onVideo(video: HTMLVideoElement | null): void {
    this.teardownVideo();
    if (!video || !this.active) return;
    this.currentVideo = video;
    const gen = this.generation;
    const scope = (this.videoScope = this.active.child());
    const adapter = this.pickAdapter();

    const trySetup = async () => {
      if (gen !== this.generation || this.session) return;
      const sources = await adapter.listSources(video);
      if (gen !== this.generation || this.session || sources.length === 0) {
        for (const s of sources) if (gen !== this.generation || this.session) s.dispose();
        if (sources.length === 0) log("video chưa có nguồn phụ đề phù hợp");
        return;
      }
      this.startSession(video, adapter, sources[0], scope, gen);
      for (const s of sources.slice(1)) s.dispose();
    };

    // Player thêm <track> sau khi tải (đối với HTML5 track thông thường)
    video.textTracks?.addEventListener?.("addtrack", () => void trySetup(), {
      signal: scope.signal,
    });
    void trySetup();
  }

  private startSession(
    video: HTMLVideoElement,
    adapter: SiteAdapter,
    source: SubtitleSource,
    scope: Disposer,
    gen: number
  ): void {
    const store = (this.store = new OverlayStore({
      mode: this.settings.subtitleMode,
      style: this.settings.style,
    }));
    const native = new NativeTrackFallback(video);
    scope.add(() => native.dispose());

    const session = new Session(video, source, store, native, {
      onSourceChanged:
        adapter.rebuildOnSourceChange === false
          ? undefined
          : () => {
              log("video đổi nguồn → dựng lại session");
              if (gen === this.generation) this.onVideo(video);
            },
    });
    this.session = session;

    const overlay = new OverlayHost(video, store, {
      container: adapter.getOverlayContainer(video),
      onNativeFallback: (on) => {
        if (on) native.enable([...session.getItems()], store.getState().mode);
        else native.disable();
      },
    });
    scope.add(() => overlay.dispose());

    // Kiểm tra và tự động ẩn overlay khi YouTube đang phát quảng cáo (ad-showing)
    if (typeof adapter.isAdPlaying === "function") {
      const checkAd = () => {
        const ad = adapter.isAdPlaying?.() ?? false;
        store.setState({ visible: !ad });
      };
      checkAd();
      scope.interval(checkAd, 500);
    }

    session
      .start()
      .then((n) => {
        if (gen !== this.generation) return;
        log(`session ${source.track.trackKey}: ${n} cue`);
        if (n === 0) {
          store.setState({ message: "Không đọc được phụ đề của video này" });
        } else {
          this.updateNativeCaptions();
        }
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.warn("[SubTrans] session lỗi:", err);
      });
  }
}

// Chỉ chạy khi có DOM (an toàn với môi trường test)
if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.id) {
  void new ContentController().init().catch((err) => {
    if (import.meta.env.DEV) console.warn("[SubTrans] content init lỗi:", err);
  });
}

export {};
