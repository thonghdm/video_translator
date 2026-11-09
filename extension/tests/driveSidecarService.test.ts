import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DriveSidecarService,
  type SidecarDeps,
} from "../src/background/drive/sidecarService";
import type { DriveLookupReq, DriveLookupRes } from "../src/shared/driveTypes";

describe("DriveSidecarService", () => {
  const validSender: chrome.runtime.MessageSender = {
    tab: {
      id: 42,
      url: "https://drive.google.com/drive/folders/folder_123456789",
      index: 0,
      pinned: false,
      highlighted: false,
      windowId: 1,
      active: true,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: false,
      groupId: -1,
    },
  };

  const validId = "sub_file_id_12345678901234";
  const validName = "001 Intro_en.srt";
  const validSubtitleText = "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello world\r\n";

  let deps: SidecarDeps;

  beforeEach(() => {
    deps = {
      isEnabled: vi.fn(() => true),
      lookup: vi.fn(async (): Promise<DriveLookupRes> => ({
        ok: true,
        indexed: 10,
        result: "match",
        id: validId,
        name: validName,
      })),
      fetchText: vi.fn(async () => ({
        ok: true as const,
        text: validSubtitleText,
      })),
      parseCount: vi.fn(() => 1),
    };
  });

  // Bước 1: !isEnabled() → disabled
  it("Bước 1: khi tắt (isEnabled = false) → trả disabled", async () => {
    deps.isEnabled = () => false;
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({ ok: false, reason: "disabled" });
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  // Bước 2: Thiếu sender / tab / url hoặc hostname không phải drive.google.com → not_drive
  it("Bước 2: thiếu sender, tab, hoặc url → trả not_drive", async () => {
    const service = new DriveSidecarService(deps);

    expect(await service.handle(undefined)).toEqual({ ok: false, reason: "not_drive" });
    expect(await service.handle({})).toEqual({ ok: false, reason: "not_drive" });
    expect(await service.handle({ tab: { id: 42 } as never })).toEqual({
      ok: false,
      reason: "not_drive",
    });
    expect(
      await service.handle({ tab: { id: 0, url: "https://drive.google.com" } as never })
    ).toEqual({ ok: false, reason: "not_drive" });
  });

  it("Bước 2: tab host lạ (evil.com) → trả not_drive và không gọi lookup", async () => {
    const service = new DriveSidecarService(deps);
    const evilSender: chrome.runtime.MessageSender = {
      tab: { id: 99, url: "https://evil.com/drive" } as never,
    };
    const res = await service.handle(evilSender);
    expect(res).toEqual({ ok: false, reason: "not_drive" });
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  // Bước 3: videoDocId sai regex → coi như không có (không báo lỗi)
  it("Bước 3: videoDocId sai regex → coi như undefined khi gọi lookup", async () => {
    const service = new DriveSidecarService(deps);
    await service.handle(validSender, "invalid/doc/id!");
    expect(deps.lookup).toHaveBeenCalledWith(42, {
      type: "drive.lookup",
      videoDocId: undefined,
    });

    const validDocId = "video_doc_id_123456789";
    await service.handle(validSender, validDocId);
    expect(deps.lookup).toHaveBeenCalledWith(42, {
      type: "drive.lookup",
      videoDocId: validDocId,
    });
  });

  // Bước 4: lookup ném lỗi, quá timeout, hoặc {ok:false} → index_unavailable
  it("Bước 4: lookup ném lỗi (vd: Receiving end does not exist) → index_unavailable", async () => {
    deps.lookup = vi.fn(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({ ok: false, reason: "index_unavailable" });
  });

  it("Bước 4: lookup trả { ok: false } → index_unavailable", async () => {
    deps.lookup = vi.fn(async (): Promise<DriveLookupRes> => ({ ok: false }));
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({ ok: false, reason: "index_unavailable" });
  });

  // Bước 5: result === "none" → no_match (kèm indexed); "ambiguous" → ambiguous
  it("Bước 5: lookup trả result 'none' → trả no_match kèm số lượng indexed", async () => {
    deps.lookup = vi.fn(async (): Promise<DriveLookupRes> => ({
      ok: true,
      indexed: 45,
      result: "none",
    }));
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({ ok: false, reason: "no_match", indexed: 45 });
    expect(deps.fetchText).not.toHaveBeenCalled();
  });

  it("Bước 5: lookup trả result 'ambiguous' → trả ambiguous", async () => {
    deps.lookup = vi.fn(async (): Promise<DriveLookupRes> => ({
      ok: true,
      indexed: 30,
      result: "ambiguous",
    }));
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({ ok: false, reason: "ambiguous" });
    expect(deps.fetchText).not.toHaveBeenCalled();
  });

  // Bước 6: id từ lookup sai regex hoặc name rỗng → index_unavailable
  it("Bước 6: lookup trả id sai regex → index_unavailable và không fetch", async () => {
    deps.lookup = vi.fn(async (): Promise<DriveLookupRes> => ({
      ok: true,
      indexed: 10,
      result: "match",
      id: "bad id with spaces!",
      name: "valid.srt",
    }));
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({ ok: false, reason: "index_unavailable" });
    expect(deps.fetchText).not.toHaveBeenCalled();
  });

  it("Bước 6: lookup trả name rỗng hoặc chỉ có khoảng trắng → index_unavailable", async () => {
    deps.lookup = vi.fn(async (): Promise<DriveLookupRes> => ({
      ok: true,
      indexed: 10,
      result: "match",
      id: validId,
      name: "   ",
    }));
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({ ok: false, reason: "index_unavailable" });
    expect(deps.fetchText).not.toHaveBeenCalled();
  });

  // Bước 7: LRU cache hit → trả ngay, không fetch lại
  it("Bước 7: LRU hit → trả ngay từ cache, fetchText không được gọi lại", async () => {
    const service = new DriveSidecarService(deps);

    // Lần 1: fetch thành công và lưu vào LRU
    const firstRes = await service.handle(validSender);
    expect(firstRes).toEqual({ ok: true, fileName: validName, text: validSubtitleText });
    expect(deps.fetchText).toHaveBeenCalledTimes(1);

    // Lần 2: cùng id phụ đề → lấy từ LRU
    const secondRes = await service.handle(validSender);
    expect(secondRes).toEqual({ ok: true, fileName: validName, text: validSubtitleText });
    expect(deps.fetchText).toHaveBeenCalledTimes(1); // vẫn chỉ 1 lần
  });

  // Bước 8: Gộp request trùng theo khóa id
  it("Bước 8: 2 lần handle đồng thời cùng id → fetchText chỉ được gọi đúng 1 lần", async () => {
    let resolveFetch!: (val: { ok: true; text: string }) => void;
    deps.fetchText = vi.fn(
      async () =>
        new Promise<{ ok: true; text: string }>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const service = new DriveSidecarService(deps);

    const promise1 = service.handle(validSender);
    const promise2 = service.handle(validSender);

    // Chờ microtasks để cả hai request hoàn thành lookup và tiến tới fetchText
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.fetchText).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, text: validSubtitleText });

    const [res1, res2] = await Promise.all([promise1, promise2]);
    expect(res1).toEqual({ ok: true, fileName: validName, text: validSubtitleText });
    expect(res2).toEqual({ ok: true, fileName: validName, text: validSubtitleText });
    expect(deps.fetchText).toHaveBeenCalledTimes(1);
  });

  // Bước 9: fetchText lỗi → trả reason tương ứng
  it("Bước 9: fetchText trả lỗi (not_found, too_large, etc.) → trả đúng reason", async () => {
    deps.fetchText = vi.fn(async () => ({ ok: false as const, reason: "not_found" as const }));
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({ ok: false, reason: "not_found" });

    deps.fetchText = vi.fn(async () => ({ ok: false as const, reason: "too_large" as const }));
    const service2 = new DriveSidecarService(deps);
    const res2 = await service2.handle(validSender);
    expect(res2).toEqual({ ok: false, reason: "too_large" });
  });

  // Bước 10: parseCount(text) === 0 → bad_format (không lưu vào LRU)
  it("Bước 10: parseCount(text) === 0 → trả bad_format và không lưu vào LRU", async () => {
    let mockCount = 0;
    const service = new DriveSidecarService({
      ...deps,
      parseCount: () => mockCount,
    });

    const res1 = await service.handle(validSender);
    expect(res1).toEqual({ ok: false, reason: "bad_format" });
    expect(deps.fetchText).toHaveBeenCalledTimes(1);

    // Gọi lại lần 2 → nếu đã bị cache thì fetchText không chạy; vì không cache nên fetchText được gọi lại
    mockCount = 1;
    const res2 = await service.handle(validSender);
    expect(res2).toEqual({ ok: true, fileName: validName, text: validSubtitleText });
    expect(deps.fetchText).toHaveBeenCalledTimes(2);
  });

  // Bước 11: Thành công → lưu LRU và trả { ok: true, fileName, text }
  it("Bước 11: thành công → trả đúng dữ liệu và lưu LRU", async () => {
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({
      ok: true,
      fileName: validName,
      text: validSubtitleText,
    });
  });
});

describe("DriveSidecarService - default lookup & integration", () => {
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    vi.useRealTimers();
  });

  it("lookup mặc định gọi chrome.tabs.sendMessage với { frameId: 0 }", async () => {
    let capturedTabId = -1;
    let capturedReq: unknown = null;
    let capturedOptions: unknown = null;

    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: {
        sendMessage: vi.fn(
          (
            tabId: number,
            req: DriveLookupReq,
            options: { frameId?: number },
            callback?: (res: unknown) => void
          ) => {
            capturedTabId = tabId;
            capturedReq = req;
            capturedOptions = options;
            callback?.({
              ok: true,
              indexed: 5,
              result: "match",
              id: "abc1234567890_id",
              name: "video.srt",
            });
          }
        ),
      },
      runtime: {},
    };

    const service = new DriveSidecarService({
      fetchText: vi.fn(async () => ({ ok: true as const, text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nhi" })),
      parseCount: () => 1,
    });

    const sender: chrome.runtime.MessageSender = {
      tab: { id: 77, url: "https://drive.google.com/test" } as never,
    };
    const res = await service.handle(sender);
    expect(res.ok).toBe(true);
    expect(capturedTabId).toBe(77);
    expect(capturedReq).toEqual({ type: "drive.lookup", videoDocId: undefined });
    expect(capturedOptions).toEqual({ frameId: 0 });
  });

  it("lookup mặc định xử lý khi chrome.tabs.sendMessage báo runtime.lastError (Receiving end does not exist)", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: {
        sendMessage: vi.fn(
          (
            _tabId: number,
            _req: unknown,
            _options: unknown,
            callback?: (res: unknown) => void
          ) => {
            (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome.runtime.lastError = {
              message: "Could not establish connection. Receiving end does not exist.",
            };
            callback?.(undefined);
          }
        ),
      },
      runtime: {},
    };

    const service = new DriveSidecarService();
    const sender: chrome.runtime.MessageSender = {
      tab: { id: 88, url: "https://drive.google.com/test" } as never,
    };
    const res = await service.handle(sender);
    expect(res).toEqual({ ok: false, reason: "index_unavailable" });
  });

  it("lookup mặc định timeout sau 1.5s → index_unavailable", async () => {
    vi.useFakeTimers();

    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: {
        sendMessage: vi.fn(
          (
            _tabId: number,
            _req: unknown,
            _options: unknown,
            _callback?: (res: unknown) => void
          ) => {
            // Không bao giờ gọi callback (treo)
          }
        ),
      },
      runtime: {},
    };

    const service = new DriveSidecarService();
    const sender: chrome.runtime.MessageSender = {
      tab: { id: 99, url: "https://drive.google.com/test" } as never,
    };

    const promise = service.handle(sender);
    vi.advanceTimersByTime(1600);
    const res = await promise;
    expect(res).toEqual({ ok: false, reason: "index_unavailable" });
  });
  it("Review D3: lookup trả dữ liệu lạ (result không hợp lệ / indexed không phải số) → không tin", async () => {
    const tab = { tab: { id: 3, url: "https://drive.google.com/drive/folders/abc" } } as chrome.runtime.MessageSender;
    const fetchText = vi.fn();
    const bad = new DriveSidecarService({
      lookup: async () => ({ ok: true, indexed: 5, result: "weird" }) as never,
      fetchText,
    });
    expect(await bad.handle(tab)).toEqual({ ok: false, reason: "index_unavailable" });
    expect(fetchText).not.toHaveBeenCalled();

    const badIndexed = new DriveSidecarService({
      lookup: async () => ({ ok: true, indexed: "x", result: "none" }) as never,
    });
    expect(await badIndexed.handle(tab)).toEqual({ ok: false, reason: "no_match", indexed: 0 });
  });
});
