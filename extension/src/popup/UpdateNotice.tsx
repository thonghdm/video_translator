import { useEffect, useState } from "react";
import { changelogFor, parseUnreadUpdate, UNREAD_UPDATE_KEY, type UnreadUpdate } from "../shared/updates";
import type { UiReq } from "../shared/messages";

export function UpdateNotice() {
  const [unread, setUnread] = useState<UnreadUpdate | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    let active = true;
    let changed = false;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !(UNREAD_UPDATE_KEY in changes)) return;
      changed = true;
      if (active) setUnread(parseUnreadUpdate(changes[UNREAD_UPDATE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    void chrome.storage.local.get(UNREAD_UPDATE_KEY).then((stored) => {
      if (active && !changed) setUnread(parseUnreadUpdate(stored[UNREAD_UPDATE_KEY]));
    }).catch(() => { if (active) setError(true); });
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  if (!unread) return null;

  const acknowledge = async () => {
    setSaving(true);
    setError(false);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "update.acknowledge", version: unread.version,
      } satisfies UiReq);
      if (!response?.ok) throw new Error("Acknowledgement failed");
      // Storage change above closes the notice, including in other open popups.
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Nội dung cập nhật" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2 text-xs text-neutral-200">
      <h2 className="font-semibold text-amber-300">SubTrans đã cập nhật lên v{unread.version}</h2>
      <p className="text-neutral-400">Phiên bản trước: {unread.previousVersion}</p>
      <ul className="list-disc pl-4 space-y-1">
        {changelogFor(unread.version).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p>Nếu trang video đang mở mất kết nối, nhấn F5 để tiếp tục dịch.</p>
      {error && <p role="alert" className="text-rose-300">Chưa lưu được xác nhận. Vui lòng thử lại.</p>}
      <button type="button" disabled={saving} onClick={() => void acknowledge()}
        className="rounded bg-amber-500/20 px-3 py-1 font-medium text-amber-300 hover:bg-amber-500/30 disabled:opacity-50">
        {saving ? "Đang lưu…" : "Đã hiểu"}
      </button>
    </section>
  );
}
