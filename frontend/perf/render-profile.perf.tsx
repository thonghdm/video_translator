// @vitest-environment jsdom
/**
 * Đo render của <App/> khi đang PHÁT VIDEO (kịch bản: BUG-04 + BUG-05).
 * Mô phỏng 10 giây phát: currentTime nhảy mỗi 250ms, pipeline_status mỗi 500ms,
 * new_subtitle_chunk mỗi 1,25s; khóa học 200 bài + 1000 câu phụ đề, mở cả 2 panel.
 * Chạy: pnpm perf:render   (kết quả ghi ra perf-result.json hoặc $VT_PERF_OUT)
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, vi, expect } from "vitest";
import { writeFileSync } from "node:fs";
import App from "../src/App";
import { RenderProbeRoot, createRenderProbe } from "../src/lib/renderProbe";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const VIDEO = "C:/course/g01/bai01.mp4";
const TICKS = 40; // 40 * 250ms = 10s
const TICK_MS = 250;

function buildTree() {
  const groups = Array.from({ length: 10 }, (_, g) => ({
    name: `Chuong ${g + 1}`,
    path: `C:/course/g${String(g + 1).padStart(2, "0")}`,
    is_dir: true,
    children: Array.from({ length: 20 }, (_, i) => ({
      name: `bai${String(i + 1).padStart(2, "0")}.mp4`,
      path: `C:/course/g${String(g + 1).padStart(2, "0")}/bai${String(i + 1).padStart(2, "0")}.mp4`,
      is_dir: false,
    })),
  }));
  return { name: "course", path: "C:/course", is_dir: true, children: groups };
}

function subs(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: offset + i,
    block: Math.floor((offset + i) / 10),
    start_sec: (offset + i) * 3,
    end_sec: (offset + i) * 3 + 2.5,
    source_text: `English sentence number ${offset + i}`,
    target_text: `Cau tieng Viet so ${offset + i}`,
    translated: true,
  }));
}

describe("render profile khi đang phát video", () => {
  it("đo", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const handlers: Record<string, Set<(...a: any[]) => void>> = {};
    const emit = (name: string, payload: any) => handlers[name]?.forEach((h) => h(payload));
    let mediaTime = 0;
    let rafQueue: FrameRequestCallback[] = [];

    (window as any).runtime = {
      EventsOn: (name: string, cb: (...a: any[]) => void) => {
        (handlers[name] ??= new Set()).add(cb);
        return () => handlers[name].delete(cb);
      },
    };
    const api: Record<string, any> = {
      CheckModelsReady: async () => true,
      GetModelStatuses: async () => ({ whisper_base: true, qwen_1_5b: true }),
      ScanVideoFolder: async () => buildTree(),
      OpenVideo: async (p: string) => ({
        path: p, title: "bai01", duration_sec: 3600, block_sec: 30, total_blocks: 120,
        media_url: "", playable: true, playable_reason: "", done_blocks: [0, 1, 2, 3],
      }),
      LoadCachedSubtitles: async () => subs(1000),
    };
    (window as any).go = {
      main: { App: new Proxy(api, { get: (t, k: string) => t[k] ?? (async () => undefined) }) },
    };
    localStorage.setItem("subtrans_imported_folders_v1", JSON.stringify(["C:/course"]));

    window.requestAnimationFrame = (cb) => (rafQueue.push(cb), rafQueue.length);
    window.cancelAnimationFrame = () => {};
    Element.prototype.scrollIntoView = () => {};
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { get: () => mediaTime, set: () => {}, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", { get: () => 3600, configurable: true });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
    (window as any).alert = () => {};

    const probe = createRenderProbe();
    window.__VT_RENDER_PROBE__ = probe;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const settle = async (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    await act(async () => { root.render(<RenderProbeRoot><App /></RenderProbeRoot>); });
    await settle(100);
    await settle(100);

    // Chọn bài đầu tiên trong cây thư mục -> sang chế độ player
    const leaf = Array.from(container.querySelectorAll("div")).find((d) => d.textContent === "bai01.mp4" && d.onclick !== undefined && (d as any).__reactProps$);
    const leafEl = leaf ?? Array.from(container.querySelectorAll("*")).find((e) => e.children.length === 0 && e.textContent?.trim() === "bai01.mp4");
    expect(leafEl, "không tìm thấy video trong cây").toBeTruthy();
    await act(async () => { (leafEl as HTMLElement).click(); });
    await settle(200);
    await settle(200);

    // Mở lại panel cây thư mục (autoCollapse đã tự ẩn) + panel danh sách phụ đề
    const openTree = container.querySelector('[title^="Mở cây thư mục"]') as HTMLElement | null;
    if (openTree) await act(async () => { openTree.click(); });
    const subBtn = container.querySelector('[title="Bật/tắt panel danh sách phụ đề"]') as HTMLElement | null;
    expect(subBtn, "không có nút panel phụ đề").toBeTruthy();
    await act(async () => { subBtn!.click(); });
    await settle(50);

    // Cửa sổ đo
    probe.renders = {}; probe.commits = 0; probe.actualMs = 0;
    let chunkSeq = 5000;
    const t0 = performance.now();
    for (let tick = 1; tick <= TICKS; tick++) {
      mediaTime += TICK_MS / 1000;
      // Mỗi sự kiện chạy trong 1 act riêng để phản ánh đúng thực tế (mỗi sự kiện = 1 lần commit riêng)
      await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); }); // setInterval 250ms của LandingPage (nếu còn chạy)
      await act(async () => { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(performance.now())); }); // syncFrame -> setCurrentTime
      if (tick % 2 === 0) {
        await act(async () => {
          emit("pipeline_status", {
            state: "ahead", message: "", block: 3, done_blocks: 4, total_blocks: 120,
            ahead_sec: 120 - tick * 0.25, video: VIDEO, translator_mode: "api",
          });
        });
      }
      if (tick % 5 === 0) {
        await act(async () => {
          emit("new_subtitle_chunk", { video: VIDEO, block: 4, final: false, items: subs(3, chunkSeq) });
        });
        chunkSeq += 3;
      }
    }
    const wallMs = performance.now() - t0;

    const result = {
      scenario: `${TICKS * TICK_MS / 1000}s phát, 200 bài trong cây, 1000+ câu phụ đề, 2 panel mở`,
      renders: probe.renders,
      profilerCommits: probe.commits,
      profilerActualMs: Math.round(probe.actualMs * 10) / 10,
      wallMsJsdom: Math.round(wallMs),
    };
    writeFileSync(process.env.VT_PERF_OUT || "perf-result.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    root.unmount();
  }, 120000);
});
