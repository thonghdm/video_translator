/**
 * SubTrans Extension — Điểm vào content script (ISOLATED world, mọi frame) — PLAN 4.11 & Phase 5
 * Luồng: settings → dò video → adapter (YouTube / HTML5) → overlay + session.
 * Phase 5: Hỗ trợ adapter YouTube, bắt timedtext, tự fetch json3 trong MAIN world,
 * ẩn CC gốc theo cài đặt hideNativeCaptions, phát hiện quảng cáo và chuyển trang SPA.
 */

import {
  isEnabledFor,
  loadSettings,
  onSettingsChanged,
  saveSettings,
  type Settings,
} from "../shared/settings";
import type { SubtitleMode } from "../shared/types";
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
import { ImportedSubtitleSource } from "./adapters/imported";
import type { SiteAdapter, SubtitleSource } from "./adapters/types";
import { OverlayHost } from "./overlay/mount";
import { OverlayStore } from "./overlay/store";
import { NativeTrackFallback } from "./overlay/nativeTrackFallback";
import { Session } from "./pipeline/session";
import { BackgroundPort, newReqId } from "./port";
import { buildSubtitleContent } from "../shared/subtitleFormat";
import type { B2C, PopupToTab, TabStatus } from "../shared/messages";

const log = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.log("[SubTrans]", ...args);
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable || target.getAttribute("contenteditable") === "true") return true;
  return false;
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
  private offset = 0;

  public async init(): Promise<void> {
    // Content script KHÔNG đọc API key (PLAN 3.4)
    this.settings = await loadSettings({ includeApiKey: false });
    this.root.add(
      onSettingsChanged((s) => this.applySettings(s), { includeApiKey: false })
    );

    // Lắng nghe các thông điệp từ Popup (tab.status, tab.export)
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(
        (msg: PopupToTab, _sender, sendResponse: (res: any) => void) => {
          if (!msg || typeof msg !== "object") return;
          // Content script chạy ở MỌI frame (all_frames). Popup chỉ nhận câu trả lời ĐẦU TIÊN, nên frame
          // không có session KHÔNG được trả lời — nếu không, iframe quảng cáo/chat sẽ báo "không có video".
          // Không frame nào có session → popup nhận lastError → hiển thị "chưa có video được hỗ trợ".
          if (!this.session) return;
          if (msg.type === "tab.status") {
            sendResponse(this.getTabStatus());
            return false;
          }
          if (msg.type === "tab.export") {
            const ok = this.handleExport(msg.format, msg.mode);
            sendResponse({ ok });
            return false;
          }
        }
      );
    }

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
    this.session?.onSettingsChanged(next);
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

    // Đăng ký phím tắt bàn phím (V: đổi chế độ phụ đề, G/H: chỉnh lệch thời gian)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!this.settings.shortcuts?.enabled) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;

      const key = e.key.toLowerCase();
      if (key === "v") {
        e.stopPropagation();
        e.preventDefault();
        this.cycleSubtitleMode();
      } else if (key === "g") {
        e.stopPropagation();
        e.preventDefault();
        this.adjustOffset(-0.1);
      } else if (key === "h") {
        e.stopPropagation();
        e.preventDefault();
        this.adjustOffset(0.1);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    d.add(() => window.removeEventListener("keydown", handleKeyDown, true));

    detector.start();
    log("đã kích hoạt trên", location.hostname);
  }

  private cycleSubtitleMode(): void {
    const current = this.settings.subtitleMode;
    const modes: SubtitleMode[] = ["bilingual", "vi", "en", "off"];
    const idx = modes.indexOf(current);
    const nextMode = modes[(idx + 1) % modes.length];

    const labels: Record<SubtitleMode, string> = {
      bilingual: "Song ngữ",
      vi: "Chỉ tiếng Việt",
      en: "Chỉ tiếng Anh",
      off: "Tắt phụ đề",
    };

    this.store?.flashToast(`Chế độ phụ đề: ${labels[nextMode]}`);
    void saveSettings({ subtitleMode: nextMode });
  }

  private adjustOffset(delta: number): void {
    const trackKey = this.session?.track?.trackKey;
    this.offset = Math.round((this.offset + delta) * 10) / 10;
    this.store?.setState({ offset: this.offset });
    const sign = this.offset > 0 ? "+" : "";
    this.store?.flashToast(`Độ lệch phụ đề: ${sign}${this.offset.toFixed(1)}s`);

    if (trackKey && typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ [`offset:${trackKey}`]: this.offset });
    }
  }

  private resetOffset(): void {
    const trackKey = this.session?.track?.trackKey;
    this.offset = 0;
    this.store?.setState({ offset: 0 });
    this.store?.flashToast("Độ lệch phụ đề: 0.0s");

    if (trackKey && typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ [`offset:${trackKey}`]: 0 });
    }
  }

  private async loadSavedOffset(trackKey: string): Promise<void> {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        const key = `offset:${trackKey}`;
        const data = await chrome.storage.local.get(key);
        if (typeof data[key] === "number") {
          this.offset = data[key];
          this.store?.setState({ offset: this.offset });
          return;
        }
      } catch {
        // Ignored
      }
    }
    this.offset = 0;
    this.store?.setState({ offset: 0 });
  }

  private async handleImportFile(file: File): Promise<void> {
    if (!this.currentVideo || !this.active) return;
    try {
      const source = await ImportedSubtitleSource.fromFile(file);
      this.store?.flashToast(`Đã nạp phụ đề: ${file.name}`);
      const scope = this.videoScope ?? this.active.child();
      this.videoScope = scope;
      this.startSession(this.currentVideo, this.pickAdapter(), source, scope, this.generation);
    } catch (err) {
      this.store?.flashToast("Lỗi đọc file phụ đề");
      if (import.meta.env.DEV) console.warn("[SubTrans] import file lỗi:", err);
    }
  }

  private mountOverlayWithoutSession(
    video: HTMLVideoElement,
    adapter: SiteAdapter,
    scope: Disposer,
    _gen: number
  ): void {
    if (this.store) return;
    const store = (this.store = new OverlayStore({
      mode: this.settings.subtitleMode,
      style: this.settings.style,
      hasTrack: false,
      message: "Chưa có phụ đề (bấm Nhập để thêm .srt/.vtt)",
    }));

    const overlay = new OverlayHost(video, store, {
      container: adapter.getOverlayContainer(video),
      onImportFile: (file) => void this.handleImportFile(file),
      onExport: (format, mode) => this.handleExport(format, mode),
      onOffsetChange: (delta) => this.adjustOffset(delta),
      onOffsetReset: () => this.resetOffset(),
    });
    scope.add(() => overlay.dispose());
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
    this.offset = 0;
    if (isYouTubeHost(location.hostname)) setYouTubeNativeCaptionsHidden(false, document);
    this.session?.dispose();
    this.session = null;
    this.videoScope?.disposeAll();
    this.videoScope = null;
    this.store?.dispose();
    this.store = null;
  }

  private getTabStatus(): TabStatus {
    if (!this.session) {
      return {
        active: false,
        total: 0,
        translated: 0,
        byEngine: { api: 0, cloud: 0 },
      };
    }

    const items = this.session.getItems();
    let translated = 0;
    let apiCount = 0;
    let cloudCount = 0;

    for (const it of items) {
      if (it.translated) {
        translated++;
        if (it.engine === "api") apiCount++;
        else if (it.engine === "cloud") cloudCount++;
      }
    }

    return {
      active: true,
      platform: this.session.track?.platform || (isYouTubeHost(location.hostname) ? "youtube" : "web"),
      title: this.session.track?.title || document.title,
      total: items.length,
      translated,
      byEngine: { api: apiCount, cloud: cloudCount },
      message: this.store?.getState().message || undefined,
    };
  }

  private handleExport(
    format: "srt" | "vtt",
    mode: "source" | "target" | "bilingual"
  ): boolean {
    const items = [...(this.session?.getItems() ?? [])];
    if (items.length === 0) return false;

    const content = buildSubtitleContent(items, format, mode);
    const rawTitle = this.session?.track?.title || document.title || "subtitles";
    const cleanTitle = rawTitle.replace(/[/\\?%*:|"<>]/g, "-").trim();
    const modeLabel = mode === "bilingual" ? "bilingual" : mode === "target" ? "vi" : "en";
    const filename = `${cleanTitle}.${modeLabel}.${format}`;

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.store?.flashToast(`Đã xuất file .${format}`);
    return true;
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
      if (gen !== this.generation || this.session) return;
      if (sources.length === 0) {
        log("video chưa có nguồn phụ đề phù hợp");
        this.mountOverlayWithoutSession(video, adapter, scope, gen);
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
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }

    void this.loadSavedOffset(source.track.trackKey);

    const store = (this.store =
      this.store ??
      new OverlayStore({
        mode: this.settings.subtitleMode,
        style: this.settings.style,
      }));
    store.setState({
      hasTrack: true,
      trackTitle: source.track.title,
      offset: this.offset,
      message: null,
    });

    const native = new NativeTrackFallback(video);
    scope.add(() => native.dispose());

    const session = new Session(video, source, store, native, {
      port: this.getPort(),
      settings: this.settings,
      getOffset: () => this.offset,
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
      onImportFile: (file) => void this.handleImportFile(file),
      onExport: (format, mode) => this.handleExport(format, mode),
      onOffsetChange: (delta) => this.adjustOffset(delta),
      onOffsetReset: () => this.resetOffset(),
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
