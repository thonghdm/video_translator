// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=START"}
/**
 * Phase 5 — các phần sửa sau khi kiểm chứng trên YouTube thật (NOTES.md › Phase 5).
 * Fixture được VIẾT TAY, chỉ mô phỏng CẤU TRÚC json3 đo được (cửa sổ cuộn wWinId/aAppend, event chồng lấn,
 * tOffsetMs theo từ) — không chứa nội dung phụ đề thật của video nào.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeTimeline,
  parseJson3,
  parseXmlTimedtext,
  parseYouTubeTimedtext,
  deriveTrackUrl,
  timedtextMatchesTrack,
  parseTimedtextUrl,
} from "../src/content/adapters/ytParser";
import {
  YouTubeHookClient,
  createYouTubeAdapter,
  watchYouTubeNavigation,
  isYouTubeWatch,
} from "../src/content/adapters/youtube";
import { findSubtitleAtTime, cuesToItems } from "../src/shared/subtitles";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** json3 kiểu ASR "cửa sổ cuộn": mỗi event sống tới khi dòng sau thay thế → chồng thời gian */
function rollingAsrJson3(): string {
  const sentences = [
    "so today we are going to talk about arrays.",
    "an array is a list of values stored in order.",
    "you can read any item by its index.",
    "the first index is zero not one.",
    "now let us write a small loop.",
    "the loop visits every item once.",
    "inside the loop we print the value.",
    "run the program and check the output.",
    "if it looks right we can move on.",
    "next time we will learn about objects.",
  ];
  const events: unknown[] = [{ tStartMs: 0, dDurationMs: 60000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 }];
  let t = 1000;
  for (const s of sentences) {
    const words = s.split(" ");
    const half = Math.ceil(words.length / 2);
    for (const part of [words.slice(0, half), words.slice(half)]) {
      // event chữ: các từ có tOffsetMs; dDuration kéo dài sang event sau (chồng lấn)
      events.push({
        tStartMs: t,
        dDurationMs: 2600,
        wWinId: 1,
        segs: part.map((w, i) => ({ utf8: (i ? " " : "") + w, tOffsetMs: i * 180 })),
      });
      // event xuống dòng (aAppend) — phải bị bỏ qua
      events.push({ tStartMs: t + 1300, dDurationMs: 1300, wWinId: 1, aAppend: 1, segs: [{ utf8: "\n" }] });
      t += 1300;
    }
    t += 200;
  }
  return JSON.stringify({ wireMagic: "pb3", events });
}

describe("normalizeTimeline", () => {
  it("cắt chồng lấn, bỏ cue quá ngắn, sắp xếp", () => {
    const out = normalizeTimeline([
      { start: 5, end: 9, text: "C" },
      { start: 0, end: 4, text: "A" },
      { start: 2, end: 6, text: "B" },
      { start: 6, end: 6.01, text: "tiny" },
    ]);
    expect(out).toEqual([
      { start: 0, end: 2, text: "A" },
      { start: 2, end: 5, text: "B" },
      { start: 5, end: 9, text: "C" },
    ]);
  });
});

describe("json3 cửa sổ cuộn (ASR)", () => {
  const cues = parseJson3(rollingAsrJson3(), true);

  it("gộp thành câu, bỏ event xuống dòng, không còn chồng thời gian", () => {
    expect(cues.length).toBe(10);
    expect(cues[0].text).toBe("so today we are going to talk about arrays.");
    expect(cues.some((c) => c.text.includes("\n"))).toBe(false);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
  });

  it("findSubtitleAtTime luôn tìm thấy dòng trong khoảng có phụ đề (trước khi sửa thì bỏ sót)", () => {
    const items = cuesToItems(cues);
    let misses = 0;
    for (let t = cues[0].start; t < cues[cues.length - 1].end; t += 0.1) {
      const inside = cues.some((c) => t >= c.start && t <= c.end);
      if (inside && !findSubtitleAtTime(items, t)) misses++;
    }
    expect(misses).toBe(0);
  });

  it("track thủ công cũng chồng lấn → sau parse vẫn không chồng", () => {
    const manual = parseJson3(
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: "First caption line." }] },
          { tStartMs: 3000, dDurationMs: 4000, segs: [{ utf8: "Second caption line." }] },
          { tStartMs: 6000, dDurationMs: 3000, segs: [{ utf8: "Third caption line." }] },
        ],
      }),
      false
    );
    expect(manual.map((c) => [c.start, c.end])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
  });
});

