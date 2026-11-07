/**
 * SubTrans Extension — Unit tests cho YouTube Adapter — PLAN Phase 5
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pickYouTubeTrack,
  createYouTubeAdapter,
  setYouTubeNativeCaptionsHidden,
  HIDE_NATIVE_CC_STYLE_ID,
  YouTubeSubtitleSource,
  YouTubeHookClient,
  type YtCaptionTrack,
} from "../src/content/adapters/youtube";

describe("pickYouTubeTrack", () => {
  const tracks: YtCaptionTrack[] = [
    { baseUrl: "https://yt/es", languageCode: "es", name: "Spanish" },
    { baseUrl: "https://yt/en-asr", languageCode: "en", kind: "asr", name: "English (auto-generated)" },
    { baseUrl: "https://yt/en-manual", languageCode: "en-US", name: "English (United States)" },
  ];

  it("ưu tiên track thủ công (kind !== asr) khi preferManual = true", () => {
    const picked = pickYouTubeTrack(tracks, true);
    expect(picked).not.toBeNull();
    expect(picked?.kind).toBeUndefined();
    expect(picked?.languageCode).toBe("en-US");
  });

  it("lấy track tiếng Anh đầu tiên khi preferManual = false", () => {
    const picked = pickYouTubeTrack(tracks, false);
    expect(picked).not.toBeNull();
    expect(picked?.kind).toBe("asr");
  });

  it("chọn track ASR nếu chỉ có duy nhất track ASR", () => {
    const asrOnly: YtCaptionTrack[] = [
      { baseUrl: "https://yt/es", languageCode: "es", name: "Spanish" },
      { baseUrl: "https://yt/en-asr", languageCode: "en", kind: "asr", name: "English (auto-generated)" },
    ];
    const picked = pickYouTubeTrack(asrOnly, true);
    expect(picked?.kind).toBe("asr");
  });

  it("trả về null nếu không có track tiếng Anh", () => {
    const noEn: YtCaptionTrack[] = [
      { baseUrl: "https://yt/es", languageCode: "es", name: "Spanish" },
      { baseUrl: "https://yt/vi", languageCode: "vi", name: "Tiếng Việt" },
    ];
    expect(pickYouTubeTrack(noEn, true)).toBeNull();
    expect(pickYouTubeTrack([], true)).toBeNull();
  });
});

describe("YouTube Adapter matches & DOM helpers", () => {
  const adapter = createYouTubeAdapter();

  it("matches đúng URL youtube.com/watch", () => {
    expect(adapter.matches({ hostname: "www.youtube.com", pathname: "/watch" } as Location)).toBe(true);
    expect(adapter.matches({ hostname: "m.youtube.com", pathname: "/watch" } as Location)).toBe(true);
    expect(adapter.matches({ hostname: "www.youtube.com", pathname: "/shorts/123" } as Location)).toBe(false);
    expect(adapter.matches({ hostname: "vimeo.com", pathname: "/watch" } as Location)).toBe(false);
  });

  it("setYouTubeNativeCaptionsHidden chèn và gỡ style chuẩn", () => {
    setYouTubeNativeCaptionsHidden(true, document);
    const style = document.getElementById(HIDE_NATIVE_CC_STYLE_ID);
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain(".ytp-caption-window-container{display:none!important}");

    setYouTubeNativeCaptionsHidden(false, document);
    expect(document.getElementById(HIDE_NATIVE_CC_STYLE_ID)).toBeNull();
  });
});

describe("YouTubeSubtitleSource", () => {
  let hookClient: YouTubeHookClient;

  beforeEach(() => {
    hookClient = new YouTubeHookClient();
  });

  afterEach(() => {
    hookClient.dispose();
  });

  const dummyTrack: YtCaptionTrack = {
    baseUrl: "https://www.youtube.com/api/timedtext?v=vid123&lang=en",
    languageCode: "en",
    name: "English",
  };

  it("Bước 1: dùng ngay timedtext nếu hook đã bắt được", async () => {
    const jsonPayload = JSON.stringify({
      events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "Captured text" }] }],
    });

    // Giả lập hook đã bắt được
    window.postMessage(
      {
        source: "subtrans-yt",
        kind: "timedtext",
        url: "https://www.youtube.com/api/timedtext?v=vid123&lang=en",
        body: jsonPayload,
      },
      location.origin
    );

    // Chờ 1 tick để window nhận message
    await new Promise((r) => setTimeout(r, 20));

    const source = new YouTubeSubtitleSource(dummyTrack, "vid123", "Test Title", hookClient);
    const cues = await source.load();
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Captured text");
    source.dispose();
  });

  it("Bước 2: fetch qua MAIN world nếu chưa có trong bộ đệm", async () => {
    const jsonPayload = JSON.stringify({
      events: [{ tStartMs: 500, dDurationMs: 1500, segs: [{ utf8: "Fetched text" }] }],
    });

    vi.spyOn(hookClient, "fetchTimedtext").mockResolvedValue(jsonPayload);

    const source = new YouTubeSubtitleSource(dummyTrack, "vid999", "Test Title", hookClient);
    const cues = await source.load();
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Fetched text");
    source.dispose();
  });

  it("Bước 3: nếu fetch thất bại, thông báo bật CC và chờ hook bắt được timedtext", async () => {
    vi.spyOn(hookClient, "fetchTimedtext").mockResolvedValue(null);
    const notifyFn = vi.fn();

    const source = new YouTubeSubtitleSource(dummyTrack, "vid_cc", "Test Title", hookClient, notifyFn);
    const loadPromise = source.load();

    // Chờ một chút để source chuyển sang bước 3 và hiện thông báo
    await new Promise((r) => setTimeout(r, 10));
    expect(notifyFn).toHaveBeenCalledWith("Bật phụ đề CC của YouTube (phím C) để SubTrans lấy phụ đề");

    // Người dùng bấm CC -> hook bắt được timedtext
    const jsonPayload = JSON.stringify({
      events: [{ tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: "CC text after click" }] }],
    });

    window.postMessage(
      {
        source: "subtrans-yt",
        kind: "timedtext",
        url: "https://www.youtube.com/api/timedtext?v=vid_cc&lang=en",
        body: jsonPayload,
      },
      location.origin
    );

    const cues = await loadPromise;
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("CC text after click");
    expect(notifyFn).toHaveBeenLastCalledWith(null);
    source.dispose();
  });
});
