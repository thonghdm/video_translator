// Tiện ích cho việc phát video trong WebView2: kiểm tra codec, mô tả lỗi, nhãn tiến độ chuyển mã.

export interface PlaybackPrepState {
  path: string;
  percent: number; // 0..100, âm nếu chưa biết
  stage: string; // "probe" | "remux" | "transcode"
  reason?: string; // vì sao phải chuyển mã
  error?: string; // lỗi cuối cùng (nếu có)
}

/**
 * Hỏi WebView2 xem codec có giải mã được không (AV1/HEVC phụ thuộc phần cứng và extension của Windows).
 * Ưu tiên MediaSource.isTypeSupported (trả lời chính xác hơn canPlayType vốn hay trả "maybe").
 */
export function canPlayMime(mime: string): boolean {
  if (!mime) return true;
  try {
    const MS = (globalThis as any).MediaSource;
    if (MS && typeof MS.isTypeSupported === "function") {
      return !!MS.isTypeSupported(mime);
    }
  } catch {
    /* bỏ qua, thử canPlayType */
  }
  try {
    if (typeof document !== "undefined") {
      return document.createElement("video").canPlayType(mime) !== "";
    }
  } catch {
    /* không kiểm tra được */
  }
  // Không kiểm tra được thì cứ phát thử; lỗi thật sẽ được onError của <video> bắt
  return true;
}

/** Mã lỗi MediaError: 1 ABORTED, 2 NETWORK, 3 DECODE, 4 SRC_NOT_SUPPORTED */
export function describeMediaError(code: number, message?: string): string {
  const base: Record<number, string> = {
    1: "Đã dừng tải video",
    2: "Lỗi mạng/đọc file khi tải video",
    3: "WebView2 không giải mã được hình/tiếng của video",
    4: "Định dạng hoặc codec video không được WebView2 hỗ trợ",
  };
  const text = base[code] || `Lỗi phát video (mã ${code})`;
  return message ? `${text} (${message})` : text;
}

/** Lỗi nào có thể sửa bằng chuyển mã (lỗi mạng / người dùng hủy thì không) */
export function isFixableByTranscode(code: number): boolean {
  return code === 3 || code === 4;
}

/**
 * Phát hiện "chỉ có tiếng, màn hình đen": khi WebView2/Chromium không giải mã được luồng hình,
 * nó KHÔNG bắn MediaError mà lặng lẽ bỏ luồng hình và phát tiếp phần tiếng
 * (currentTime vẫn chạy, nhưng videoWidth = 0 và không có khung hình nào được giải mã).
 *
 * expectVideo: file có luồng hình (backend biết qua ffprobe; video Drive chưa probe thì coi là có).
 */
export function isSilentVideoDecodeFailure(
  v: Pick<HTMLVideoElement, "currentTime" | "videoWidth" | "readyState"> & {
    played?: { length: number; start(i: number): number; end(i: number): number };
    getVideoPlaybackQuality?: () => { totalVideoFrames: number };
  },
  expectVideo: boolean,
  minPlayedSec = 1.0,
): boolean {
  if (!expectVideo) return false;
  // Dùng tổng thời gian ĐÃ PHÁT (không phải currentTime) để tua tới giữa video không bị báo nhầm
  if (v.readyState < 2 || playedSeconds(v) < minPlayedSec) return false;
  if (v.videoWidth === 0) return true;
  try {
    const q = v.getVideoPlaybackQuality?.();
    if (q && q.totalVideoFrames === 0) return true;
  } catch {
    /* trình duyệt không hỗ trợ API này */
  }
  return false;
}

/** Tổng số giây đã thực sự phát (cộng các khoảng trong video.played) */
export function playedSeconds(v: {
  currentTime: number;
  played?: { length: number; start(i: number): number; end(i: number): number };
}): number {
  const r = v.played;
  if (!r || typeof r.length !== "number") return v.currentTime;
  let total = 0;
  for (let i = 0; i < r.length; i++) total += Math.max(0, r.end(i) - r.start(i));
  return total;
}

export function playbackStageLabel(stage: string): string {
  switch (stage) {
    case "probe":
      return "Đang phân tích video...";
    case "remux":
      return "Đang đóng gói lại video (nhanh)...";
    default:
      return "Đang chuyển mã video để phát...";
  }
}

/** Video Google Drive được phát trực tiếp qua loopback stream, không đi qua pipeline chuyển mã */
export function isDrivePath(path?: string): boolean {
  return typeof path === "string" && path.startsWith("gdrive://");
}

export interface TreeSelectionResult {
  filePath?: string;
  driveItem?: {
    id: string;
    name: string;
    mime_type: string;
    size: number;
    thumbnail_link: string;
    is_folder: boolean;
    duration_sec: number;
    subtitle_id: string;
    subtitle_name: string;
  };
}

/** Chuyển đổi đường dẫn từ cây thư mục sang tham số mở video phù hợp */
export function resolveTreeSelection(path: string): TreeSelectionResult {
  if (isDrivePath(path)) {
    const fileID = path.replace("gdrive://", "");
    return {
      driveItem: {
        id: fileID,
        name: "",
        mime_type: "video/mp4",
        size: 0,
        thumbnail_link: "",
        is_folder: false,
        duration_sec: 0,
        subtitle_id: "",
        subtitle_name: "",
      },
    };
  }
  return { filePath: path };
}

/**
 * Kiểm tra xem có được phép gọi requestPlayback (chuyển mã nền) hay không.
 * Tuyệt đối không cho phép chuyển mã đối với video Google Drive để tránh tải toàn bộ file qua mạng.
 */
export function shouldRequestTranscode(path: string): boolean {
  if (!path || isDrivePath(path)) return false;
  return true;
}


export function formatPercent(p: number): string {
  if (!isFinite(p) || p < 0) return "";
  return `${Math.min(100, Math.max(0, Math.round(p)))}%`;
}