describe("XML timedtext", () => {
  it("srv3 (<p t d> mili-giây, có <s>)", () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>
      <p t="1000" d="2000"><s>Hello</s><s> there.</s></p>
      <p t="3500" d="1500">Second &amp; last.</p></body></timedtext>`;
    const cues = parseXmlTimedtext(xml, false);
    expect(cues).toEqual([
      { start: 1, end: 3, text: "Hello there." },
      { start: 3.5, end: 5, text: "Second & last." },
    ]);
    expect(parseYouTubeTimedtext(xml, false)).toEqual(cues);
  });
});

describe("deriveTrackUrl / timedtextMatchesTrack", () => {
  const potUrl =
    "https://www.youtube.com/api/timedtext?v=VID&lang=fr&tlang=vi&pot=SECRET&potc=1&fmt=srv3&c=WEB";

  it("giữ pot và tham số khác, đổi lang/kind, bỏ tlang, ép fmt=json3", () => {
    const manual = new URL(deriveTrackUrl(potUrl, { languageCode: "en" })!);
    expect(manual.searchParams.get("lang")).toBe("en");
    expect(manual.searchParams.has("kind")).toBe(false);
    expect(manual.searchParams.has("tlang")).toBe(false);
    expect(manual.searchParams.get("fmt")).toBe("json3");
    expect(manual.searchParams.get("pot")).toBe("SECRET");
    expect(manual.searchParams.get("c")).toBe("WEB");
    const asr = new URL(deriveTrackUrl(potUrl, { languageCode: "en", kind: "asr" })!);
    expect(asr.searchParams.get("kind")).toBe("asr");
  });

  it("chỉ khớp đúng lang + kind, không khớp bản tự dịch", () => {
    const p = (u: string) => parseTimedtextUrl(u);
    const base = "https://www.youtube.com/api/timedtext?v=V";
    expect(timedtextMatchesTrack(p(`${base}&lang=en`), { languageCode: "en" })).toBe(true);
    expect(timedtextMatchesTrack(p(`${base}&lang=en&kind=asr`), { languageCode: "en" })).toBe(false);
    expect(timedtextMatchesTrack(p(`${base}&lang=en&kind=asr`), { languageCode: "en", kind: "asr" })).toBe(true);
    expect(timedtextMatchesTrack(p(`${base}&lang=en&tlang=vi`), { languageCode: "en" })).toBe(false);
    expect(timedtextMatchesTrack(p(`${base}&lang=en-GB`), { languageCode: "en" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("yt-hook (MAIN world) trong jsdom", () => {
  it("bắt timedtext qua fetch, trong suốt với trang, phát lại bộ đệm, chặn URL lạ", async () => {
    const realFetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      if (u.includes("/api/timedtext")) return new Response('{"events":[]}', { status: 200 });
      return new Response("other", { status: 200 });
    });
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
    delete (window as unknown as { __subtransYtHook?: unknown }).__subtransYtHook;
    vi.resetModules();
    await import("../src/content/yt-hook");

    const got: Array<Record<string, unknown>> = [];
    const onMsg = (e: MessageEvent) => {
      if (e.data?.source === "subtrans-yt") got.push(e.data);
    };
    window.addEventListener("message", onMsg);

    // Trang gọi fetch (kể cả bằng URL object) → nhận đúng response gốc
    const r1 = await window.fetch(new URL("https://www.youtube.com/api/timedtext?v=A&lang=en&pot=1"));
    expect(await r1.text()).toBe('{"events":[]}');
    const r2 = await window.fetch("https://www.youtube.com/other");
    expect(await r2.text()).toBe("other");
    await new Promise((r) => setTimeout(r, 50));
    expect(got.filter((m) => m.kind === "timedtext")).toHaveLength(1);

    // content script nghe muộn → xin replay → nhận lại bộ đệm
    got.length = 0;
    window.postMessage({ source: "subtrans-cs", kind: "replay" }, location.origin);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.filter((m) => m.kind === "timedtext")).toHaveLength(1);

    // fetchTimedtext chỉ chấp nhận endpoint timedtext cùng origin
    got.length = 0;
    window.postMessage({ source: "subtrans-cs", kind: "fetchTimedtext", reqId: "bad", url: "https://evil.example/x" }, location.origin);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.find((m) => m.reqId === "bad")).toMatchObject({ ok: false });

    // Cài 2 lần không patch chồng
    vi.resetModules();
    const before = window.fetch;
    await import("../src/content/yt-hook");
    expect(window.fetch).toBe(before);

    window.removeEventListener("message", onMsg);
  });
});

// ---------------------------------------------------------------------------
describe("listSources sau SPA navigation", () => {
  it("chờ tới khi playerResponse khớp videoId hiện tại (không lấy phụ đề video cũ)", async () => {
    history.replaceState(null, "", "/watch?v=NEW");
    const hook = new YouTubeHookClient();
    let n = 0;
    vi.spyOn(hook, "requestPlayerResponse").mockImplementation(async () => {
      n++;
      return n < 3
        ? { videoId: "OLD", captionTracks: [{ baseUrl: "x", languageCode: "en", name: "English" }] }
        : { videoId: "NEW", title: "New", captionTracks: [{ baseUrl: "y", languageCode: "en", name: "English" }] };
    });
    const adapter = createYouTubeAdapter({ hookClient: hook, playerResponseRetryMs: 5 });
    const sources = await adapter.listSources(document.createElement("video"));
    expect(n).toBe(3);
    expect(sources).toHaveLength(1);
    expect(sources[0].track.trackKey).toBe("yt:NEW:en:manual");
    sources[0].dispose();
    hook.dispose();
  });

  it("livestream đang phát → không có nguồn; VOD của livestream cũ vẫn dùng được", async () => {
    history.replaceState(null, "", "/watch?v=L");
    const hook = new YouTubeHookClient();
    const tracks = [{ baseUrl: "x", languageCode: "en", name: "English", kind: "asr" }];
    const spy = vi.spyOn(hook, "requestPlayerResponse");
    const adapter = createYouTubeAdapter({ hookClient: hook, playerResponseRetryMs: 1 });
    spy.mockResolvedValue({ videoId: "L", isLiveContent: true, isLiveNow: true, captionTracks: tracks });
    expect(await adapter.listSources(document.createElement("video"))).toHaveLength(0);
    spy.mockResolvedValue({ videoId: "L", isLiveContent: true, isLiveNow: false, captionTracks: tracks });
    const s = await adapter.listSources(document.createElement("video"));
    expect(s).toHaveLength(1);
    s[0].dispose();
    hook.dispose();
  });
});

describe("watchYouTubeNavigation", () => {
  it("chỉ báo khi videoId đổi (bỏ qua &t=, &list=)", () => {
    vi.useFakeTimers();
    history.replaceState(null, "", "/watch?v=A");
    const cb = vi.fn();
    const off = watchYouTubeNavigation(cb);
    history.replaceState(null, "", "/watch?v=A&t=30s");
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(cb).not.toHaveBeenCalled();
    history.replaceState(null, "", "/watch?v=B&list=PL1");
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledWith("B");
    history.replaceState(null, "", "/");
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(cb).toHaveBeenLastCalledWith(null);
    expect(cb).toHaveBeenCalledTimes(2);
    off();
  });

  it("isYouTubeWatch", () => {
    const l = (h: string, p: string, q = "") => ({ hostname: h, pathname: p, href: `https://${h}${p}${q}` });
    expect(isYouTubeWatch(l("www.youtube.com", "/watch", "?v=x"))).toBe(true);
    expect(isYouTubeWatch(l("www.youtube.com", "/watch"))).toBe(false);
    expect(isYouTubeWatch(l("www.youtube.com", "/shorts/x"))).toBe(false);
  });
});
