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

export const DRIVE_SELECTORS = {
  row: "[data-id]",
  rowId: "data-id",
  rowName: "aria-label",
  previewTitle: '[role="heading"], [data-tooltip][aria-level="1"], .drive-preview-title',
} as const;

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

      // rowName là TÊN THUỘC TÍNH (không phải selector). Fallback: data-tooltip, rồi text của phần tử.
      let name = el.getAttribute(DRIVE_SELECTORS.rowName) || el.getAttribute("data-tooltip") || "";
      if (name.trim() === "") name = el.textContent || "";

      name = name.trim();
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
      const titleEl = this.findPreviewTitle();
      const rawTitle = (titleEl?.getAttribute("aria-label") || titleEl?.textContent || "").trim();
      if (rawTitle) {
        videoName = rawTitle;
      }
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
   * `[role="heading"]` có ở nhiều nơi (tên thư mục, tiêu đề mục...). Ưu tiên heading nằm trong preview
   * (`[role="dialog"]`); không có thì lấy phần tử khớp CUỐI CÙNG (overlay preview được chèn sau danh sách).
   */
  private findPreviewTitle(): Element | null {
    const all = this.doc.querySelectorAll(DRIVE_SELECTORS.previewTitle);
    if (all.length === 0) return null;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].closest('[role="dialog"]')) return all[i];
    }
    return all[all.length - 1];
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
