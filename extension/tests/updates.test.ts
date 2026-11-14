import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { acknowledgeUpdate, recordInstalledUpdate, restoreUpdateBadge } from "../src/background/updates";
import { UpdateNotice } from "../src/popup/UpdateNotice";
import { changelogFor, parseUnreadUpdate } from "../src/shared/updates";
import { version } from "../package.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: Record<string, unknown>;
let root: Root | undefined;
let host: HTMLDivElement;
let listeners: Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>;

beforeEach(() => {
  store = { settings: { enabled: true } };
  listeners = new Set();
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version }),
      sendMessage: vi.fn((msg: { version: string }) => acknowledgeUpdate(msg.version)),
    },
    action: { setBadgeText: vi.fn().mockResolvedValue(undefined), setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(store, values);
          for (const [key, value] of Object.entries(values)) {
            listeners.forEach((fn) => fn({ [key]: { newValue: value } }, "local"));
          }
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
          listeners.forEach((fn) => fn({ [key]: {} }, "local"));
        }),
      },
      onChanged: {
        addListener: (fn: typeof listeners extends Set<infer T> ? T : never) => listeners.add(fn),
        removeListener: (fn: typeof listeners extends Set<infer T> ? T : never) => listeners.delete(fn),
      },
    },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("update lifecycle", () => {
  it("records version changes and restores NEW after a worker restart", async () => {
    await recordInstalledUpdate({ reason: "update" as chrome.runtime.OnInstalledReason, previousVersion: "0.1.0" });
    expect(store.unreadUpdate).toEqual({ version, previousVersion: "0.1.0" });
    vi.mocked(chrome.action.setBadgeText).mockClear();
    await restoreUpdateBadge();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "NEW" });
    expect(store.settings).toEqual({ enabled: true });
  });

  it("ignores first install, browser updates and same-version reloads", async () => {
    for (const details of [
      { reason: "install" }, { reason: "chrome_update" },
      { reason: "update", previousVersion: version },
    ]) await recordInstalledUpdate(details as chrome.runtime.InstalledDetails);
    expect(store.unreadUpdate).toBeUndefined();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("serializes startup and update, and protects newer notices from stale acknowledgements", async () => {
    await Promise.all([
      restoreUpdateBadge(),
      recordInstalledUpdate({ reason: "update" as chrome.runtime.OnInstalledReason, previousVersion: "0.1.0" }),
    ]);
    await acknowledgeUpdate("0.1.0");
    expect(store.unreadUpdate).toBeDefined();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "NEW" });
    await acknowledgeUpdate(version);
    expect(store.unreadUpdate).toBeUndefined();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
    await restoreUpdateBadge();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  });

  it("renders changelog without clearing unread state until explicit acknowledgement", async () => {
    store.unreadUpdate = { version, previousVersion: "0.1.0" };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(UpdateNotice)));
    expect(host.textContent).toContain(`v${version}`);
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(store.unreadUpdate).toBeDefined();
    await act(async () => host.querySelector("button")!.click());
    expect(store.unreadUpdate).toBeUndefined();
    expect(host.textContent).toBe("");
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  });

  it("keeps the notice when acknowledgement fails", async () => {
    store.unreadUpdate = { version, previousVersion: "0.1.0" };
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(new Error("offline"));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(UpdateNotice)));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(store.unreadUpdate).toBeDefined();
    expect(host.querySelector("button")!.disabled).toBe(false);
  });

  it("handles malformed storage and unknown release versions", () => {
    expect(parseUnreadUpdate({ version: 1 })).toBeNull();
    expect(parseUnreadUpdate(null)).toBeNull();
    expect(changelogFor("99.0.0").length).toBeGreaterThan(0);
  });
});
