// @vitest-environment jsdom
/**
 * Phase 9.5 D2 — công tắc "Tự nhận phụ đề .srt trên Google Drive" trên trang Options (render thật, bấm thật).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Options } from "../src/options/Options";
import type { Settings } from "../src/shared/settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeChrome(initial?: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...(initial ?? {}) };
  const listeners = new Set<(c: Record<string, unknown>, area: string) => void>();
  (globalThis as any).chrome = {
    runtime: { sendMessage: async () => ({ ok: true, stats: { tracks: 0, lines: 0 }, items: [] }) },
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        set: async (obj: Record<string, unknown>) => {
          const changes: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = structuredClone(v);
          }
          queueMicrotask(() => listeners.forEach((l) => l(changes, "local")));
        },
        remove: async () => {},
      },
      onChanged: {
        addListener: (l: any) => listeners.add(l),
        removeListener: (l: any) => listeners.delete(l),
      },
    },
  };
  return store;
}

const LABEL = "Tự nhận phụ đề .srt cùng thư mục trên Google Drive";
let root: Root | null = null;

async function mount(): Promise<HTMLInputElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(Options)));
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  const span = [...el.querySelectorAll("span")].find((s) => s.textContent?.trim() === LABEL);
  expect(span, "không tìm thấy công tắc Drive trên trang Options").toBeTruthy();
  const input = span!.closest("label")!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  return input;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("Phase 9.5 D2 — công tắc Drive trên Options", () => {
  it("mặc định bật; bấm → lưu drive.autoSidecar=false, các setting khác giữ nguyên", async () => {
    const store = fakeChrome();
    const input = await mount();
    expect(input.checked).toBe(true);

    await act(async () => input.click());
    await act(async () => new Promise((r) => setTimeout(r, 400))); // > SETTINGS_DEBOUNCE_MS
    const saved = store.settings as Settings;
    expect(saved.drive.autoSidecar).toBe(false);
    expect(saved.shortcuts.enabled).toBe(true);
    expect(input.checked).toBe(false);
  });

  it("blob đã lưu autoSidecar=false → công tắc hiển thị tắt", async () => {
    fakeChrome({ settings: { drive: { autoSidecar: false } } });
    const input = await mount();
    expect(input.checked).toBe(false);
  });
});
