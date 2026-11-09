/**
 * SubTrans Extension — Gom index file và tìm kiếm phụ đề trong Top Frame của Google Drive
 * Phase 9.5 D4
 */

import {
  DRIVE_ID_RE,
  isDriveLookupReq,
  type DriveLookupRes,
} from "../../shared/driveTypes";
import { Disposer } from "../../shared/disposer";
import {
  findSidecar,
  normalizeName,
  stripExt,
  VIDEO_EXTS,
  type DriveEntry,
} from "../../shared/sidecarMatch";
import {
  isEnabledFor,
  loadSettings,
  onSettingsChanged,
  type Settings,
} from "../../shared/settings";
import { getFolderId, isDriveTopFrame } from "./driveFrame";

/**
 * Selector Drive — ĐÃ KIỂM CHỨNG trên Drive thật (09/11/2026, giao diện tiếng Việt, list + grid view):
 * - Mỗi file có nhiều phần tử cùng `data-id` (dòng `tr[role=row]` / `gridcell`, và các div con).
 * - TÊN SẠCH nằm ở textContent của phần tử có `data-tooltip` (vd "001 Introduction_en.srt").
 *   KHÔNG dùng giá trị data-tooltip ("001 Introduction_en.srt Không xác định") hay aria-label
 *   (grid: "… Không xác định Thông tin khác (Alt + →)"; list: không có) — chúng kèm nhãn loại file theo ngôn ngữ.
 * - Preview mở trong iframe CÙNG ORIGIN `drive.google.com/viewer/main`; tên file là
 *   `[role="heading"]` (aria-level 2) bên trong iframe đó. Video nằm sâu hơn trong iframe youtube.googleapis.com/embed.
 */
export const DRIVE_SELECTORS = {
  row: "[data-id]",
  rowId: "data-id",
  rowName: "[data-tooltip]",
  previewFrame: 'iframe[src*="/viewer/"]',
  previewTitle: '[role="heading"]',
} as const;

function hasVideoExt(name: string): boolean {
  const n = normalizeName(name);
  return VIDEO_EXTS.some((ext) => n.endsWith(ext));
}

/** Tên sạch của file: textContent của phần tử `[data-tooltip]` (ưu tiên phần tử cùng data-id). Không lấy text cả dòng. */
function readRowName(el: Element, id: string): string {
  let nameEl: Element | null = el.matches(DRIVE_SELECTORS.rowName) ? el : null;
  if (!nameEl) {
    const all = el.querySelectorAll(DRIVE_SELECTORS.rowName);
    for (let i = 0; i < all.length && !nameEl; i++) {
      if (all[i].getAttribute(DRIVE_SELECTORS.rowId) === id) nameEl = all[i];
    }
    nameEl = nameEl ?? all[0] ?? null;
  }
  return (nameEl?.textContent || "").trim();
}

export class DriveIndex {
  private disposer = new Disposer();
  private readonly map = new Map<string, string>();
  private currentFolderId: string | null = null;
  private started = false;

  constructor(
    private readonly doc: Document,
    private readonly getUrl: () => string
  ) {}

  public get size(): number {
    return this.map.size;
  }

