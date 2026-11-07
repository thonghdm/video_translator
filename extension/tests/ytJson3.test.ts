/**
 * SubTrans Extension — Unit test phân tích phụ đề YouTube (json3, xml, vtt) — PLAN Phase 5
 */
import { describe, it, expect } from "vitest";
import {
  parseJson3,
  parseXmlTimedtext,
  parseYouTubeTimedtext,
  parseTimedtextUrl,
  extractVideoId,
} from "../src/content/adapters/ytParser";

describe("parseTimedtextUrl & extractVideoId", () => {
  it("trích xuất videoId từ URL xem video thông thường", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/watch?v=abc123xyz&t=42s")).toBe("abc123xyz");
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBeNull();
  });

  it("trích xuất các tham số từ URL timedtext", () => {
    const url = "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fmt=json3&name=";
    const res = parseTimedtextUrl(url);
    expect(res).toEqual({
      videoId: "dQw4w9WgXcQ",
      lang: "en",
      fmt: "json3",
    });
  });
});

describe("parseJson3", () => {
  const sampleJson3 = JSON.stringify({
    wireMagic: "pb3",
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 2000,
        segs: [{ utf8: "Hello " }, { utf8: "world &amp; friends!" }],
      },
      // Event chỉ có ký tự xuống dòng
      {
        tStartMs: 3100,
        dDurationMs: 200,
        segs: [{ utf8: "\n" }],
      },
      // Event không có segs
      {
        tStartMs: 3400,
        dDurationMs: 500,
      },
      {
        tStartMs: 4000,
        dDurationMs: 2500,
        segs: [{ utf8: "This is a second sentence." }],
      },
      // Cue bị cắt dở giữa câu (không kết thúc bằng dấu câu)
      {
        tStartMs: 7000,
        dDurationMs: 1500,
        segs: [{ utf8: "We are learning about" }],
      },
      {
        tStartMs: 8500,
        dDurationMs: 1500,
        segs: [{ utf8: "web extension development." }],
      },
    ],
  });

  it("parse json3 và chuẩn hóa text, giải mã entity, bỏ qua dòng rỗng/xuống dòng", () => {
    const cues = parseJson3(sampleJson3, false);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues[0].text).toBe("Hello world & friends!");
    expect(cues[0].start).toBe(1.0);
    expect(cues[0].end).toBe(3.0);
  });

  it("track thủ công (isAsr=false): chỉ gộp cue bị cắt giữa câu khi không có khoảng trống (maxGap=0)", () => {
    const cues = parseJson3(sampleJson3, false);
    // "We are learning about" (7-8.5s) và "web extension development." (8.5-10s) liền nhau (gap=0)
    // -> được gộp thành "We are learning about web extension development." (7-10s)
    const last = cues[cues.length - 1];
    expect(last.text).toBe("We are learning about web extension development.");
    expect(last.start).toBe(7.0);
    expect(last.end).toBe(10.0);
  });

  it("track ASR (isAsr=true): gộp qua khoảng lặng lên tới 1.2s", () => {
    const asrData = JSON.stringify({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 1000,
          segs: [{ utf8: "First part" }],
        },
        // Cách 0.5s (dưới maxGap 1.2s)
        {
          tStartMs: 2500,
          dDurationMs: 1500,
          segs: [{ utf8: "and second part." }],
        },
      ],
    });

    const manualCues = parseJson3(asrData, false);
    expect(manualCues).toHaveLength(2); // manual có gap > 0 nên không gộp

    const asrCues = parseJson3(asrData, true);
    expect(asrCues).toHaveLength(1); // asr gộp gap 0.5s thành 1 câu
    expect(asrCues[0].text).toBe("First part and second part.");
    expect(asrCues[0].start).toBe(1.0);
    expect(asrCues[0].end).toBe(4.0);
  });

  it("xử lý an toàn khi JSON hỏng hoặc rỗng", () => {
    expect(parseJson3("not a json")).toEqual([]);
    expect(parseJson3("{}")).toEqual([]);
    expect(parseJson3('{"events":[]}')).toEqual([]);
  });
});

describe("parseXmlTimedtext", () => {
  const sampleXml = `
    <transcript>
      <text start="1.5" dur="3.0">Welcome to &lt;b&gt;SubTrans&lt;/b&gt; &amp; YouTube</text>
      <text start="5.0" dur="2.5">Enjoy your learning!</text>
    </transcript>
  `;

  it("parse XML timedtext chính xác", () => {
    const cues = parseXmlTimedtext(sampleXml, false);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({
      start: 1.5,
      end: 4.5,
      text: "Welcome to SubTrans & YouTube",
    });
    expect(cues[1]).toEqual({
      start: 5.0,
      end: 7.5,
      text: "Enjoy your learning!",
    });
  });
});

describe("parseYouTubeTimedtext dispatcher", () => {
  it("tự nhận diện định dạng JSON3", () => {
    const json = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hi" }] }],
    });
    const cues = parseYouTubeTimedtext(json, false);
    expect(cues).toEqual([{ start: 0, end: 1, text: "Hi" }]);
  });

  it("tự nhận diện định dạng XML", () => {
    const xml = `<transcript><text start="0" dur="2">Hello</text></transcript>`;
    const cues = parseYouTubeTimedtext(xml, false);
    expect(cues).toEqual([{ start: 0, end: 2, text: "Hello" }]);
  });

  it("tự nhận diện định dạng WEBVTT", () => {
    const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello from VTT\n";
    const cues = parseYouTubeTimedtext(vtt, false);
    expect(cues).toEqual([{ start: 1, end: 3, text: "Hello from VTT" }]);
  });
});
