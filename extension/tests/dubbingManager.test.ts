import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DubbingManager,
  computePlaybackRate,
  formatRateOffset,
} from "../src/content/tts/dubbingManager";
import {
  cloneDefaults,
  sanitizeSettings,
  type Settings,
} from "../src/shared/settings";
import type { SubtitleItem } from "../src/shared/types";
import type { BackgroundPort } from "../src/content/port";

const SAMPLE_B64 = btoa("fake-mp3-bytes-1234567890");

interface MockSourceNode {
  buffer: AudioBuffer | null;
  playbackRate: { value: number };
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface MockAudioContext {
  state: AudioContextState;
  destination: object;
  gainNode: { gain: { value: number }; connect: ReturnType<typeof vi.fn> };
  sources: MockSourceNode[];
  decodeCalls: ArrayBuffer[];
  decodeDuration: number;
  createGain: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  decodeAudioData: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createMockAudioContext(decodeDuration = 2.0): MockAudioContext {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
  };
  const sources: MockSourceNode[] = [];
  const decodeCalls: ArrayBuffer[] = [];

  const ctx: MockAudioContext = {
    state: "running",
    destination: {},
    gainNode,
    sources,
    decodeCalls,
    decodeDuration,
    createGain: vi.fn(() => gainNode),
    createBufferSource: vi.fn(() => {
      const src: MockSourceNode = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        started: false,
        stopped: false,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(() => {
          src.started = true;
        }),
        stop: vi.fn(() => {
          src.stopped = true;
        }),
      };
      sources.push(src);
      return src;
    }),
    decodeAudioData: vi.fn(async (buf: ArrayBuffer) => {
      decodeCalls.push(buf);
      return { duration: ctx.decodeDuration } as AudioBuffer;
    }),
    suspend: vi.fn(async () => {
      ctx.state = "suspended";
    }),
    resume: vi.fn(async () => {
      ctx.state = "running";
    }),
    close: vi.fn(async () => {
      ctx.state = "closed";
    }),
  };

  return ctx;
}

type MockVideo = HTMLVideoElement & { paused: boolean; ended: boolean };

function createMockVideo(overrides: Partial<MockVideo> = {}): MockVideo {
  return {
    currentTime: 0,
    paused: false,
    ended: false,
    playbackRate: 1,
    volume: 1.0,
    ...overrides,
  } as unknown as MockVideo;
}

function createItem(partial: Partial<SubtitleItem> & { id: number }): SubtitleItem {
  return {
    block: 0,
    start_sec: 0,
    end_sec: 4,
    source_text: "Hello world",
    target_text: "Xin chào thế giới",
    translated: true,
    engine: "api",
    ...partial,
  };
}

function enabledSettings(overrides: Partial<Settings["tts"]> = {}): Settings {
  const s = cloneDefaults();
  s.tts = { ...s.tts, enabled: true, ...overrides };
  return s;
}

