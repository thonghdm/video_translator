import { afterEach, describe, expect, it } from "vitest";
import {
  canPlayMime,
  describeMediaError,
  formatPercent,
  isFixableByTranscode,
  isSilentVideoDecodeFailure,
  playbackStageLabel,
} from "./playback";

describe("canPlayMime", () => {
  const g = globalThis as any;
  const orig = g.MediaSource;
  afterEach(() => {
    g.MediaSource = orig;
  });

  it("dùng MediaSource.isTypeSupported khi có", () => {
    g.MediaSource = { isTypeSupported: (m: string) => m.includes("avc1") };
    expect(canPlayMime('video/mp4; codecs="avc1.64001F"')).toBe(true);
    expect(canPlayMime('video/mp4; codecs="av01.0.08M.08"')).toBe(false);
  });

  it("mime rỗng luôn coi là phát được", () => {
    expect(canPlayMime("")).toBe(true);
  });

  it("MediaSource ném lỗi thì rơi về canPlayType mà không crash", () => {
    g.MediaSource = {
      isTypeSupported: () => {
        throw new Error("boom");
      },
    };
    expect(typeof canPlayMime('video/mp4; codecs="hvc1.1.6.L120.90"')).toBe("boolean");
  });
});

describe("isSilentVideoDecodeFailure (chỉ có tiếng, màn hình đen)", () => {
  const vid = (o: Partial<{ t: number; w: number; rs: number; frames: number }>) => ({
    currentTime: o.t ?? 2,
    videoWidth: o.w ?? 0,
    readyState: o.rs ?? 4,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: o.frames ?? 0 }),
  });

  it("tiếng chạy nhưng không có khung hình -> lỗi giải mã hình", () => {
    expect(isSilentVideoDecodeFailure(vid({ t: 2.4, w: 0, frames: 0 }), true)).toBe(true);
  });
  it("video bình thường", () => {
    expect(isSilentVideoDecodeFailure(vid({ w: 320, frames: 59 }), true)).toBe(false);
  });
  it("file chỉ có tiếng thì không báo nhầm", () => {
    expect(isSilentVideoDecodeFailure(vid({ w: 0 }), false)).toBe(false);
  });
  it("chưa phát đủ lâu thì chưa kết luận", () => {
    expect(isSilentVideoDecodeFailure(vid({ t: 0.3, w: 0 }), true)).toBe(false);
    expect(isSilentVideoDecodeFailure(vid({ rs: 1, w: 0 }), true)).toBe(false);
  });
  it("có kích thước nhưng 0 khung hình -> lỗi", () => {
    expect(isSilentVideoDecodeFailure(vid({ w: 320, frames: 0 }), true)).toBe(true);
  });
  it("vừa tua tới phút 5 (chưa phát đủ 1s) thì không báo nhầm", () => {
    const v = {
      ...vid({ t: 300, w: 320, frames: 0 }),
      played: { length: 1, start: () => 300, end: () => 300.2 },
    };
    expect(isSilentVideoDecodeFailure(v, true)).toBe(false);
  });
});

describe("mô tả lỗi và tiến độ", () => {
  it("chỉ lỗi giải mã/định dạng mới chuyển mã", () => {
    expect(isFixableByTranscode(3)).toBe(true);
    expect(isFixableByTranscode(4)).toBe(true);
    expect(isFixableByTranscode(2)).toBe(false);
    expect(isFixableByTranscode(1)).toBe(false);
  });

  it("describeMediaError kèm message", () => {
    expect(describeMediaError(4, "DEMUXER_ERROR")).toContain("DEMUXER_ERROR");
    expect(describeMediaError(99)).toContain("99");
  });

  it("formatPercent", () => {
    expect(formatPercent(-1)).toBe("");
    expect(formatPercent(42.6)).toBe("43%");
    expect(formatPercent(150)).toBe("100%");
    expect(formatPercent(NaN)).toBe("");
  });

  it("nhãn giai đoạn", () => {
    expect(playbackStageLabel("remux")).toContain("đóng gói");
    expect(playbackStageLabel("transcode")).toContain("chuyển mã");
  });
});
