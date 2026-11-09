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
import { createCourseAdapter } from "./adapters/course";
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
import { initDriveTopFrame } from "./drive/driveIndex";
import { getVideoDocId, isDrivePlayerFrame } from "./drive/driveFrame";
import { defaultSleep, requestSidecar, type SidecarClientDeps } from "./drive/sidecarClient";
import type { SidecarFailReason } from "../shared/driveTypes";

const log = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.log("[SubTrans]", ...args);
};

function isEditable(el: EventTarget | null | undefined): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox";
}

/**
 * Người dùng đang gõ chữ? Dùng composedPath() vì e.target bị "retarget" về host khi ô nhập nằm trong
 * Shadow DOM (ví dụ ô bình luận/tìm kiếm của nhiều trang) — chỉ xét e.target sẽ chặn nhầm phím khi gõ.
 */
export function isTypingEvent(e: Pick<KeyboardEvent, "target" | "composedPath">): boolean {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  if (path.length > 0) return path.some((n) => isEditable(n));
  return isEditable(e.target);
}

export class ContentController {
  private settings!: Settings;
  private readonly root = new Disposer();
  private active: Disposer | null = null;
  private videoScope: Disposer | null = null;
  private port: BackgroundPort | null = null;
  private store: OverlayStore | null = null;
  private session: Session | null = null;
  /** View của video hiện tại (store + overlay + native fallback + theo dõi quảng cáo) — tạo ĐÚNG 1 lần mỗi video */
  private view: { store: OverlayStore; overlay: OverlayHost; native: NativeTrackFallback } | null = null;
  /** Scope riêng của session: đổi nguồn phụ đề (nhập file) chỉ thay session, KHÔNG tạo overlay mới */
  private sessionScope: Disposer | null = null;
  private currentVideo: HTMLVideoElement | null = null;
  private generation = 0;
  private offset = 0;
  private sessionOrigin: "adapter" | "sidecar" | "user" | null = null;
  /** null = đã xác định là không có, không hỏi lại */
  private sidecarCache = new Map<string, { fileName: string; text: string } | null>();

  public async init(): Promise<void> {
    // Content script KHÔNG đọc API key (PLAN 3.4)
    this.settings = await loadSettings({ includeApiKey: false });
    this.root.add(
      onSettingsChanged((s) => this.applySettings(s), { includeApiKey: false })
    );

    // Lắng nghe các thông điệp từ Popup (tab.status, tab.export)
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      const onPopupMessage = (msg: PopupToTab, _sender: unknown, sendResponse: (res: unknown) => void) => {
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
          return undefined;
        };
      chrome.runtime.onMessage.addListener(onPopupMessage);
      this.root.add(() => chrome.runtime.onMessage.removeListener?.(onPopupMessage));
    }

