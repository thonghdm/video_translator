/**
 * SubTrans Extension — Dịch vụ điều phối sidecar phụ đề Google Drive trong Service Worker
 * Phase 9.5 D3
 */

import {
  DRIVE_ID_RE,
  type DriveLookupReq,
  type DriveLookupRes,
  type SidecarFailReason,
} from "../../shared/driveTypes";
import { LRUCache } from "../../shared/lru";
import { driveFetchText, type DriveFetchResult } from "../engines/driveFetch";
import { parseSrtOrVttBilingual } from "../../shared/subtitleFormat";

export interface SidecarDeps {
  isEnabled(): boolean;
  lookup(tabId: number, req: DriveLookupReq): Promise<DriveLookupRes>;
  fetchText(id: string): Promise<DriveFetchResult>;
  parseCount(text: string): number;
}

export type SidecarOutcome =
  | { ok: true; fileName: string; text: string }
  | { ok: false; reason: SidecarFailReason; indexed?: number };

async function defaultLookup(tabId: number, req: DriveLookupReq): Promise<DriveLookupRes> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<DriveLookupRes>((_, reject) => {
      timer = setTimeout(() => reject(new Error("lookup timeout")), 1500);
    });

    const sendPromise = new Promise<DriveLookupRes>((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
        resolve({ ok: false });
        return;
      }
      chrome.tabs.sendMessage(tabId, req, { frameId: 0 }, (response) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          reject(err);
        } else if (!response || typeof response !== "object") {
          resolve({ ok: false });
        } else {
          resolve(response as DriveLookupRes);
        }
      });
    });

    return await Promise.race([sendPromise, timeoutPromise]);
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultParseCount(text: string): number {
  return parseSrtOrVttBilingual(text).length;
}

export class DriveSidecarService {
  private readonly deps: SidecarDeps;
  private readonly lru = new LRUCache<string, { name: string; text: string }>(20);
  private readonly inFlight = new Map<string, Promise<SidecarOutcome>>();

  constructor(deps?: Partial<SidecarDeps>) {
    this.deps = {
      isEnabled: deps?.isEnabled ?? (() => true),
      lookup: deps?.lookup ?? defaultLookup,
      fetchText: deps?.fetchText ?? driveFetchText,
      parseCount: deps?.parseCount ?? defaultParseCount,
    };
  }

  /**
   * Xử lý yêu cầu tìm và tải phụ đề sidecar cho video trên Google Drive:
   * Tuân thủ nghiêm ngặt 11 bước trong Phase D3.
   */
  public async handle(
    sender: chrome.runtime.MessageSender | undefined,
    videoDocId?: string
  ): Promise<SidecarOutcome> {
    // 1. !isEnabled() → disabled
    if (!this.deps.isEnabled()) {
      return { ok: false, reason: "disabled" };
    }

    // 2. Thiếu sender.tab.id/sender.tab.url, hoặc hostname !== "drive.google.com" → not_drive
    if (!sender?.tab?.id || !sender.tab.url) {
      return { ok: false, reason: "not_drive" };
    }
    try {
      const tabUrl = new URL(sender.tab.url);
      if (tabUrl.hostname !== "drive.google.com") {
        return { ok: false, reason: "not_drive" };
      }
    } catch {
      return { ok: false, reason: "not_drive" };
    }
    const tabId = sender.tab.id;

    // 3. videoDocId sai regex → coi như không có (không báo lỗi)
    let validDocId: string | undefined = videoDocId;
    if (typeof validDocId === "string" && !DRIVE_ID_RE.test(validDocId)) {
      validDocId = undefined;
    }

    // 4. lookup ném lỗi, quá timeout, hoặc {ok:false} → index_unavailable
    let lookupRes: DriveLookupRes;
    try {
      lookupRes = await this.deps.lookup(tabId, {
        type: "drive.lookup",
        videoDocId: validDocId,
      });
    } catch {
      return { ok: false, reason: "index_unavailable" };
    }
    if (!lookupRes || !lookupRes.ok) {
      return { ok: false, reason: "index_unavailable" };
    }

    // 5. result === "none" → no_match (kèm indexed); "ambiguous" → ambiguous.
    //    Dữ liệu từ content script không đáng tin: result lạ → index_unavailable; indexed không phải số → 0.
    const indexed =
      typeof lookupRes.indexed === "number" && Number.isFinite(lookupRes.indexed) && lookupRes.indexed >= 0
        ? Math.floor(lookupRes.indexed)
        : 0;
    if (lookupRes.result === "none") {
      return { ok: false, reason: "no_match", indexed };
    }
    if (lookupRes.result === "ambiguous") {
      return { ok: false, reason: "ambiguous" };
    }
    if (lookupRes.result !== "match") {
      return { ok: false, reason: "index_unavailable" };
    }

    // 6. id từ lookup sai regex, hoặc name rỗng → index_unavailable (không tin dữ liệu, kể cả từ top frame)
    const { id, name } = lookupRes;
    if (
      typeof id !== "string" ||
      !DRIVE_ID_RE.test(id) ||
      typeof name !== "string" ||
      name.trim() === ""
    ) {
      return { ok: false, reason: "index_unavailable" };
    }

    // 7. LRU id → {name, text} (tối đa 20). Hit → trả ngay.
    const cached = this.lru.get(id);
    if (cached) {
      return { ok: true, fileName: cached.name, text: cached.text };
    }

    // 8. Gộp request trùng theo khóa id: đang có promise cùng khóa thì dùng lại; xóa khỏi map trong finally
    let promise = this.inFlight.get(id);
    if (promise) {
      return await promise;
    }

    promise = (async (): Promise<SidecarOutcome> => {
      // 9. fetchText(id) lỗi → trả reason tương ứng
      const fetchRes = await this.deps.fetchText(id);
      if (!fetchRes.ok) {
        return { ok: false, reason: fetchRes.reason };
      }

      // 10. parseCount(text) === 0 → bad_format (không đưa vào LRU)
      const count = this.deps.parseCount(fetchRes.text);
      if (count === 0) {
        return { ok: false, reason: "bad_format" };
      }

      // 11. OK → lưu LRU, trả { ok: true, fileName: name, text }
      this.lru.set(id, { name, text: fetchRes.text });
      return { ok: true, fileName: name, text: fetchRes.text };
    })();

    this.inFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(id);
    }
  }
}
