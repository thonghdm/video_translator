/**
 * SubTrans Extension — Dịch vụ điều phối sidecar phụ đề Google Drive trong Service Worker
 * Phase 9.5 D3, Phase 9.6 E3 (§3, §4)
 */

import {
  DRIVE_ID_RE,
  type DriveFileRef,
  type DriveLookupReq,
  type DriveLookupRes,
  type SidecarFailReason,
  type SidecarFile,
  type SidecarMode,
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
  | {
      ok: true;
      mode: SidecarMode;
      en?: SidecarFile;
      vi?: SidecarFile;
      bi?: SidecarFile;
      fileName: string;
      text: string;
    }
  | { ok: false; reason: SidecarFailReason; indexed?: number };

type FetchOneResult =
  | { ok: true; file: SidecarFile }
  | { ok: false; reason: SidecarFailReason };

function isValidRef(ref: unknown): ref is DriveFileRef {
  if (typeof ref !== "object" || ref === null) return false;
  const obj = ref as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    DRIVE_ID_RE.test(obj.id) &&
    typeof obj.name === "string" &&
    obj.name.trim() !== ""
  );
}

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
  private readonly lru = new LRUCache<string, SidecarFile>(20);
  private readonly inFlight = new Map<string, Promise<FetchOneResult>>();

  constructor(deps?: Partial<SidecarDeps>) {
    this.deps = {
      isEnabled: deps?.isEnabled ?? (() => true),
      lookup: deps?.lookup ?? defaultLookup,
      fetchText: deps?.fetchText ?? driveFetchText,
      parseCount: deps?.parseCount ?? defaultParseCount,
    };
  }

  /**
   * Tải một file phụ đề qua LRU và gộp request trùng in-flight.
   */
  public async fetchOne(id: string, name: string): Promise<FetchOneResult> {
    // 1. Kiểm tra LRU cache
    const cached = this.lru.get(id);
    if (cached) {
      return { ok: true, file: cached };
    }

    // 2. Gộp request trùng theo id
    let promise = this.inFlight.get(id);
    if (promise) {
      return await promise;
    }

    promise = (async (): Promise<FetchOneResult> => {
      const fetchRes = await this.deps.fetchText(id);
      if (!fetchRes.ok) {
        return { ok: false, reason: fetchRes.reason };
      }

      const count = this.deps.parseCount(fetchRes.text);
      if (count === 0) {
        return { ok: false, reason: "bad_format" };
      }

      const file: SidecarFile = { name, text: fetchRes.text };
      this.lru.set(id, file);
      return { ok: true, file };
    })();

    this.inFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Xử lý yêu cầu tìm và tải phụ đề sidecar cho video trên Google Drive:
   * Tuân thủ các bước trong Phase D3 và E3.
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
    //    Dữ liệu từ content script không đáng tin: indexed không phải số → 0.
    const indexed =
      typeof lookupRes.indexed === "number" &&
      Number.isFinite(lookupRes.indexed) &&
      lookupRes.indexed >= 0
        ? Math.floor(lookupRes.indexed)
        : 0;

    if (lookupRes.result === "none") {
      return { ok: false, reason: "no_match", indexed };
    }
    if (lookupRes.result === "ambiguous") {
      return { ok: false, reason: "ambiguous" };
    }

    // 6. Xử lý các mode: bilingual, pair, en, vi
    if (lookupRes.result === "bilingual") {
      if (!isValidRef(lookupRes.bi)) {
        return { ok: false, reason: "index_unavailable" };
      }
      const res = await this.fetchOne(lookupRes.bi.id, lookupRes.bi.name);
      if (!res.ok) {
        return { ok: false, reason: res.reason };
      }
      return {
        ok: true,
        mode: "bilingual",
        bi: res.file,
        fileName: res.file.name,
        text: res.file.text,
      };
    }

    if (lookupRes.result === "en" || lookupRes.result === "match") {
      const ref =
        lookupRes.result === "en"
          ? lookupRes.en
          : { id: (lookupRes as { id: string }).id, name: (lookupRes as { name: string }).name };
      if (!isValidRef(ref)) {
        return { ok: false, reason: "index_unavailable" };
      }
      const res = await this.fetchOne(ref.id, ref.name);
      if (!res.ok) {
        return { ok: false, reason: res.reason };
      }
      return {
        ok: true,
        mode: "en",
        en: res.file,
        fileName: res.file.name,
        text: res.file.text,
      };
    }

    if (lookupRes.result === "vi") {
      if (!isValidRef(lookupRes.vi)) {
        return { ok: false, reason: "index_unavailable" };
      }
      const res = await this.fetchOne(lookupRes.vi.id, lookupRes.vi.name);
      if (!res.ok) {
        return { ok: false, reason: res.reason };
      }
      return {
        ok: true,
        mode: "vi",
        vi: res.file,
        fileName: res.file.name,
        text: res.file.text,
      };
    }

    if (lookupRes.result === "pair") {
      const hasValidEn = isValidRef(lookupRes.en);
      const hasValidVi = isValidRef(lookupRes.vi);

      // Cả hai ref đều sai → index_unavailable
      if (!hasValidEn && !hasValidVi) {
        return { ok: false, reason: "index_unavailable" };
      }

      // Chỉ có EN hợp lệ → hạ cấp xuống tải EN
      if (hasValidEn && !hasValidVi) {
        const res = await this.fetchOne(lookupRes.en.id, lookupRes.en.name);
        if (!res.ok) {
          return { ok: false, reason: res.reason };
        }
        return {
          ok: true,
          mode: "en",
          en: res.file,
          fileName: res.file.name,
          text: res.file.text,
        };
      }

      // Chỉ có VI hợp lệ → hạ cấp xuống tải VI
      if (!hasValidEn && hasValidVi) {
        const res = await this.fetchOne(lookupRes.vi.id, lookupRes.vi.name);
        if (!res.ok) {
          return { ok: false, reason: res.reason };
        }
        return {
          ok: true,
          mode: "vi",
          vi: res.file,
          fileName: res.file.name,
          text: res.file.text,
        };
      }

      // Cả EN và VI đều hợp lệ → tải SONG SONG (Promise.all)
      const [enRes, viRes] = await Promise.all([
        this.fetchOne(lookupRes.en.id, lookupRes.en.name),
        this.fetchOne(lookupRes.vi.id, lookupRes.vi.name),
      ]);

      // Áp dụng quy tắc hạ cấp §3:
      if (enRes.ok && viRes.ok) {
        return {
          ok: true,
          mode: "pair",
          en: enRes.file,
          vi: viRes.file,
          fileName: enRes.file.name,
          text: enRes.file.text,
        };
      } else if (enRes.ok) {
        return {
          ok: true,
          mode: "en",
          en: enRes.file,
          fileName: enRes.file.name,
          text: enRes.file.text,
        };
      } else if (viRes.ok) {
        return {
          ok: true,
          mode: "vi",
          vi: viRes.file,
          fileName: viRes.file.name,
          text: viRes.file.text,
        };
      } else {
        // Cả hai lỗi → trả reason của file en
        return { ok: false, reason: enRes.reason };
      }
    }

    // Result không xác định → index_unavailable
    return { ok: false, reason: "index_unavailable" };
  }
}
