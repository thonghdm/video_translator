/**
 * SubTrans Extension — DubbingManager (Content Script)
 * Phù hợp với PLAN-tts.md (Phase 13, Bước 2)
 *
 * - Giải mã MP3 Base64 và phát qua Web Audio API (AudioContext + GainNode + AudioBufferSourceNode)
 *   để vượt CSP media-src của trang web và không cần quản lý blob: URL.
 * - Đo audioBuffer.duration thật để cân chỉnh playbackRate (1.0..1.45) theo thời lượng còn lại của cue.
 * - Hỗ trợ Pause/Resume giữa câu (suspend/resume), Audio Ducking an toàn, Lookahead Prefetch,
 *   LRU Cache 60 câu, chống đọc lặp Hybrid (lastSpokenCueId) và Error Cooldown 30s.
 */

import type { SubtitleItem } from "../../shared/types";
import type { Settings } from "../../shared/settings";
import type { B2C } from "../../shared/messages";
import { LRUCache } from "../../shared/lru";
import { newReqId, type BackgroundPort } from "../port";

const MAX_CACHE_ITEMS = 60;
const MAX_PREFETCH_AHEAD = 2;
const MAX_PLAYBACK_RATE = 1.45;
const MIN_CUE_REMAINING_SEC = 0.4;
const EXPIRED_CUE_MARGIN_SEC = 0.15;
const LATE_TRANSLATION_MARGIN_SEC = 0.2;
const DUCK_RESTORE_DELAY_MS = 250;
const ERROR_COOLDOWN_THRESHOLD = 3;
const ERROR_COOLDOWN_MS = 30_000;

export interface DubbingManagerOptions {
  onStatusNotice?: (msg: string) => void;
  createAudioContext?: () => AudioContext;
  getPlayhead?: () => number;
}

/** Làm tròn bội số 5 và định dạng chuỗi tốc độ SSML ("+0%", "+15%", "-10%") */
export function formatRateOffset(offset: number): string {
  const clamped = Math.min(50, Math.max(-20, Number.isFinite(offset) ? offset : 0));
  const rounded = Math.round(clamped / 5) * 5;
  const val = rounded === 0 ? 0 : rounded;
  return val >= 0 ? `+${val}%` : `${val}%`;
}

/** Làm sạch văn bản phụ đề trước khi gửi TTS */
export function cleanTextForTts(raw: string): string {
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/[♪♫♬♩]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  // Bỏ qua các dòng chỉ gồm ngoặc ghi chú âm thanh như [âm nhạc], (vỗ tay)
  if (/^[\[(][^\])]{1,40}[\])]$/.test(text)) return "";
  return text;
}

/** Giải mã Base64 thành Uint8Array */
export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Tính playbackRate mục tiêu (1.0..1.45) dựa trên duration thật của AudioBuffer */
export function computePlaybackRate(
  audioDurationSec: number,
  remainingCueSec: number
): number {
  const safeRemaining = Math.max(MIN_CUE_REMAINING_SEC, remainingCueSec);
  const needed = audioDurationSec > safeRemaining ? audioDurationSec / safeRemaining : 1.0;
  return Math.min(MAX_PLAYBACK_RATE, Math.max(1.0, Math.round(needed * 100) / 100));
}

export class DubbingManager {
  private settings: Settings;
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private readonly cache = new LRUCache<string, AudioBuffer>(MAX_CACHE_ITEMS);
  private readonly inFlight = new Map<
    string,
    { reqId: string; promise: Promise<AudioBuffer | null> }
  >();

  private activeSource: AudioBufferSourceNode | null = null;
  private activeCue: SubtitleItem | null = null;
  private activeBuffer: AudioBuffer | null = null;
  private lastSpokenCueId: number | null = null;
  private playGeneration = 0;

  // Audio Ducking state
  private savedVideoVolume: number | null = null;
  private isApplyingDucking = false;
  private duckRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  // Autoplay unlock state
  private autoplayNoticeShown = false;
  private unlockCleanup: (() => void) | null = null;

