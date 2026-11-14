import { parseUnreadUpdate, UNREAD_UPDATE_KEY } from "../shared/updates";

// Serialize startup, install and acknowledgement so a stale badge read cannot win.
let pending: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

async function syncBadge(): Promise<void> {
  const stored = await chrome.storage.local.get(UNREAD_UPDATE_KEY);
  const unread = parseUnreadUpdate(stored[UNREAD_UPDATE_KEY]);
  if (unread) await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
  await chrome.action.setBadgeText({ text: unread ? "NEW" : "" });
}

export function restoreUpdateBadge(): Promise<void> {
  return enqueue(syncBadge);
}

export function recordInstalledUpdate(details: chrome.runtime.InstalledDetails): Promise<void> {
  return enqueue(async () => {
    const version = chrome.runtime.getManifest().version;
    // Unpacked reloads can also fire onInstalled with reason "update".
    if (details.reason !== "update" || !details.previousVersion || details.previousVersion === version) return;
    await chrome.storage.local.set({
      [UNREAD_UPDATE_KEY]: { version, previousVersion: details.previousVersion },
    });
    await syncBadge();
  });
}

export function acknowledgeUpdate(version: string): Promise<{ ok: true }> {
  return enqueue(async () => {
    const stored = await chrome.storage.local.get(UNREAD_UPDATE_KEY);
    const unread = parseUnreadUpdate(stored[UNREAD_UPDATE_KEY]);
    if (unread?.version === version) await chrome.storage.local.remove(UNREAD_UPDATE_KEY);
    await syncBadge();
    return { ok: true };
  });
}
