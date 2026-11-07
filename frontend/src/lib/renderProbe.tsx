import React, { Profiler, ProfilerOnRenderCallback } from "react";

/**
 * Công cụ đo render (mặc định TẮT, không tốn chi phí).
 * Bật bằng: localStorage.setItem("vt_render_probe", "1") rồi reload,
 * hoặc gán window.__VT_RENDER_PROBE__ = createRenderProbe() trước khi render (dùng trong test).
 * Xem kết quả: window.__vtProbeReport() trong DevTools console.
 */
export interface RenderProbeStats {
  renders: Record<string, number>; // số lần thân component thực sự chạy (memo bailout KHÔNG tính)
  commits: number; // số lần React Profiler báo commit của cây <App/>
  actualMs: number; // tổng actualDuration do React Profiler báo
}

declare global {
  interface Window {
    __VT_RENDER_PROBE__?: RenderProbeStats;
    __vtProbeReport?: () => RenderProbeStats | undefined;
    __vtProbeReset?: () => void;
  }
}

export function createRenderProbe(): RenderProbeStats {
  return { renders: {}, commits: 0, actualMs: 0 };
}

export function countRender(id: string): void {
  const probe = typeof window !== "undefined" ? window.__VT_RENDER_PROBE__ : undefined;
  if (probe) probe.renders[id] = (probe.renders[id] ?? 0) + 1;
}

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  const probe = window.__VT_RENDER_PROBE__;
  if (!probe) return;
  probe.commits += 1;
  probe.actualMs += actualDuration;
};

export function enableRenderProbeFromStorage(): void {
  try {
    if (localStorage.getItem("vt_render_probe") !== "1") return;
  } catch {
    return;
  }
  window.__VT_RENDER_PROBE__ = createRenderProbe();
  window.__vtProbeReport = () => {
    const p = window.__VT_RENDER_PROBE__;
    if (p) console.table({ ...p.renders, "Profiler commits": p.commits, "Profiler actualMs": Math.round(p.actualMs * 10) / 10 });
    return p;
  };
  window.__vtProbeReset = () => {
    window.__VT_RENDER_PROBE__ = createRenderProbe();
  };
}

export const RenderProbeRoot: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  typeof window !== "undefined" && window.__VT_RENDER_PROBE__ ? (
    <Profiler id="App" onRender={onRender}>
      {children}
    </Profiler>
  ) : (
    <>{children}</>
  );
