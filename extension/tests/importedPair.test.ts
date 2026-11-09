/**
 * SubTrans Extension — Unit tests cho ImportedSubtitleSource với EN + VI pair và forceLang (Phase 9.6 E2)
 */

import { describe, it, expect } from "vitest";
import { ImportedSubtitleSource } from "../src/content/adapters/imported";
import { fnv1a32 } from "../src/shared/hash";

describe("Phase 9.6 E2: ImportedSubtitleSource", () => {
  const sampleEnSrt = `1
00:00:01,000 --> 00:00:03,500
Hello everyone

2
00:00:04,000 --> 00:00:07,000
Welcome to Cloud Computing
`;

  const sampleViSrt = `1
00:00:01,000 --> 00:00:03,500
Xin chào mọi người

2
00:00:04,000 --> 00:00:07,000
Chào mừng đến với Điện toán đám mây
`;

  const sampleBilingualSrt = `1
00:00:01,000 --> 00:00:03,500
Hello everyone
Xin chào mọi người

2
00:00:04,200 --> 00:00:07,800
Welcome to TypeScript and React
Chào mừng đến với TypeScript và React
`;

  it("fromPair có trackKey đúng dạng; getInitialItems().length === (await load()).length", async () => {
    const enFile = { name: "001 Introduction_en.srt", text: sampleEnSrt };
    const viFile = { name: "001 Introduction_vi.srt", text: sampleViSrt };

    const { source, stats } = ImportedSubtitleSource.fromPair(enFile, viFile);

    expect(stats.total).toBe(2);
    expect(stats.matched).toBe(2);
    expect(stats.ratio).toBe(1);

    const expectedHash = fnv1a32(enFile.text + "\u0000" + viFile.text);
    expect(source.track.trackKey).toBe(
      `file:001 Introduction_en.srt+001 Introduction_vi.srt:${expectedHash}`
    );
    expect(source.track.videoId).toBe("001 Introduction_en.srt");
    expect(source.track.title).toBe("001 Introduction_en");
    expect(source.track.platform).toBe("file");
    expect(source.track.lang).toBe("en");
    expect(source.track.kind).toBe("imported");

    const cues = await source.load();
    const initialItems = source.getInitialItems();

    expect(initialItems.length).toBe(cues.length);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("Hello everyone");
    expect(cues[1].text).toBe("Welcome to Cloud Computing");

    expect(initialItems[0].source_text).toBe("Hello everyone");
    expect(initialItems[0].target_text).toBe("Xin chào mọi người");
    expect(initialItems[0].translated).toBe(true);
    expect(initialItems[0].engine).toBe("file");

    expect(initialItems[1].source_text).toBe("Welcome to Cloud Computing");
    expect(initialItems[1].target_text).toBe("Chào mừng đến với Điện toán đám mây");
    expect(initialItems[1].translated).toBe(true);
    expect(initialItems[1].engine).toBe("file");
  });

  it("forceLang: 'vi' → mọi item translated, engine = 'file', track.lang = 'vi'", async () => {
    const source = new ImportedSubtitleSource("sample_vi.srt", sampleViSrt, {
      forceLang: "vi",
    });

    const expectedHash = fnv1a32(sampleViSrt);
    expect(source.track.trackKey).toBe(`file:sample_vi.srt:vi:${expectedHash}`);
    expect(source.track.lang).toBe("vi");
    expect(source.track.title).toBe("sample_vi");

    const cues = await source.load();
    const initialItems = source.getInitialItems();

    expect(initialItems.length).toBe(cues.length);
    expect(initialItems).toHaveLength(2);

    expect(initialItems[0].source_text).toBe("");
    expect(initialItems[0].target_text).toBe("Xin chào mọi người");
    expect(initialItems[0].translated).toBe(true);
    expect(initialItems[0].engine).toBe("file");
    expect(cues[0].text).toBe("Xin chào mọi người");

    expect(initialItems[1].source_text).toBe("");
    expect(initialItems[1].target_text).toBe("Chào mừng đến với Điện toán đám mây");
    expect(initialItems[1].translated).toBe(true);
    expect(initialItems[1].engine).toBe("file");
    expect(cues[1].text).toBe("Chào mừng đến với Điện toán đám mây");
  });

  it("Constructor cũ không đổi hành vi (so với snapshot của một file EN và một file song ngữ)", async () => {
    // 1. File EN thuần
    const enSource = new ImportedSubtitleSource("english.srt", sampleEnSrt);
    expect(enSource.track.lang).toBe("en");
    expect(enSource.track.trackKey).toBe(`file:english.srt:${fnv1a32(sampleEnSrt)}`);
    expect(enSource.track.title).toBe("english");

    const enCues = await enSource.load();
    const enItems = enSource.getInitialItems();
    expect(enItems).toHaveLength(2);
    expect(enCues).toHaveLength(2);
    expect(enItems[0].source_text).toBe("Hello everyone");
    expect(enItems[0].target_text).toBe("");
    expect(enItems[0].translated).toBe(false);
    expect(enItems[0].engine).toBeNull();
    expect(enCues[0].text).toBe("Hello everyone");

    // 2. File song ngữ (Desktop _bilingual.srt)
    const biSource = new ImportedSubtitleSource("bilingual.srt", sampleBilingualSrt);
    expect(biSource.track.lang).toBe("en");
    expect(biSource.track.trackKey).toBe(`file:bilingual.srt:${fnv1a32(sampleBilingualSrt)}`);
    expect(biSource.track.title).toBe("bilingual");

    const biCues = await biSource.load();
    const biItems = biSource.getInitialItems();
    expect(biItems).toHaveLength(2);
    expect(biCues).toHaveLength(2);
    expect(biItems[0].source_text).toBe("Hello everyone");
    expect(biItems[0].target_text).toBe("Xin chào mọi người");
    expect(biItems[0].translated).toBe(true);
    expect(biItems[0].engine).toBe("file");
    expect(biCues[0].text).toBe("Hello everyone");
  });
});
