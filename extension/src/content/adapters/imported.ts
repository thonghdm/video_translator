/**
 * SubTrans Extension — Adapter cho file phụ đề nhập vào (imported .srt/.vtt)
 * Phù hợp với Mục 6.4 và Phase 8 của PLAN.md
 */

import type { Cue, SubtitleItem, TrackRef } from "../../shared/types";
import { fnv1a32 } from "../../shared/hash";
import { parseSrtOrVttBilingual } from "../../shared/subtitleFormat";
import type { SubtitleSource } from "./types";

export class ImportedSubtitleSource implements SubtitleSource {
  public readonly track: TrackRef;
  private readonly items: SubtitleItem[];
  private readonly cues: Cue[];

  constructor(fileName: string, content: string) {
    const hash = fnv1a32(content);
    const cleanTitle = fileName.replace(/\.[^/.]+$/, "") || "imported";

    this.track = {
      trackKey: `file:${fileName}:${hash}`,
      platform: "file",
      videoId: fileName,
      title: cleanTitle,
      lang: "en",
      kind: "imported",
    };

    this.items = parseSrtOrVttBilingual(content);
    this.cues = this.items.map((it) => ({
      start: it.start_sec,
      end: it.end_sec,
      text: it.source_text || it.target_text,
    }));
  }

  public static async fromFile(file: File): Promise<ImportedSubtitleSource> {
    const text = await file.text();
    return new ImportedSubtitleSource(file.name, text);
  }

  public async load(): Promise<Cue[]> {
    return this.cues;
  }

  public getInitialItems(): SubtitleItem[] {
    return this.items;
  }

  public dispose(): void {
    // Không có tài nguyên mạng hay event listener cần giải phóng
  }
}