describe("DubbingManager & TTS Settings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sanitizeSettings điền mặc định tts cho settings cũ và làm tròn rateOffset theo bội số 5", () => {
    const legacy = cloneDefaults();
    delete (legacy as unknown as { tts?: unknown }).tts;
    const sanitized = sanitizeSettings(legacy);
    expect(sanitized.tts).toEqual({
      enabled: false,
      voice: "vi-VN-HoaiMyNeural",
      rateOffset: 0,
      ttsVolume: 1,
      duckingVolume: 0.2,
    });

    const dirty = cloneDefaults();
    dirty.tts = {
      enabled: true,
      voice: "invalid-voice" as Settings["tts"]["voice"],
      rateOffset: 17,
      ttsVolume: 2.5,
      duckingVolume: -0.5,
    };
    const fixed = sanitizeSettings(dirty);
    expect(fixed.tts.voice).toBe("vi-VN-HoaiMyNeural");
    expect(fixed.tts.rateOffset).toBe(15);
    expect(fixed.tts.ttsVolume).toBe(1);
    expect(fixed.tts.duckingVolume).toBe(0);
    expect(formatRateOffset(-12)).toBe("-10%");
    expect(formatRateOffset(0)).toBe("+0%");
    expect(computePlaybackRate(4.0, 3.0)).toBe(1.33);
    expect(computePlaybackRate(10.0, 2.0)).toBe(1.45);
  });

  it("1) Giải mã audioBase64 qua decodeAudioData và gán đúng gainNode.gain.value = ttsVolume", async () => {
    const ctx = createMockAudioContext(2.0);
    const video = createMockVideo({ currentTime: 0.1, volume: 1.0 });
    const port = {
      request: vi.fn().mockResolvedValue({
        type: "tts.result",
        reqId: "r1",
        ok: true,
        audioBase64: SAMPLE_B64,
        mime: "audio/mpeg",
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings({ ttsVolume: 0.75 }), {
      createAudioContext: () => ctx as unknown as AudioContext,
    });

    const item = createItem({ id: 0, start_sec: 0, end_sec: 4 });
    mgr.onCueTick(0.1, item, [item]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));

    expect(ctx.decodeCalls).toHaveLength(1);
    expect(ctx.decodeCalls[0]).toBeInstanceOf(ArrayBuffer);
    expect(ctx.gainNode.gain.value).toBe(0.75);
    expect(ctx.sources[0].started).toBe(true);
    mgr.dispose();
  });

  it("2) Đo audioBuffer.duration thật tính playbackRate = 1.33, trần 1.45 và cập nhật khi đổi video.playbackRate", async () => {
    const ctx = createMockAudioContext(4.0);
    const video = createMockVideo({ currentTime: 1.0, playbackRate: 1.0 });
    const port = {
      request: vi.fn().mockResolvedValue({
        type: "tts.result",
        ok: true,
        audioBase64: SAMPLE_B64,
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings(), {
      createAudioContext: () => ctx as unknown as AudioContext,
    });

    // item [1.0, 4.0] → remaining = 3.0s, audioDuration = 4.0s → 4/3 = 1.33
    const item = createItem({ id: 0, start_sec: 1.0, end_sec: 4.0 });
    mgr.onCueTick(1.0, item, [item]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(ctx.sources[0].playbackRate.value).toBe(1.33);

    // Người dùng tăng tốc video lên 1.5x giữa chừng → remaining = 3/1.5 = 2s → 4/2 = 2.0 → kẹp trần 1.45
    video.playbackRate = 1.5;
    mgr.onRateChange();
    expect(ctx.sources[0].playbackRate.value).toBe(1.45);
    mgr.dispose();
  });

  it("3) Cache hit không gửi tts.synthesize lần 2, dedup in-flight và xóa cache khi tạo lại AudioContext", async () => {
    const contexts: MockAudioContext[] = [];
    const video = createMockVideo({ currentTime: 0.0 });
    let resolveFirst!: (val: unknown) => void;
    const requestMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    const port = { request: requestMock, cancel: vi.fn() } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings(), {
      createAudioContext: () => {
        const c = createMockAudioContext(1.5);
        contexts.push(c);
        return c as unknown as AudioContext;
      },
    });

    const item0 = createItem({ id: 0, start_sec: 0, end_sec: 4, target_text: "Câu một" });
    const item1 = createItem({ id: 1, start_sec: 4, end_sec: 8, target_text: "Câu hai" });

    // Bắt đầu ở item0 → request item0 + prefetch item1
    requestMock.mockReset();
    const pending: Array<() => void> = [];
    requestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({ type: "tts.result", ok: true, audioBase64: SAMPLE_B64 })
          );
        })
    );

    mgr.onCueTick(0.1, item0, [item0, item1]);
    expect(requestMock).toHaveBeenCalledTimes(2); // item0 + prefetch item1

    // Video nhảy sang item1 trong khi prefetch item1 vẫn đang in-flight → KHÔNG gửi request thứ 3
    video.currentTime = 4.1;
    mgr.onCueTick(4.1, item1, [item0, item1]);
    expect(requestMock).toHaveBeenCalledTimes(2);

    pending.forEach((fn) => fn());
    await vi.waitFor(() => expect(contexts[0].sources).toHaveLength(1));

    // Tua lại item0 (đã nằm trong cache) → KHÔNG gửi thêm request
    mgr.onSeeking();
    mgr.onSeeked();
    video.currentTime = 0.2;
    mgr.onCueTick(0.2, item0, [item0, item1]);
    await vi.waitFor(() => expect(contexts[0].sources).toHaveLength(2));
    expect(requestMock).toHaveBeenCalledTimes(2);

    // Tắt rồi bật lại TTS → đóng AudioContext cũ và xóa sạch cache → gọi lại phải request mới
    mgr.updateSettings(enabledSettings({ enabled: false }));
    expect(contexts[0].close).toHaveBeenCalledTimes(1);

    requestMock.mockResolvedValue({
      type: "tts.result",
      ok: true,
      audioBase64: SAMPLE_B64,
    });
    mgr.updateSettings(enabledSettings({ enabled: true }));
    mgr.onCueTick(0.3, item0, [item0]);
    await vi.waitFor(() => expect(contexts).toHaveLength(2));
    expect(requestMock).toHaveBeenCalledTimes(3);
    void resolveFirst;
    mgr.dispose();
  });

  it("4) Chống đọc lặp Hybrid (api → cloud cùng id) và đọc bù khi translated false → true giữa cue", async () => {
    const ctx = createMockAudioContext(1.5);
    const video = createMockVideo({ currentTime: 0.5 });
    const port = {
      request: vi.fn().mockResolvedValue({
        type: "tts.result",
        ok: true,
        audioBase64: SAMPLE_B64,
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings(), {
      createAudioContext: () => ctx as unknown as AudioContext,
    });

    // Ban đầu chưa dịch
    const rawItem = createItem({
      id: 5,
      start_sec: 0,
      end_sec: 4,
      target_text: "",
      translated: false,
      engine: null,
    });
    mgr.onCueTick(0.5, rawItem, [rawItem]);
    expect(port.request).not.toHaveBeenCalled();

    // Tier-1 (api) dịch xong giữa cue → phải đọc ngay
    const apiItem = { ...rawItem, target_text: "Bản dịch GTX", translated: true, engine: "api" as const };
    mgr.onCueTick(1.0, apiItem, [apiItem]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(port.request).toHaveBeenCalledTimes(1);

    // Tier-2 (cloud) nâng cấp bản dịch trên cùng id=5 → KHÔNG đọc lại
    const cloudItem = {
      ...apiItem,
      target_text: "Bản dịch Gemini mượt hơn",
      engine: "cloud" as const,
    };
    mgr.onCueTick(1.5, cloudItem, [cloudItem]);
    await vi.advanceTimersByTimeAsync(50);
    expect(port.request).toHaveBeenCalledTimes(1);
    expect(ctx.sources).toHaveLength(1);
    mgr.dispose();
  });

  it("5) pause gọi suspend() + trả video.volume; play trong cùng cue gọi resume() + hạ lại volume, không gọi lại TTS", async () => {
    const ctx = createMockAudioContext(3.0);
    const video = createMockVideo({ currentTime: 0.5, volume: 0.9 });
    const port = {
      request: vi.fn().mockResolvedValue({
        type: "tts.result",
        ok: true,
        audioBase64: SAMPLE_B64,
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings({ duckingVolume: 0.2 }), {
      createAudioContext: () => ctx as unknown as AudioContext,
    });

    const item = createItem({ id: 1, start_sec: 0, end_sec: 4 });
    mgr.onCueTick(0.5, item, [item]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(video.volume).toBe(0.2);

    // Pause giữa câu
    video.paused = true;
    mgr.onPause();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(video.volume).toBe(0.9);

    // Play lại trong cùng cue
    video.paused = false;
    video.currentTime = 1.2;
    mgr.onPlay();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(video.volume).toBe(0.2);
    expect(port.request).toHaveBeenCalledTimes(1);
    mgr.dispose();
  });

  it("6) seeking dừng activeSource, hủy request đang bay qua port.cancel(reqId) và reset lastSpokenCueId", async () => {
    const ctx = createMockAudioContext(2.0);
    const video = createMockVideo({ currentTime: 0.2 });
    let callIdx = 0;
    const port = {
      request: vi.fn().mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) {
          return Promise.resolve({ type: "tts.result", ok: true, audioBase64: SAMPLE_B64 });
        }
        return new Promise(() => {}); // prefetch treo
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings(), {
      createAudioContext: () => ctx as unknown as AudioContext,
    });

    const item0 = createItem({ id: 0, start_sec: 0, end_sec: 4, target_text: "Câu một" });
    const item1 = createItem({ id: 1, start_sec: 4, end_sec: 8, target_text: "Câu hai" });
    mgr.onCueTick(0.2, item0, [item0, item1]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));

    mgr.onSeeking();
    expect(ctx.sources[0].stopped).toBe(true);
    expect(port.cancel).toHaveBeenCalledTimes(1);
    mgr.onSeeked();

    // Có thể đọc lại chính item0 sau khi seek
    mgr.onCueTick(0.3, item0, [item0]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(2));
    mgr.dispose();
  });

  it("7) audioCtx.resume() bị từ chối không crash và gọi onStatusNotice đúng 1 lần", async () => {
    const ctx = createMockAudioContext(2.0);
    ctx.state = "suspended";
    ctx.resume.mockRejectedValue(new Error("NotAllowedError"));
    const onStatusNotice = vi.fn();
    const video = createMockVideo({ currentTime: 0.2 });
    const port = {
      request: vi.fn().mockResolvedValue({
        type: "tts.result",
        ok: true,
        audioBase64: SAMPLE_B64,
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings(), {
      createAudioContext: () => ctx as unknown as AudioContext,
      onStatusNotice,
    });

    const item = createItem({ id: 0, start_sec: 0, end_sec: 4 });
    mgr.onCueTick(0.2, item, [item]);
    await vi.waitFor(() => expect(onStatusNotice).toHaveBeenCalledTimes(1));
    expect(ctx.sources).toHaveLength(0);
    mgr.dispose();
  });

  it("8) Câu đã quá hạn (playhead >= item.end - 0.15) không được phát", async () => {
    const ctx = createMockAudioContext(2.0);
    const video = createMockVideo({ currentTime: 0.5 });
    let resolveReq!: (v: unknown) => void;
    const port = {
      request: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveReq = r;
          })
      ),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings(), {
      createAudioContext: () => ctx as unknown as AudioContext,
    });

    const item = createItem({ id: 0, start_sec: 0, end_sec: 4 });
    mgr.onCueTick(0.5, item, [item]);

    // Trong lúc đợi mạng, video đã chạy tới 3.9s (>= 4.0 - 0.15)
    video.currentTime = 3.9;
    resolveReq({ type: "tts.result", ok: true, audioBase64: SAMPLE_B64 });
    await vi.advanceTimersByTimeAsync(50);

    expect(ctx.sources).toHaveLength(0);
    mgr.dispose();
  });

  it("9) Ducking hạ volume xuống 0.2, khôi phục về 1.0 khi đọc xong và tôn trọng volume người dùng chỉnh tay", async () => {
    const ctx = createMockAudioContext(2.0);
    const video = createMockVideo({ currentTime: 0.1, volume: 1.0 });
    const port = {
      request: vi.fn().mockResolvedValue({
        type: "tts.result",
        ok: true,
        audioBase64: SAMPLE_B64,
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings({ duckingVolume: 0.2 }), {
      createAudioContext: () => ctx as unknown as AudioContext,
    });

    const item = createItem({ id: 0, start_sec: 0, end_sec: 4 });
    mgr.onCueTick(0.1, item, [item]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(video.volume).toBe(0.2);

    // Đọc xong → sau 250ms khôi phục về 1.0
    ctx.sources[0].onended?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(video.volume).toBe(1.0);

    // Đọc câu 2, trong lúc ducking người dùng tự kéo volume lên 0.65 → khi kết thúc phải khôi phục về 0.65
    const item2 = createItem({ id: 1, start_sec: 4, end_sec: 8, target_text: "Câu số hai" });
    video.currentTime = 4.1;
    mgr.onCueTick(4.1, item2, [item, item2]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(2));
    expect(video.volume).toBe(0.2);

    video.volume = 0.65;
    mgr.onVolumeChange();
    mgr.dispose();
    expect(video.volume).toBe(0.65);
  });

  it("10) Chồng chéo cắt câu cũ khi cue mới tới; 3 lỗi liên tiếp kích hoạt cooldown 30s", async () => {
    const ctx = createMockAudioContext(2.0);
    const video = createMockVideo({ currentTime: 0.1 });
    const onStatusNotice = vi.fn();
    const port = {
      request: vi.fn().mockResolvedValue({
        type: "tts.result",
        ok: true,
        audioBase64: SAMPLE_B64,
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings(), {
      createAudioContext: () => ctx as unknown as AudioContext,
      onStatusNotice,
    });

    const item0 = createItem({ id: 0, start_sec: 0, end_sec: 4, target_text: "Câu đầu" });
    const item1 = createItem({ id: 1, start_sec: 4, end_sec: 8, target_text: "Câu sau" });
    mgr.onCueTick(0.1, item0, [item0]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));

    // Cue mới tới khi câu cũ chưa kết thúc → cắt ngay câu cũ
    video.currentTime = 4.1;
    mgr.onCueTick(4.1, item1, [item0, item1]);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(2));
    expect(ctx.sources[0].stopped).toBe(true);

    // Gây 3 lỗi liên tiếp → kích hoạt cooldown 30s
    (port.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "tts.result",
      ok: false,
      error: "403",
    });

    for (let i = 2; i <= 4; i++) {
      const it = createItem({ id: i, start_sec: i * 4, end_sec: i * 4 + 4, target_text: `Lỗi ${i}` });
      video.currentTime = i * 4 + 0.1;
      mgr.onCueTick(video.currentTime, it, [it]);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(onStatusNotice).toHaveBeenCalledWith(
      expect.stringContaining("tạm ngưng 30s")
    );

    const callsBeforeCooldown = (port.request as ReturnType<typeof vi.fn>).mock.calls.length;
    const it5 = createItem({ id: 5, start_sec: 20, end_sec: 24, target_text: "Trong cooldown" });
    video.currentTime = 20.1;
    mgr.onCueTick(20.1, it5, [it5]);
    await vi.advanceTimersByTimeAsync(10);
    expect((port.request as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBeforeCooldown
    );
    mgr.dispose();
  });

  it("11) Prefetch tải trước tối đa 2 câu kế tiếp đã dịch và bỏ qua câu chưa dịch", async () => {
    const ctx = createMockAudioContext(1.5);
    const video = createMockVideo({ currentTime: 0.1 });
    const requestedTexts: string[] = [];
    const port = {
      request: vi.fn().mockImplementation(async (msg: { text: string }) => {
        requestedTexts.push(msg.text);
        return { type: "tts.result", ok: true, audioBase64: SAMPLE_B64 };
      }),
      cancel: vi.fn(),
    } as unknown as BackgroundPort;

    const mgr = new DubbingManager(video, port, enabledSettings(), {
      createAudioContext: () => ctx as unknown as AudioContext,
    });

    const items = [
      createItem({ id: 0, start_sec: 0, end_sec: 4, target_text: "Câu 0", translated: true }),
      createItem({ id: 1, start_sec: 4, end_sec: 8, target_text: "", translated: false }),
      createItem({ id: 2, start_sec: 8, end_sec: 12, target_text: "Câu 2", translated: true }),
      createItem({ id: 3, start_sec: 12, end_sec: 16, target_text: "Câu 3", translated: true }),
      createItem({ id: 4, start_sec: 16, end_sec: 20, target_text: "Câu 4", translated: true }),
    ];

    mgr.onCueTick(0.1, items[0], items);
    await vi.waitFor(() => expect(requestedTexts).toHaveLength(3));
    expect(requestedTexts).toEqual(["Câu 0", "Câu 2", "Câu 3"]);
    mgr.dispose();
  });
});
