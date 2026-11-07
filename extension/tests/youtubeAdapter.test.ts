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
    const loc = (hostname: string, pathname: string, search = "?v=abc123") =>
      ({ hostname, pathname, href: `https://${hostname}${pathname}${search}` }) as Location;
    expect(adapter.matches(loc("www.youtube.com", "/watch"))).toBe(true);
    expect(adapter.matches(loc("m.youtube.com", "/watch"))).toBe(true);
    expect(adapter.matches(loc("www.youtube.com", "/watch", ""))).toBe(false); // thiếu v=
    expect(adapter.matches(loc("www.youtube.com", "/shorts/123", ""))).toBe(false);
    expect(adapter.matches(loc("vimeo.com", "/watch"))).toBe(false);
    expect(adapter.matches(loc("notyoutube.com.evil.io", "/watch"))).toBe(false);
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

  it("Bước 2: đã bắt được track KHÁC của cùng video (có pot) → dựng URL track đúng và tải qua hook", async () => {
    const payload = JSON.stringify({
      events: [{ tStartMs: 500, dDurationMs: 1500, segs: [{ utf8: "Fetched text." }] }],
    });
    const fetchSpy = vi.spyOn(hookClient, "fetchTimedtext").mockResolvedValue(payload);
    // Player đang hiện bản tự dịch tiếng Việt (tlang=vi) → không phải phụ đề gốc
    window.postMessage(
      {
        source: "subtrans-yt",
        kind: "timedtext",
        url: "https://www.youtube.com/api/timedtext?v=vid999&lang=en&tlang=vi&pot=TOKEN&fmt=json3",
        body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Xin chào" }] }] }),
      },
      location.origin
    );
    await new Promise((r) => setTimeout(r, 20));

    const source = new YouTubeSubtitleSource(dummyTrack, "vid999", "Test Title", hookClient);
    const cues = await source.load();
    expect(cues.map((c) => c.text)).toEqual(["Fetched text."]);
    const url = new URL(fetchSpy.mock.calls[0][0]);
    expect(url.searchParams.get("pot")).toBe("TOKEN"); // giữ pot
    expect(url.searchParams.get("tlang")).toBeNull(); // bỏ bản tự dịch
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("fmt")).toBe("json3");
    source.dispose();
  });

  it("Bước 3: chưa bắt được gì → nhờ player tự tải (ensureCaptions), dispose thì tắt lại", async () => {
    const restore = vi.spyOn(hookClient, "restoreCaptions");
    vi.spyOn(hookClient, "ensureCaptions").mockImplementation(async () => {
      // Player tự gửi request timedtext → hook bắt được
      setTimeout(() => {
        window.postMessage(
          {
            source: "subtrans-yt",
            kind: "timedtext",
            url: "https://www.youtube.com/api/timedtext?v=vid_auto&lang=en&pot=P&fmt=json3",
            body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Auto loaded." }] }] }),
          },
          location.origin
        );
      }, 5);
      return { ok: true, wasOn: false };
    });
    const source = new YouTubeSubtitleSource(dummyTrack, "vid_auto", "T", hookClient, undefined, 2000);
    const cues = await source.load();
    expect(cues.map((c) => c.text)).toEqual(["Auto loaded."]);
    source.dispose();
    expect(restore).toHaveBeenCalledOnce(); // SubTrans đã bật → tắt lại
  });

  it("Bước 3: phụ đề do người dùng bật sẵn (wasOn) → dispose KHÔNG tắt", async () => {
    const restore = vi.spyOn(hookClient, "restoreCaptions");
    vi.spyOn(hookClient, "ensureCaptions").mockImplementation(async () => {
      setTimeout(() => {
        window.postMessage(
          {
            source: "subtrans-yt",
            kind: "timedtext",
            url: "https://www.youtube.com/api/timedtext?v=vid_on&lang=en&pot=P",
            body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "On." }] }] }),
          },
          location.origin
        );
      }, 5);
      return { ok: true, wasOn: true };
    });
    const source = new YouTubeSubtitleSource(dummyTrack, "vid_on", "T", hookClient, undefined, 2000);
    await source.load();
    source.dispose();
    expect(restore).not.toHaveBeenCalled();
  });

  it("Bước 4: không tự tải được → báo bật CC, chờ, rồi xóa thông báo khi có phụ đề", async () => {
    vi.spyOn(hookClient, "ensureCaptions").mockResolvedValue({ ok: false, wasOn: false });
    const notifyFn = vi.fn();
    const source = new YouTubeSubtitleSource(dummyTrack, "vid_cc", "Test Title", hookClient, notifyFn, 30);
    const loadPromise = source.load();

    await new Promise((r) => setTimeout(r, 80));
    expect(notifyFn).toHaveBeenCalledWith("Bật phụ đề CC của YouTube (phím C) để SubTrans lấy phụ đề");

    window.postMessage(
      {
        source: "subtrans-yt",
        kind: "timedtext",
        url: "https://www.youtube.com/api/timedtext?v=vid_cc&lang=en",
        body: JSON.stringify({ events: [{ tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: "CC text after click" }] }] }),
      },
      location.origin
    );

    const cues = await loadPromise;
    expect(cues.map((c) => c.text)).toEqual(["CC text after click"]);
    expect(notifyFn).toHaveBeenLastCalledWith(null);
    source.dispose();
  });

  it("dispose khi đang chờ → load() trả [] và không treo", async () => {
    vi.spyOn(hookClient, "ensureCaptions").mockResolvedValue({ ok: false, wasOn: false });
    const source = new YouTubeSubtitleSource(dummyTrack, "vid_x", "T", hookClient, undefined, 10);
    const p = source.load();
    await new Promise((r) => setTimeout(r, 40));
    source.dispose();
    await expect(p).resolves.toEqual([]);
  });

  it("bắt được bản tự dịch (tlang) của đúng video thì KHÔNG dùng làm phụ đề gốc", async () => {
    window.postMessage(
      {
        source: "subtrans-yt",
        kind: "timedtext",
        url: "https://www.youtube.com/api/timedtext?v=vid_t&lang=en&tlang=vi",
        body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Bản dịch" }] }] }),
      },
      location.origin
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(hookClient.findCaptured("vid_t", { languageCode: "en" })).toBeNull();
    expect(hookClient.findPotUrl("vid_t")).toContain("tlang=vi");
  });
});
