/**
 * SubTrans Extension — Store nhỏ cho overlay (dùng với useSyncExternalStore).
 * Chỉ thông báo khi giá trị thực sự đổi → React chỉ re-render khi dòng phụ đề hiện tại đổi,
 * không re-render theo mỗi frame (PLAN Phase 6 "Quy tắc dọn dẹp").
 */

import type { SubtitleItem, SubtitleMode } from "../../shared/types";
import { DEFAULT_SETTINGS, type Settings } from "../../shared/settings";

export interface OverlayState {
  item: SubtitleItem | null;
  mode: SubtitleMode;
  style: Settings["style"];
  /** Thông báo trạng thái (góc trên phải), null = ẩn */
  message: string | null;
  /** Toast ngắn (giữa trên) */
  toast: string | null;
  /** Đang dùng TextTrack gốc (fullscreen chính thẻ <video>) → ẩn overlay */
  nativeFallback: boolean;
  /** Overlay có được hiển thị không (ví dụ ẩn khi đang có quảng cáo) */
  visible: boolean;
  /** Độ lệch thời gian (giây), mặc định 0 */
  offset: number;
  /** Có track phụ đề nào đang nạp không */
  hasTrack: boolean;
  /** Tiêu đề track phụ đề đang phát */
  trackTitle?: string;
}

export type Listener = () => void;

export class OverlayStore {
  private state: OverlayState;
  private readonly listeners = new Set<Listener>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initial: Partial<OverlayState> = {}) {
    this.state = {
      item: null,
      mode: DEFAULT_SETTINGS.subtitleMode,
      style: { ...DEFAULT_SETTINGS.style },
      message: null,
      toast: null,
      nativeFallback: false,
      visible: true,
      offset: 0,
      hasTrack: false,
      ...initial,
    };
  }

  public getState = (): OverlayState => this.state;

  public subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Cập nhật một phần; bỏ qua nếu không có field nào đổi (so sánh ===) */
  public setState(patch: Partial<OverlayState>): void {
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof OverlayState>) {
      if (this.state[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  public flashToast(text: string, ms = 2000): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.setState({ toast: text });
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.setState({ toast: null });
    }, ms);
  }

  public dispose(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.listeners.clear();
  }
}
