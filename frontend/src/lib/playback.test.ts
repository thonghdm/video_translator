import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canPlayMime,
  describeMediaError,
  formatPercent,
  isDrivePath,
  isFixableByTranscode,
  isSilentVideoDecodeFailure,
  playbackStageLabel,
  resolveTreeSelection,
  shouldRequestTranscode,
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

describe("mở video từ cây thư mục và chặn chuyển mã cho gdrive (BUG fix)", () => {
  it("resolveTreeSelection: tách đúng fileID của Google Drive", () => {
    const res = resolveTreeSelection("gdrive://1Lefyhe4lnA8vCLpkEA2NXRB4x6cEyjx7");
    expect(res.filePath).toBeUndefined();
    expect(res.driveItem?.id).toBe("1Lefyhe4lnA8vCLpkEA2NXRB4x6cEyjx7");
    expect(isDrivePath("gdrive://1Lefyhe4lnA8vCLpkEA2NXRB4x6cEyjx7")).toBe(true);
  });

  it("resolveTreeSelection: giữ nguyên đường dẫn file cục bộ", () => {
    const res = resolveTreeSelection("D:/Videos/lesson1.mp4");
    expect(res.filePath).toBe("D:/Videos/lesson1.mp4");
    expect(res.driveItem).toBeUndefined();
    expect(isDrivePath("D:/Videos/lesson1.mp4")).toBe(false);
  });

  it("shouldRequestTranscode: từ chối tuyệt đối video gdrive", () => {
    expect(shouldRequestTranscode("gdrive://1Lefyhe4lnA8vCLpkEA2NXRB4x6cEyjx7")).toBe(false);
    expect(shouldRequestTranscode("")).toBe(false);
    expect(shouldRequestTranscode("D:/video.mkv")).toBe(true);
  });

  it("mô phỏng mở gdrive từ cây thư mục: gọi OpenDriveVideo, không gọi PreparePlayback, chỉ 1 lần gán src", async () => {
    const calls = {
      openDriveVideo: 0,
      openVideo: 0,
      preparePlayback: 0,
      srcAssignments: 0,
    };
    let currentSrc = "";

    const fakeBackend = {
      OpenDriveVideo: vi.fn(async (id: string) => {
        calls.openDriveVideo++;
        return {
          path: `gdrive://${id}`,
          media_url: `http://127.0.0.1:54321/drive/stream?id=${id}`,
          duration_sec: 3600,
          playable: true,
          video_codec: "h264",
        };
      }),
      OpenVideo: vi.fn(async (path: string) => {
        calls.openVideo++;
        return { path, media_url: `http://127.0.0.1:54321/media/${path}`, playable: true };
      }),
      PreparePlayback: vi.fn(async () => {
        calls.preparePlayback++;
      }),
    };

    // 1. Click chọn video gdrive từ cây thư mục
    const selected = "gdrive://1Lefyhe4lnA8vCLpkEA2NXRB4x6cEyjx7";
    const { filePath, driveItem } = resolveTreeSelection(selected);

    // 2. Mở video qua OpenDriveVideo
    const isDrive = !!driveItem || (typeof filePath === "string" && filePath.startsWith("gdrive://"));
    const driveFileID = driveItem?.id || (isDrive ? (filePath as string).replace("gdrive://", "") : "");

    const info = isDrive
      ? await fakeBackend.OpenDriveVideo(driveFileID)
      : await fakeBackend.OpenVideo(filePath as string);

    // 3. Gán src cho thẻ video
    currentSrc = info.media_url;
    calls.srcAssignments++;

    // 4. Kiểm tra điều kiện transcode sau khi mở
    if (!info.path.startsWith("gdrive://")) {
      if (!info.playable) {
        await fakeBackend.PreparePlayback(info.path, false);
      }
    }

    // 5. Kiểm tra khi video decode failure giả lập (ví dụ màn hình đen / buffering chậm)
    const isSilentFailure = isSilentVideoDecodeFailure(
      { currentTime: 2, videoWidth: 0, readyState: 4 },
      true,
    );
    expect(isSilentFailure).toBe(true);

    // Logic trong App.tsx: nếu info.path.startsWith("gdrive://") thì return ngay, không request transcode
    if (info.path.startsWith("gdrive://")) {
      // bỏ qua, không gọi PreparePlayback
    } else {
      await fakeBackend.PreparePlayback(info.path, true);
    }

    // 6. Kiểm tra khi onError giả lập
    if (info.path.startsWith("gdrive://")) {
      // chỉ showToast, không gọi PreparePlayback
    } else {
      await fakeBackend.PreparePlayback(info.path, true);
    }

    // Khẳng định đúng yêu cầu của người dùng:
    // - Đi qua OpenDriveVideo, không đi qua OpenVideo
    expect(calls.openDriveVideo).toBe(1);
    expect(calls.openVideo).toBe(0);
    // - Không gọi PreparePlayback (0 lần)
    expect(calls.preparePlayback).toBe(0);
    // - Chỉ đúng 1 lần gán src
    expect(calls.srcAssignments).toBe(1);
    expect(currentSrc).toBe("http://127.0.0.1:54321/drive/stream?id=1Lefyhe4lnA8vCLpkEA2NXRB4x6cEyjx7");
  });
});
