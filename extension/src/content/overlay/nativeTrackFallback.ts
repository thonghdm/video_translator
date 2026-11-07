/**
 * SubTrans Extension — Dự phòng khi fullscreen chính thẻ <video> (PLAN 4.6)
 * Thẻ <video> fullscreen không vẽ được phần tử con → dùng TextTrack của trình duyệt.
 * Không kéo thả được ở chế độ này.
 */

import type { SubtitleItem, SubtitleMode } from "../../shared/types";
import { SUBTRANS_TRACK_LABEL } from "../adapters/html5";

/** Nội dung cue theo chế độ hiển thị (song ngữ: EN dòng trên, VI dòng dưới) */
export function cueTextForMode(item: SubtitleItem, mode: SubtitleMode): string {
  const en = item.source_text.trim();
  const vi = item.target_text.trim();
  switch (mode) {
    case "off":
      return "";
    case "en":
      return en;
    case "vi":
      return vi || en;
    case "bilingual":
    default:
      return vi && en ? `${en}\n${vi}` : vi || en;
  }
}

type VttCueCtor = new (start: number, end: number, text: string) => TextTrackCue;

export class NativeTrackFallback {
  private track: TextTrack | null = null;
  private active = false;
  private lastItems: SubtitleItem[] = [];
  private lastMode: SubtitleMode = "bilingual";
  /** Độ lệch giống overlay: dòng hiện khi currentTime + offset ∈ [start, end] → cue tại [start − offset, end − offset] */
  private offset = 0;

  constructor(private readonly video: HTMLVideoElement) {}

  public get isActive(): boolean {
    return this.active;
  }

  public enable(items: SubtitleItem[], mode: SubtitleMode): void {
    this.active = true;
    this.render(items, mode);
  }

  /** Cập nhật nội dung (chỉ khi đang bật) */
  public update(items: SubtitleItem[], mode: SubtitleMode): void {
    this.lastItems = items;
    this.lastMode = mode;
    if (this.active) this.render(items, mode);
  }

  public setOffset(offset: number): void {
    if (offset === this.offset) return;
    this.offset = offset;
    if (this.active) this.render(this.lastItems, this.lastMode);
  }

  public disable(): void {
    this.active = false;
    if (this.track) this.track.mode = "disabled";
  }

  public dispose(): void {
    this.disable();
    if (this.track) this.clearCues(this.track);
    this.lastItems = [];
  }

  private ensureTrack(): TextTrack | null {
    if (this.track) return this.track;
    if (typeof this.video.addTextTrack !== "function") return null;
    // Track tạo bằng addTextTrack không gỡ được → tạo 1 lần, tái sử dụng
    this.track = this.video.addTextTrack("subtitles", SUBTRANS_TRACK_LABEL, "vi");
    return this.track;
  }

  private render(items: SubtitleItem[], mode: SubtitleMode): void {
    this.lastItems = items;
    this.lastMode = mode;
    const track = this.ensureTrack();
    const Ctor = (globalThis as unknown as { VTTCue?: VttCueCtor }).VTTCue;
    if (!track || !Ctor) return;
    this.clearCues(track);
    for (const it of items) {
      const text = cueTextForMode(it, mode);
      if (!text || !(it.end_sec > it.start_sec)) continue;
      const start = Math.max(0, it.start_sec - this.offset);
      const end = it.end_sec - this.offset;
      if (!(end > start)) continue;
      try {
        track.addCue(new Ctor(start, end, text));
      } catch {
        /* cue lỗi thì bỏ qua */
      }
    }
    track.mode = mode === "off" ? "disabled" : "showing";
  }

  private clearCues(track: TextTrack): void {
    const cues = track.cues;
    if (!cues) return;
    for (let i = cues.length - 1; i >= 0; i--) {
      try {
        track.removeCue(cues[i]);
      } catch {
        /* bỏ qua */
      }
    }
  }

  /** Dùng cho debug/test */
  public snapshot(): { items: number; mode: SubtitleMode } {
    return { items: this.lastItems.length, mode: this.lastMode };
  }
}