  // Error cooldown state
  private consecutiveErrors = 0;
  private cooldownUntil = 0;
  private disposed = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly port: BackgroundPort,
    initialSettings: Settings,
    private readonly opts: DubbingManagerOptions = {}
  ) {
    this.settings = initialSettings;
  }

  private getPlayhead(): number {
    return this.opts.getPlayhead ? this.opts.getPlayhead() : this.video.currentTime;
  }

  private ensureAudioContext(): { ctx: AudioContext; gain: GainNode } | null {
    if (this.disposed) return null;
    if (this.audioCtx && this.gainNode) {
      return { ctx: this.audioCtx, gain: this.gainNode };
    }
    try {
      const factory =
        this.opts.createAudioContext ??
        (() => {
          const Ctor =
            globalThis.AudioContext ||
            (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (!Ctor) throw new Error("Web Audio API không khả dụng");
          return new Ctor();
        });
      const ctx = factory();
      const gain = ctx.createGain();
      gain.gain.value = this.settings.tts.ttsVolume;
      gain.connect(ctx.destination);
      this.audioCtx = ctx;
      this.gainNode = gain;
      return { ctx, gain };
    } catch (err) {
      if (import.meta.env?.DEV) {
        console.warn("[SubTrans][TTS] Không tạo được AudioContext:", err);
      }
      return null;
    }
  }

  private closeAudioContextAndClearCache(): void {
    this.stopActiveSource();
    this.cancelAllInFlight();
    this.cache.clear();
    const ctx = this.audioCtx;
    this.audioCtx = null;
    this.gainNode = null;
    if (ctx && typeof ctx.close === "function") {
      void Promise.resolve(ctx.close()).catch(() => {});
    }
  }

  public updateSettings(next: Settings): void {
    const prevTts = this.settings.tts;
    this.settings = next;

    if (!next.tts.enabled) {
      this.lastSpokenCueId = null;
      this.restoreDuckingNow();
      this.closeAudioContextAndClearCache();
      return;
    }

    if (this.gainNode && prevTts.ttsVolume !== next.tts.ttsVolume) {
      this.gainNode.gain.value = next.tts.ttsVolume;
    }

    // Nếu đang ducking và người dùng kéo slider duckingVolume thì áp dụng ngay
    if (
      this.savedVideoVolume !== null &&
      prevTts.duckingVolume !== next.tts.duckingVolume
    ) {
      this.setVideoVolumeInternal(
        Math.min(this.savedVideoVolume, next.tts.duckingVolume)
      );
    }
  }

  /**
   * Gọi từ Session.tick() mỗi khi đổi dòng phụ đề hoặc dòng hiện tại vừa nhận bản dịch mới.
   */
  public onCueTick(
    playhead: number,
    item: SubtitleItem | null,
    allItems: readonly SubtitleItem[]
  ): void {
    if (this.disposed || !this.settings.tts.enabled) return;
    if (this.video.paused || this.video.ended) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (!item || item.ignored) return;

    // Chưa dịch xong thì chưa gán lastSpokenCueId để khi dịch xong sẽ đọc bù
    if (!item.translated) return;
    const cleanText = cleanTextForTts(item.target_text || "");
    if (!cleanText) return;

    // Chống đọc lặp Hybrid: câu này đã được kích hoạt đọc trước đó
    if (item.id === this.lastSpokenCueId) {
      // Vẫn prefetch các câu tiếp theo phòng trường hợp vừa có thêm bản dịch
      this.prefetchUpcoming(item.id, allItems);
      return;
    }

    // Kiểm tra câu đã quá hạn (đặc biệt khi dịch muộn)
    if (playhead >= item.end_sec - LATE_TRANSLATION_MARGIN_SEC) {
      return;
    }

    // Chính sách chồng chéo: cắt câu cũ ngay khi cue mới tới hạn
    if (this.activeSource && this.activeCue && this.activeCue.id !== item.id) {
      this.stopActiveSource();
    }

    this.lastSpokenCueId = item.id;
    const gen = ++this.playGeneration;

    // Ưu tiên phát câu hiện tại trước, sau đó mới prefetch 1–2 câu kế tiếp đã dịch
    void this.synthesizeAndPlay(item, cleanText, gen);
    this.prefetchUpcoming(item.id, allItems);
  }

  public onPause(): void {
    if (this.disposed) return;
    if (this.activeSource && this.audioCtx && this.audioCtx.state === "running") {
      void Promise.resolve(this.audioCtx.suspend()).catch(() => {});
    }
    this.restoreDuckingNow();
  }

  public onPlay(): void {
    if (this.disposed || !this.settings.tts.enabled) return;
    if (
      this.activeSource &&
      this.activeCue &&
      this.audioCtx &&
      this.audioCtx.state === "suspended"
    ) {
      const t = this.getPlayhead();
      if (t >= this.activeCue.start_sec - 0.5 && t <= this.activeCue.end_sec) {
        this.applyDucking();
        void Promise.resolve(this.audioCtx.resume()).catch(() => {});
        return;
      }
      // Playhead không còn trong cue cũ → dừng source cũ
      this.stopActiveSource();
    }
  }

  public onEnded(): void {
    this.stopActiveSource();
    this.restoreDuckingNow();
  }

  public onSeeking(): void {
    this.playGeneration++;
    this.stopActiveSource();
    this.cancelAllInFlight();
    this.lastSpokenCueId = null;
    this.restoreDuckingNow();
  }

  public onSeeked(): void {
    this.lastSpokenCueId = null;
  }

  public onRateChange(): void {
    if (!this.activeSource || !this.activeCue || !this.activeBuffer) return;
    const nowPlayhead = this.getPlayhead();
    const remainingCueSec =
      (this.activeCue.end_sec - Math.max(this.activeCue.start_sec, nowPlayhead)) /
      Math.max(0.25, this.video.playbackRate || 1);
    const nextRate = computePlaybackRate(this.activeBuffer.duration, remainingCueSec);
    this.activeSource.playbackRate.value = nextRate;
  }

  public onVolumeChange(): void {
    if (this.isApplyingDucking) return;
    if (this.savedVideoVolume !== null) {
      // Người dùng tự kéo thanh âm lượng trong lúc đang ducking → cập nhật mức gốc để tôn trọng người dùng
      this.savedVideoVolume = this.video.volume;
    }
  }

  public onVisibilityChange(): void {
    if (typeof document !== "undefined" && document.hidden) {
      this.onPause();
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playGeneration++;
    this.clearUnlockListeners();
    this.restoreDuckingNow();
    this.closeAudioContextAndClearCache();
    this.lastSpokenCueId = null;
  }

  // ---------------------------------------------------------------------------
  // Internal synthesis, decoding & playback
  // ---------------------------------------------------------------------------

  private buildCacheKey(cleanText: string): { key: string; rateStr: string } {
    const rateStr = formatRateOffset(this.settings.tts.rateOffset);
    const key = `${this.settings.tts.voice}|${rateStr}|${cleanText}`;
    return { key, rateStr };
  }

  private async fetchAudioBuffer(cleanText: string): Promise<AudioBuffer | null> {
    if (this.disposed || !this.settings.tts.enabled) return null;
    if (Date.now() < this.cooldownUntil) return null;

    const audio = this.ensureAudioContext();
    if (!audio) return null;

    const { key, rateStr } = this.buildCacheKey(cleanText);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;

    const reqId = newReqId();
    const ctxAtStart = audio.ctx;

    const promise = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await this.port.request<Extract<B2C, { type: "tts.result" }>>({
          type: "tts.synthesize",
          reqId,
          text: cleanText,
          voice: this.settings.tts.voice,
          rate: rateStr,
        });

        if (this.disposed || this.audioCtx !== ctxAtStart) return null;

        if (!res || !res.ok || !res.audioBase64) {
          this.recordError();
          return null;
        }

        const bytes = base64ToUint8Array(res.audioBase64);
        // Truyền bản sao ArrayBuffer vì decodeAudioData làm detach buffer đầu vào
        const bufferCopy = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(bufferCopy).set(bytes);
        const decoded = await ctxAtStart.decodeAudioData(bufferCopy);

        if (this.disposed || this.audioCtx !== ctxAtStart) return null;

        this.consecutiveErrors = 0;
        this.cache.set(key, decoded);
        return decoded;
      } catch {
        if (!this.disposed && this.settings.tts.enabled) {
          this.recordError();
        }
        return null;
      } finally {
        const cur = this.inFlight.get(key);
        if (cur && cur.reqId === reqId) {
          this.inFlight.delete(key);
        }
      }
    })();

    this.inFlight.set(key, { reqId, promise });
    return promise;
  }

  private async synthesizeAndPlay(
    item: SubtitleItem,
    cleanText: string,
    gen: number
  ): Promise<void> {
    const audioBuffer = await this.fetchAudioBuffer(cleanText);
    if (!audioBuffer) return;
    if (this.disposed || !this.settings.tts.enabled || gen !== this.playGeneration) return;
    if (this.video.paused || this.video.ended) return;

    const nowPlayhead = this.getPlayhead();
    // Nếu mạng trễ khiến video đã chạy qua mốc kết thúc của cue thì bỏ qua không phát
    if (nowPlayhead >= item.end_sec - EXPIRED_CUE_MARGIN_SEC) {
      return;
    }

    const audio = this.ensureAudioContext();
    if (!audio) return;

    audio.gain.gain.value = this.settings.tts.ttsVolume;

    // Xử lý Autoplay Policy nếu AudioContext đang suspended
    if (audio.ctx.state === "suspended") {
      try {
        await audio.ctx.resume();
      } catch {
        this.handleAutoplayBlocked();
        return;
      }
      if (audio.ctx.state === "suspended") {
        this.handleAutoplayBlocked();
        return;
      }
    }

    if (this.disposed || !this.settings.tts.enabled || gen !== this.playGeneration) return;

    this.stopActiveSource();

    const remainingCueSec =
      (item.end_sec - Math.max(item.start_sec, nowPlayhead)) /
      Math.max(0.25, this.video.playbackRate || 1);
    const playbackRate = computePlaybackRate(audioBuffer.duration, remainingCueSec);

    const source = audio.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = playbackRate;
    source.connect(audio.gain);

    this.activeSource = source;
    this.activeCue = item;
    this.activeBuffer = audioBuffer;

    source.onended = () => {
      if (this.activeSource === source) {
        this.activeSource = null;
        this.activeCue = null;
        this.activeBuffer = null;
        this.scheduleRestoreDucking();
      }
    };

    this.applyDucking();
    try {
      source.start(0);
    } catch {
      this.activeSource = null;
      this.activeCue = null;
      this.activeBuffer = null;
      this.restoreDuckingNow();
    }
  }

  private prefetchUpcoming(
    currentId: number,
    allItems: readonly SubtitleItem[]
  ): void {
    if (Date.now() < this.cooldownUntil) return;
    let queued = 0;
    for (let i = 0; i < allItems.length && queued < MAX_PREFETCH_AHEAD; i++) {
      const it = allItems[i];
      if (it.id <= currentId || it.ignored || !it.translated) continue;
      const clean = cleanTextForTts(it.target_text || "");
      if (!clean) continue;
      queued++;
      const { key } = this.buildCacheKey(clean);
      if (this.cache.get(key) || this.inFlight.has(key)) continue;
      void this.fetchAudioBuffer(clean);
    }
  }

  private stopActiveSource(): void {
    const src = this.activeSource;
    this.activeSource = null;
    this.activeCue = null;
    this.activeBuffer = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // đã dừng trước đó
      }
      try {
        src.disconnect();
      } catch {
        // bỏ qua
      }
    }
  }

  private cancelAllInFlight(): void {
    for (const entry of this.inFlight.values()) {
      this.port.cancel(entry.reqId);
    }
    this.inFlight.clear();
  }

  private recordError(): void {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= ERROR_COOLDOWN_THRESHOLD) {
      this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      this.consecutiveErrors = 0;
      this.opts.onStatusNotice?.(
        "Lồng tiếng tạm ngưng 30s do lỗi kết nối Edge TTS"
      );
    }
  }

  private handleAutoplayBlocked(): void {
    if (!this.autoplayNoticeShown) {
      this.autoplayNoticeShown = true;
      this.opts.onStatusNotice?.(
        "Nhấp vào vùng video để mở khóa âm thanh lồng tiếng"
      );
    }
    if (this.unlockCleanup || typeof document === "undefined") return;
    const unlock = () => {
      this.clearUnlockListeners();
      if (this.audioCtx && this.audioCtx.state === "suspended") {
        void Promise.resolve(this.audioCtx.resume()).catch(() => {});
      }
    };
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    this.unlockCleanup = () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }

  private clearUnlockListeners(): void {
    this.unlockCleanup?.();
    this.unlockCleanup = null;
  }

  // ---------------------------------------------------------------------------
  // Audio Ducking
  // ---------------------------------------------------------------------------

  private setVideoVolumeInternal(vol: number): void {
    const clamped = Math.min(1, Math.max(0, vol));
    this.isApplyingDucking = true;
    try {
      this.video.volume = clamped;
    } finally {
      this.isApplyingDucking = false;
    }
  }

  private applyDucking(): void {
    if (this.duckRestoreTimer) {
      clearTimeout(this.duckRestoreTimer);
      this.duckRestoreTimer = null;
    }
    if (this.savedVideoVolume === null) {
      this.savedVideoVolume = this.video.volume;
    }
    const target = Math.min(this.savedVideoVolume, this.settings.tts.duckingVolume);
    this.setVideoVolumeInternal(target);
  }

  private scheduleRestoreDucking(): void {
    if (this.duckRestoreTimer) clearTimeout(this.duckRestoreTimer);
    this.duckRestoreTimer = setTimeout(() => {
      this.duckRestoreTimer = null;
      if (!this.activeSource) {
        this.restoreDuckingNow();
      }
    }, DUCK_RESTORE_DELAY_MS);
  }

  private restoreDuckingNow(): void {
    if (this.duckRestoreTimer) {
      clearTimeout(this.duckRestoreTimer);
      this.duckRestoreTimer = null;
    }
    if (this.savedVideoVolume !== null) {
      const vol = this.savedVideoVolume;
      this.savedVideoVolume = null;
      this.setVideoVolumeInternal(vol);
    }
  }
}
