/**
 * SubTrans Extension — Giao diện adapter theo trang (PLAN 4.3)
 */
import type { Cue, TrackRef } from "../../shared/types";

export interface SubtitleSource {
  readonly track: TrackRef;
  /** Toàn bộ cue lấy được (rỗng nếu không lấy được) */
  load(): Promise<Cue[]>;
  /** Track tải thêm cue (player HLS/DASH nạp dần). Trả về hàm hủy đăng ký. */
  onCuesChanged?(cb: (cues: Cue[]) => void): () => void;
  dispose(): void;
}

export interface SiteAdapter {
  readonly name: string;
  matches(location: Location): boolean;
  /** null = dùng chế độ fixed (đồng bộ theo rect của video) */
  getOverlayContainer(video: HTMLVideoElement): HTMLElement | null;
  listSources(video: HTMLVideoElement): Promise<SubtitleSource[]>;
  isAdPlaying?(): boolean;
  onNavigate?(cb: () => void): () => void;
}