  /**
   * Bắt đầu quét DOM và theo dõi thay đổi thư mục.
   * Gọi nhiều lần không tạo thêm MutationObserver thứ 2.
   */
  public start(): void {
    if (this.started) return;
    this.started = true;
    // Disposer đã disposeAll() thì add() chạy cleanup NGAY → phải tạo mới mỗi lần start (bật lại sau khi tắt)
    if (this.disposer.isDisposed) this.disposer = new Disposer();

    // Quét ngay lần đầu
    this.scan();

    // Theo dõi DOM thay đổi (lazy load, cuộn danh sách) với debounce 300ms
    if (this.doc.body) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let firstPending = 0;

      // Debounce 300ms nhưng tối đa 1s: Drive đổi DOM liên tục (spinner, tooltip) → debounce thuần có thể không bao giờ chạy
      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (!timer) firstPending = now;
        else clearTimeout(timer);
        const wait = Math.max(0, Math.min(300, firstPending + 1000 - now));
        timer = setTimeout(() => {
          timer = undefined;
          this.scan();
        }, wait);
      });

      observer.observe(this.doc.body, { childList: true, subtree: true });

      this.disposer.add(() => {
        if (timer) clearTimeout(timer);
        observer.disconnect();
      });
    }
  }

  /**
   * Quét DOM danh sách file:
   * - Reset map khi folderId đổi (SPA navigation)
   * - Chỉ đọc text/thuộc tính, không gọi layout getBoundingClientRect/getComputedStyle
   * - Giới hạn tối đa 5000 entry
   */
  public scan(): void {
    // Chỉ reset khi chuyển sang một THƯ MỤC KHÁC. URL tạm thời không có folderId (mở preview,
    // trang tìm kiếm) không được xóa danh sách đã gom (danh sách ảo hóa — dòng đã cuộn qua không còn trong DOM).
    const newFolderId = getFolderId(this.getUrl());
    if (newFolderId !== null && newFolderId !== this.currentFolderId) {
      if (this.currentFolderId !== null || this.map.size > 0) this.map.clear();
      this.currentFolderId = newFolderId;
    }

    const rows = this.doc.querySelectorAll(DRIVE_SELECTORS.row);
    for (let i = 0; i < rows.length; i++) {
      if (this.map.size >= 5000) break;

      const el = rows[i];
      const id = el.getAttribute(DRIVE_SELECTORS.rowId);
      if (!id || !DRIVE_ID_RE.test(id)) continue;

      const name = readRowName(el, id);
      if (!name || name.length > 512) continue;

      this.map.set(id, name);
    }
  }

  /**
   * Tra cứu phụ đề cho video:
   * 1. Tìm tên video qua videoDocId trong map
   * 2. Nếu không có → đọc tiêu đề preview
   * 3. Vẫn không có → result: "none"
   * 4. Khi khớp theo tiêu đề mà có ≥ 2 video cùng tên base → "ambiguous"
   * 5. findSidecar(videoName, entries) → trả DriveLookupRes
   */
  public lookup(videoDocId?: string): DriveLookupRes {
    let videoName: string | undefined;
    let matchedByDocId = false;

    if (videoDocId && this.map.has(videoDocId)) {
      videoName = this.map.get(videoDocId);
      matchedByDocId = true;
    }

    if (!videoName) {
      const title = this.findPreviewTitle();
      if (title) videoName = title;
    }

    if (!videoName) {
      return { ok: true, indexed: this.size, result: "none" };
    }

    // Nếu tìm theo tiêu đề: kiểm tra xem có ≥ 2 video cùng base name không
    if (!matchedByDocId) {
      const targetBase = normalizeName(stripExt(normalizeName(videoName), VIDEO_EXTS));
      let videoCount = 0;
      for (const name of this.map.values()) {
        const norm = normalizeName(name);
        const isVideo = VIDEO_EXTS.some((ext) => norm.endsWith(ext));
        if (isVideo) {
          const base = normalizeName(stripExt(norm, VIDEO_EXTS));
          if (base === targetBase) {
            videoCount++;
            if (videoCount >= 2) {
              return { ok: true, indexed: this.size, result: "ambiguous" };
            }
          }
        }
      }
    }

    const entries: DriveEntry[] = [];
    for (const [id, name] of this.map.entries()) {
      entries.push({ id, name });
    }

    const matchRes = findSidecar(videoName, entries);
    if (matchRes.status === "match") {
      return {
        ok: true,
        indexed: this.size,
        result: "match",
        id: matchRes.entry.id,
        name: matchRes.entry.name,
      };
    }
    if (matchRes.status === "ambiguous") {
      return { ok: true, indexed: this.size, result: "ambiguous" };
    }
    return { ok: true, indexed: this.size, result: "none" };
  }

  /**
   * Tên video đang mở trong preview. Tìm `[role="heading"]` có tên kết thúc bằng đuôi video:
   * trước hết trong iframe preview cùng origin (`/viewer/`), sau đó ở top frame. Heading khác
   * ("Đường dẫn thư mục", "Bản chép lời"…) không có đuôi video nên tự bị loại.
   */
  private findPreviewTitle(): string | null {
    const docs: Document[] = [];
    const frames = this.doc.querySelectorAll<HTMLIFrameElement>(DRIVE_SELECTORS.previewFrame);
    for (let i = 0; i < frames.length; i++) {
      try {
        const d = frames[i].contentDocument;
        if (d) docs.push(d);
      } catch {
        /* khác origin */
      }
    }
    docs.push(this.doc);
    for (const d of docs) {
      const hs = d.querySelectorAll(DRIVE_SELECTORS.previewTitle);
      for (let i = hs.length - 1; i >= 0; i--) {
        const t = (hs[i].textContent || "").trim();
        if (t && hasVideoExt(t)) return t;
      }
    }
    return null;
  }

  public dispose(): void {
    this.disposer.disposeAll();
    this.map.clear();
    this.started = false;
  }
}