    if (isEnabledFor(this.settings, location.hostname)) this.activate();
  }

  public getSessionOrigin(): "adapter" | "sidecar" | "user" | null {
    return this.sessionOrigin;
  }

  public getSession(): Session | null {
    return this.session;
  }

  public getStore(): OverlayStore | null {
    return this.store;
  }

  public handleImportFileForTest(file: File): Promise<void> {
    return this.handleImportFile(file);
  }

  public onVideoForTest(video: HTMLVideoElement | null): void {
    this.onVideo(video);
  }

  /** Dọn toàn bộ (listener, overlay, session, port) — dùng khi content script được nạp lại trên cùng trang */
  public dispose(): void {
    this.deactivate();
    this.root.disposeAll();
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
      // Chỉ khi frame này đang có phụ đề — nếu không, V/G/H sẽ bị chặn trên MỌI trang web
      // (Gmail, GitHub, trình soạn thảo... đều dùng các phím này).
      if (!this.session || !this.store || !this.store.getState().hasTrack) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if (isTypingEvent(e)) return;

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
    this.view?.native.setOffset(this.offset);
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
    this.view?.native.setOffset(0);
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
        if (typeof data[key] === "number" && Number.isFinite(data[key])) {
          this.offset = Math.max(-30, Math.min(30, data[key]));
          this.store?.setState({ offset: this.offset });
          this.view?.native.setOffset(this.offset);
          return;
        }
      } catch {
        // Ignored
      }
    }
    this.offset = 0;
    this.store?.setState({ offset: 0 });
    this.view?.native.setOffset(0);
  }

  private async startImported(
    source: ImportedSubtitleSource,
    origin: "user" | "sidecar",
    okToast: string
  ): Promise<boolean> {
    const video = this.currentVideo;
    const scope = this.videoScope;
    if (!video || !this.active || !scope) return false;
    const gen = this.generation;
    const n = (await source.load()).length;
    if (gen !== this.generation) return false;
    if (origin === "sidecar" && this.sessionOrigin === "user") {
      source.dispose();
      return false;
    }
    if (n === 0) {
      source.dispose();
      this.store?.flashToast("File không có dòng phụ đề hợp lệ (.srt/.vtt)");
      return false;
    }
    this.startSession(video, this.pickAdapter(), source, scope, gen, origin);
    this.store?.flashToast(okToast);
    return true;
  }

  private async handleImportFile(file: File): Promise<void> {
    const video = this.currentVideo;
    const scope = this.videoScope;
    if (!video || !this.active || !scope) return;
    const gen = this.generation;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("File quá lớn (> 5MB)");
      const source = await ImportedSubtitleSource.fromFile(file);
      if (gen !== this.generation) return; // người dùng đã chuyển video trong lúc đọc file
      await this.startImported(source, "user", `Đã nạp phụ đề: ${file.name}`);
    } catch (err) {
      this.store?.flashToast(`Lỗi đọc file phụ đề${err instanceof Error ? `: ${err.message}` : ""}`);
      if (import.meta.env.DEV) console.warn("[SubTrans] import file lỗi:", err);
    }
  }

  /**
   * Video chưa có phụ đề: chỉ dựng view để người dùng có thể "Nhập .srt/.vtt" từ MiniToolbar
   * (toolbar chỉ hiện khi rê chuột lên video) — KHÔNG hiện thông báo thường trực trên mọi video của mọi trang.
   */
  private mountOverlayWithoutSession(video: HTMLVideoElement, adapter: SiteAdapter, scope: Disposer): void {
    const view = this.ensureView(video, adapter, scope);
    view.store.setState({ hasTrack: false, message: null });
  }

  /** Dựng view cho video (1 lần). Dọn theo scope của video. */
  private ensureView(video: HTMLVideoElement, adapter: SiteAdapter, scope: Disposer) {
    if (this.view) return this.view;
    const store = (this.store = new OverlayStore({
      mode: this.settings.subtitleMode,
      style: this.settings.style,
      offset: this.offset,
    }));
    const native = new NativeTrackFallback(video);
    native.setOffset(this.offset);
    const overlay = new OverlayHost(video, store, {
      container: adapter.getOverlayContainer(video),
      onNativeFallback: (on) => {
        if (on) native.enable([...(this.session?.getItems() ?? [])], store.getState().mode);
        else native.disable();
      },
      onImportFile: (file) => void this.handleImportFile(file),
      onExport: (format, mode) => this.handleExport(format, mode),
      onOffsetChange: (delta) => this.adjustOffset(delta),
      onOffsetReset: () => this.resetOffset(),
    });
    // Ẩn overlay khi YouTube đang phát quảng cáo (ad-showing)
    if (typeof adapter.isAdPlaying === "function") {
      const checkAd = () => store.setState({ visible: !(adapter.isAdPlaying?.() ?? false) });
      checkAd();
      scope.interval(checkAd, 500);
    }
    const view = { store, overlay, native };
    this.view = view;
    scope.add(() => {
      overlay.dispose();
      native.dispose();
      if (this.view === view) this.view = null;
    });
    return view;
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

      const course = createCourseAdapter(this.fetchText);
      if (course.matches(location)) {
        return course;
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
    this.sessionOrigin = null;
    this.sessionScope = null;
    this.videoScope?.disposeAll(); // dọn session, overlay, native, theo dõi quảng cáo
    this.videoScope = null;
    this.view = null;
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

    let running = false;
    let again = false;
    const trySetup = async (): Promise<void> => {
      if (gen !== this.generation || this.session) return;
      // Không chạy chồng: lần gọi đến khi đang chạy sẽ được chạy lại 1 lần sau đó
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const sources = await adapter.listSources(video);
        if (gen !== this.generation || this.session) {
          for (const src of sources) src.dispose(); // không rò listener/timer của source thừa
          return;
        }
        if (sources.length === 0) {
          log("video chưa có nguồn phụ đề phù hợp");
          this.mountOverlayWithoutSession(video, adapter, scope);
          return;
        }
        this.startSession(video, adapter, sources[0], scope, gen, "adapter");
        for (const src of sources.slice(1)) src.dispose();
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[SubTrans] listSources lỗi:", err);
      } finally {
        running = false;
        if (again) {
          again = false;
          void trySetup();
        }
      }
    };

    const { signal } = scope;
    // Player thêm <track> sau khi tải (đối với HTML5 track thông thường)
    video.textTracks?.addEventListener?.("addtrack", () => void trySetup(), { signal });
    // Player nạp dữ liệu muộn (YouTube embed là click-to-play: trước khi bấm play, playerResponse chưa có
    // videoDetails/captionTracks — đã kiểm chứng; player khóa học nạp track sau khi phát) → thử lại khi phát.
    video.addEventListener("loadeddata", () => void trySetup(), { signal });
    video.addEventListener("playing", () => void trySetup(), { signal });
    void trySetup();

    // D0-T1: video của preview Drive nằm trong IFRAME → chỉ frame player mới xin phụ đề.
    // Không gồm top frame: <video> lạc ở top frame (xem trước khi rê chuột, v.v.) không được gắn phụ đề theo tiêu đề preview.
    if (this.settings.drive?.autoSidecar && isDrivePlayerFrame(window)) {
      void this.trySidecar(video, scope, gen);
    }
  }

  private async trySidecar(
    _video: HTMLVideoElement,
    scope: Disposer,
    gen: number
  ): Promise<void> {
    const docId = getVideoDocId(location.href);
    const key = docId ?? null;

    if (key !== null && this.sidecarCache.has(key)) {
      const cached = this.sidecarCache.get(key);
      if (!cached) return;
      if (this.sessionOrigin === "user") return;
      if (gen !== this.generation || scope.signal.aborted) return;
      await this.startImported(
        new ImportedSubtitleSource(cached.fileName, cached.text),
        "sidecar",
        `Đã tự nhận phụ đề: ${cached.fileName}`
      );
      return;
    }

    let r: Awaited<ReturnType<typeof requestSidecar>>;
    try {
      const deps: SidecarClientDeps = {
        request: (msg) => this.getPort().request(msg),
        sleep: defaultSleep,
        newReqId,
      };
      r = await requestSidecar(docId ?? undefined, deps, scope.signal);
    } catch {
      return;
    }

    if (gen !== this.generation || scope.signal.aborted) return;

    if (!r.ok) {
      const cacheableReasons: SidecarFailReason[] = [
        "no_match",
        "ambiguous",
        "not_permitted",
        "not_found",
        "too_large",
        "bad_format",
        "not_drive",
        // KHÔNG cache "disabled": SW có thể chưa nạp kịp setting mới bật → lần onVideo sau phải hỏi lại
      ];
      if (key !== null && cacheableReasons.includes(r.reason)) {
        this.sidecarCache.set(key, null);
      }

      switch (r.reason) {
        case "ambiguous":
          this.store?.flashToast("Có nhiều file trùng tên – bấm Nhập để chọn");
          break;
        case "not_permitted":
          this.store?.flashToast("Không có quyền tải phụ đề – bấm Nhập để chọn file");
          break;
        case "not_found":
          this.store?.flashToast("Không tìm thấy file phụ đề – bấm Nhập");
          break;
        case "too_large":
          this.store?.flashToast("File phụ đề quá lớn (> 1MB)");
          break;
        case "bad_format":
          this.store?.flashToast("File phụ đề không hợp lệ – bấm Nhập");
          break;
        case "network":
        case "timeout":
          this.store?.flashToast("Không tải được phụ đề (mạng) – bấm Nhập");
          break;
        default:
          break;
      }
      return;
    }

    if (key !== null) {
      this.sidecarCache.set(key, { fileName: r.fileName, text: r.text });
    }
    if (this.sessionOrigin === "user") return;
    if (gen !== this.generation || scope.signal.aborted) return;
    await this.startImported(
      new ImportedSubtitleSource(r.fileName, r.text),
      "sidecar",
      `Đã tự nhận phụ đề: ${r.fileName}`
    );
  }

  private startSession(
    video: HTMLVideoElement,
    adapter: SiteAdapter,
    source: SubtitleSource,
    scope: Disposer,
    gen: number,
    origin: "adapter" | "sidecar" | "user"
  ): void {
    // Thay session cũ (nếu có) — overlay/store/native của video được DÙNG LẠI
    this.sessionScope?.disposeAll();
    this.sessionScope = null;

    this.sessionOrigin = origin;

    const view = this.ensureView(video, adapter, scope);
    const store = view.store;
    store.setState({ hasTrack: true, trackTitle: source.track.title, message: null, item: null });
    void this.loadSavedOffset(source.track.trackKey);

    const sessionScope = (this.sessionScope = scope.child());
    const session = new Session(video, source, store, view.native, {
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
    sessionScope.add(() => {
      session.dispose();
      if (this.session === session) {
        this.session = null;
        this.sessionOrigin = null;
      }
      if (this.sessionScope === sessionScope) this.sessionScope = null;
    });
    if (view.native.isActive) view.native.enable([...session.getItems()], store.getState().mode);

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
  // Content script có thể bị nạp lại trên cùng trang (tiêm lại, extension cập nhật): dọn bản cũ trước
  const g = globalThis as unknown as { __subtransContent?: { dispose(): void } };
  try {
    g.__subtransContent?.dispose();
  } catch {
    /* bản cũ thuộc context đã mất */
  }
  const controller = new ContentController();
  g.__subtransContent = controller;
  void controller.init().catch((err) => {
    if (import.meta.env.DEV) console.warn("[SubTrans] content init lỗi:", err);
  });

  // Khởi tạo Drive Top Frame gom index phụ đề (nếu là top frame của Google Drive)
  if (typeof window !== "undefined") {
    initDriveTopFrame(window, document);
  }
}

export {};
