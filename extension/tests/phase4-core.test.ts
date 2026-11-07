/**
 * Phase 4 — test logic thuần: Disposer, kéo thả, chọn track/cue, dò video, store, native fallback.
 */
import { describe, it, expect, vi } from "vitest";
import { Disposer } from "../src/shared/disposer";
import { computeDragPosition, isValidPos, overlayPosKey, type DragStart } from "../src/content/overlay/useDraggable";
import {
  pickTrackIndex,
  cueListToCues,
  buildHtml5TrackKey,
  SUBTRANS_TRACK_LABEL,
  type TextTrackLike,
} from "../src/content/adapters/html5";
import { pickLargestVideo, isCandidateVideo, type VideoLike } from "../src/content/videoDetector";
import { OverlayStore } from "../src/content/overlay/store";
import { cueTextForMode } from "../src/content/overlay/nativeTrackFallback";
import type { SubtitleItem } from "../src/shared/types";

describe("Disposer", () => {
  it("abort signal + chạy cleanup ngược thứ tự, chỉ 1 lần", () => {
    const d = new Disposer();
    const order: number[] = [];
    d.add(() => order.push(1));
    d.add(() => order.push(2));
    const target = new EventTarget();
    const fn = vi.fn();
    target.addEventListener("x", fn, { signal: d.signal });
    d.disposeAll();
    d.disposeAll();
    target.dispatchEvent(new Event("x"));
    expect(order).toEqual([2, 1]);
    expect(fn).not.toHaveBeenCalled();
    expect(d.signal.aborted).toBe(true);
  });

  it("cleanup lỗi không chặn cleanup khác; add sau dispose chạy ngay", () => {
    const d = new Disposer();
    const ok = vi.fn();
    d.add(ok);
    d.add(() => {
      throw new Error("boom");
    });
    d.disposeAll();
    expect(ok).toHaveBeenCalledOnce();
    const late = vi.fn();
    d.add(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("interval/timeout/observer được dọn; child dispose theo cha", () => {
    vi.useFakeTimers();
    const d = new Disposer();
    const tick = vi.fn();
    d.interval(tick, 100);
    const obs = { disconnect: vi.fn() };
    d.observe(obs);
    const child = d.child();
    const childFn = vi.fn();
    child.add(childFn);
    vi.advanceTimersByTime(250);
    expect(tick).toHaveBeenCalledTimes(2);
    d.disposeAll();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(obs.disconnect).toHaveBeenCalledOnce();
    expect(childFn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe("computeDragPosition (port App.tsx)", () => {
  const start: DragStart = {
    pointerStartX: 500,
    pointerStartY: 400,
    initialCenterX: 400,
    initialCenterY: 380,
    containerWidth: 800,
    containerHeight: 450,
    boxWidth: 300,
    boxHeight: 60,
  };

  it("chưa vượt ngưỡng 3px → null", () => {
    expect(computeDragPosition(start, 502, 401, false)).toBeNull();
  });
  it("đã từng di chuyển thì không xét ngưỡng nữa", () => {
    expect(computeDragPosition(start, 501, 400, true)).toEqual({ xPct: 50.1, yPct: 84.4 });
  });
  it("tính % theo tâm box, làm tròn 0.1", () => {
    expect(computeDragPosition(start, 400, 200, false)).toEqual({ xPct: 37.5, yPct: 40 });
  });
  it("clamp để box nằm trọn trong container", () => {
    // kéo ra ngoài góc trên trái
    expect(computeDragPosition(start, -2000, -2000, false)).toEqual({
      xPct: Math.round((150 / 800) * 1000) / 10,
      yPct: Math.round((30 / 450) * 1000) / 10,
    });
    // kéo ra ngoài góc dưới phải
    expect(computeDragPosition(start, 9000, 9000, false)).toEqual({
      xPct: Math.round((650 / 800) * 1000) / 10,
      yPct: Math.round((420 / 450) * 1000) / 10,
    });
  });
  it("isValidPos + khóa lưu theo hostname", () => {
    expect(isValidPos({ xPct: 10, yPct: 90 })).toBe(true);
    expect(isValidPos({ xPct: NaN, yPct: 1 })).toBe(false);
    expect(isValidPos({ xPct: 120, yPct: 1 })).toBe(false);
    expect(isValidPos(null)).toBe(false);
    expect(overlayPosKey("www.youtube.com")).toBe("overlayPos:www.youtube.com");
  });
});

describe("html5 adapter helpers", () => {
  const t = (kind: string, language: string, label = ""): TextTrackLike => ({
    kind,
    language,
    label,
    mode: "disabled",
    cues: null,
  });

  it("ưu tiên subtitles/captions tiếng Anh, bỏ qua metadata và track SubTrans", () => {
    expect(pickTrackIndex([t("metadata", "en"), t("subtitles", "fr"), t("captions", "en-US")])).toBe(2);
    expect(pickTrackIndex([t("subtitles", "en", SUBTRANS_TRACK_LABEL), t("subtitles", "de")])).toBe(1);
    expect(pickTrackIndex([t("chapters", "en")])).toBe(-1);
    expect(pickTrackIndex([])).toBe(-1);
  });

  it("cueListToCues: bỏ thẻ, giải mã entity, gộp dòng, bỏ cue lỗi, sắp xếp", () => {
    const cues = cueListToCues([
      { startTime: 5, endTime: 7, text: "<v Bob>Second</v>\nline &amp; more" },
      { startTime: 1, endTime: 3, text: "<i>First</i>" },
      { startTime: 8, endTime: 8, text: "zero length" },
      { startTime: 9, endTime: 10, text: "   " },
    ]);
    expect(cues).toEqual([
      { start: 1, end: 3, text: "First" },
      { start: 5, end: 7, text: "Second line & more" },
    ]);
    expect(cueListToCues(null)).toEqual([]);
  });

  it("buildHtml5TrackKey làm tròn duration, NaN → 0", () => {
    const loc = { origin: "https://a.com", pathname: "/v/1" };
    expect(buildHtml5TrackKey(loc, "English", 123.6)).toBe("web:https://a.com/v/1:English:124");
    expect(buildHtml5TrackKey(loc, "track0", NaN)).toBe("web:https://a.com/v/1:track0:0");
  });
});

describe("videoDetector", () => {
  const v = (w: number, h: number, readyState = 1, src = ""): VideoLike => ({
    getBoundingClientRect: () => ({ width: w, height: h }),
    readyState,
    currentSrc: src,
    src,
  });
  it("chọn video lớn nhất đạt ngưỡng 200×120 và có nguồn", () => {
    const small = v(150, 100);
    const noSrc = v(1000, 600, 0);
    const mid = v(640, 360);
    const big = v(960, 540, 0, "blob:x");
    expect(pickLargestVideo([small, noSrc, mid, big])).toBe(big);
    expect(pickLargestVideo([small, noSrc])).toBeNull();
    expect(isCandidateVideo(v(199, 500))).toBe(false);
  });
});

describe("OverlayStore", () => {
  it("chỉ thông báo khi giá trị đổi", () => {
    const s = new OverlayStore();
    const fn = vi.fn();
    s.subscribe(fn);
    s.setState({ mode: "bilingual" }); // giống mặc định
    expect(fn).not.toHaveBeenCalled();
    s.setState({ mode: "vi" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.getState().mode).toBe("vi");
  });
  it("flashToast tự tắt", () => {
    vi.useFakeTimers();
    const s = new OverlayStore();
    s.flashToast("hi", 1000);
    expect(s.getState().toast).toBe("hi");
    vi.advanceTimersByTime(1000);
    expect(s.getState().toast).toBeNull();
    vi.useRealTimers();
  });
});

describe("cueTextForMode (native fallback)", () => {
  const it0 = (en: string, vi: string): SubtitleItem => ({
    id: 0, block: 0, start_sec: 0, end_sec: 1, source_text: en, target_text: vi, translated: !!vi, engine: null,
  });
  it("4 chế độ", () => {
    expect(cueTextForMode(it0("Hello", "Xin chào"), "bilingual")).toBe("Hello\nXin chào");
    expect(cueTextForMode(it0("Hello", ""), "bilingual")).toBe("Hello");
    expect(cueTextForMode(it0("Hello", ""), "vi")).toBe("Hello");
    expect(cueTextForMode(it0("Hello", "Xin chào"), "en")).toBe("Hello");
    expect(cueTextForMode(it0("Hello", "Xin chào"), "off")).toBe("");
  });
});