export interface DriveTopFrameHandle {
  dispose(): void;
  readonly size: number;
  lookup(videoDocId?: string): DriveLookupRes;
}

/**
 * Khởi tạo DriveIndex cho Top Frame của Google Drive:
 * - Chỉ đăng ký khi isDriveTopFrame(win) === true
 * - Theo dõi setting: drive.autoSidecar && isEnabledFor(settings, "drive.google.com")
 * - Lắng nghe message "drive.lookup", bỏ qua các message khác
 * - Gán handle vào globalThis.__subtransDrive
 */
export function initDriveTopFrame(
  win: Window = window,
  doc: Document = document
): DriveTopFrameHandle | undefined {
  if (
    typeof win === "undefined" ||
    typeof doc === "undefined" ||
    typeof chrome === "undefined" ||
    !chrome.runtime?.id ||
    !isDriveTopFrame(win)
  ) {
    return undefined;
  }

  const g = globalThis as unknown as {
    __subtransDrive?: DriveTopFrameHandle;
  };
  try {
    g.__subtransDrive?.dispose();
  } catch {
    /* bản cũ thuộc context đã mất */
  }

  const driveDisposer = new Disposer();
  const index = new DriveIndex(doc, () => win.location.href);
  driveDisposer.add(() => index.dispose());

  let running = false;
  const updateRunning = (s: Settings) => {
    const shouldRun = Boolean(s.drive?.autoSidecar && isEnabledFor(s, "drive.google.com"));
    if (shouldRun) {
      running = true;
      index.start();
    } else {
      running = false;
      index.dispose();
    }
  };

  void loadSettings({ includeApiKey: false }).then(updateRunning);

  const unlistenSettings = onSettingsChanged(updateRunning, { includeApiKey: false });
  driveDisposer.add(unlistenSettings);

  const onDriveMsg = (
    msg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (res: unknown) => void
  ) => {
    if (!isDriveLookupReq(msg)) return; // không trả lời message khác
    sendResponse(running ? index.lookup(msg.videoDocId) : { ok: false });
    return false;
  };

  chrome.runtime.onMessage.addListener(onDriveMsg);
  driveDisposer.add(() => {
    chrome.runtime.onMessage.removeListener?.(onDriveMsg);
  });

  const handle: DriveTopFrameHandle = {
    dispose: () => driveDisposer.disposeAll(),
    get size() {
      return index.size;
    },
    lookup: (docId?: string) => index.lookup(docId),
  };

  g.__subtransDrive = handle;
  return handle;
}
