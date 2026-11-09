/**
 * SubTrans Extension — Adapter cho file phụ đề nhập vào (imported .srt/.vtt)
 * Phù hợp với Mục 6.4 và Phase 8 của PLAN.md, Phase 9.6 E2 của PLAN-drive-envi.md
 */

import type { Cue, SubtitleItem, TrackRef } from "../../shared/types";
import { fnv1a32 } from "../../shared/hash";
import { parseSrtOrVttBilingual } from "../../shared/subtitleFormat";
import {
  mergeEnVi,
  parseViForced,
  type PairStats,
  type SidecarFile,
} from "../../shared/subtitlePair";
import type { SubtitleSource } from "./types";

export interface ImportedSubtitleOptions {
  forceLang?: "vi";
  /** @internal Dùng cho static fromPair để gán track, items, cues đã ghép sẵn */
  _custom?: {
    track: TrackRef;
    items: SubtitleItem[];
    cues: Cue[];
  };
}

export class ImportedSubtitleSource implements SubtitleSource {
  public readonly track: TrackRef;
  private readonly items: SubtitleItem[];
  private readonly cues: Cue[];

  constructor(fileName: string, content: string, opts?: ImportedSubtitleOptions) {
    if (opts?._custom) {
      this.track = opts._custom.track;
      this.items = opts._custom.items;
      this.cues = opts._custom.cues;
      return;
    }

    const hash = fnv1a32(content);
    const cleanTitle = fileName.replace(/\.[^/.]+$/, "") || "imported";

    if (opts?.forceLang === "vi") {
      this.track = {
        // Khác khóa với lần "Nhập" tay cùng file (parse thường, câu không dấu bị coi là EN và đem dịch):
        // trùng khóa thì bản dịch máy trong cache sẽ ghi đè câu VI của file khi mở lại.
        trackKey: `file:${fileName}:vi:${hash}`,
        platform: "file",
        videoId: fileName,
        title: cleanTitle,
        lang: "vi",
        kind: "imported",
      };
      this.items = parseViForced(content);
      this.cues = this.items.map((it) => ({
        start: it.start_sec,
        end: it.end_sec,
        text: it.target_text,
      }));
      return;
    }

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
    return new ImportedSubtitleSource(file.name, await readFileText(file));
  }

  public static fromPair(
    en: SidecarFile,
    vi: SidecarFile
  ): { source: ImportedSubtitleSource; stats: PairStats } {
    const enItems = parseSrtOrVttBilingual(en.text);
    const viItems = parseViForced(vi.text);
    const { items, stats } = mergeEnVi(enItems, viItems);

    const hash = fnv1a32(en.text + "\u0000" + vi.text);
    const cleanTitle = en.name.replace(/\.[^/.]+$/, "") || "imported";

    const track: TrackRef = {
      trackKey: `file:${en.name}+${vi.name}:${hash}`,
      platform: "file",
      videoId: en.name,
      title: cleanTitle,
      lang: "en",
      kind: "imported",
    };

    // load() trả cue EN. Số phần tử bằng số items
    const cues: Cue[] = items.map((it) => ({
      start: it.start_sec,
      end: it.end_sec,
      text: it.source_text || it.target_text,
    }));

    const source = new ImportedSubtitleSource(en.name, en.text, {
      _custom: { track, items, cues },
    });

    return { source, stats };
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

/** Đọc nội dung file dạng UTF-8 (File.text() nếu có, nếu không dùng FileReader) */
export function readFileText(file: Blob): Promise<string> {
  if (typeof (file as Blob & { text?: () => Promise<string> }).text === "function") {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error("Không đọc được file"));
    r.readAsText(file, "utf-8");
  });
}
