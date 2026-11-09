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
        result: "en",
        en: { id: validId, name: validName },
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
      result: "en",
      en: { id: "bad id with spaces!", name: "valid.srt" },
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
      result: "en",
      en: { id: validId, name: "   " },
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
    expect(firstRes).toEqual({
      ok: true,
      mode: "en",
      en: { name: validName, text: validSubtitleText },
    });
    expect(deps.fetchText).toHaveBeenCalledTimes(1);

    // Lần 2: cùng id phụ đề → lấy từ LRU
    const secondRes = await service.handle(validSender);
    expect(secondRes).toEqual({
      ok: true,
      mode: "en",
      en: { name: validName, text: validSubtitleText },
    });
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
    expect(res1).toEqual({
      ok: true,
      mode: "en",
      en: { name: validName, text: validSubtitleText },
    });
    expect(res2).toEqual({
      ok: true,
      mode: "en",
      en: { name: validName, text: validSubtitleText },
    });
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
    expect(res2).toEqual({
      ok: true,
      mode: "en",
      en: { name: validName, text: validSubtitleText },
    });
    expect(deps.fetchText).toHaveBeenCalledTimes(2);
  });

  // Bước 11: Thành công → lưu LRU và trả { ok: true, mode, en }
  it("Bước 11: thành công → trả đúng dữ liệu và lưu LRU", async () => {
    const service = new DriveSidecarService(deps);
    const res = await service.handle(validSender);
    expect(res).toEqual({
      ok: true,
      mode: "en",
      en: { name: validName, text: validSubtitleText },
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
              result: "en",
              en: { id: "abc1234567890_id", name: "video.srt" },
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

describe("DriveSidecarService - Phase 9.6 E3: chế độ pair, song song, và hạ cấp", () => {
  const validSender: chrome.runtime.MessageSender = {
    tab: {
      id: 42,
      url: "https://drive.google.com/drive/folders/folder_123456789",
    } as never,
  };

  const enId = "en_file_id_12345678901234";
  const enName = "001 Intro_en.srt";
  const enText = "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello\r\n";

  const viId = "vi_file_id_12345678901234";
  const viName = "001 Intro_vi.srt";
  const viText = "1\r\n00:00:00,000 --> 00:00:01,000\r\nXin chào\r\n";

  it("1. Lookup pair → fetchText được gọi 2 lần đồng thời (cả hai promise đã bắt đầu trước khi cái đầu tiên xong)", async () => {
    let resolveEn!: (val: { ok: true; text: string }) => void;
    let resolveVi!: (val: { ok: true; text: string }) => void;

    const fetchTextMock = vi.fn(async (id: string) => {
      if (id === enId) {
        return new Promise<{ ok: true; text: string }>((r) => {
          resolveEn = r;
        });
      }
      return new Promise<{ ok: true; text: string }>((r) => {
        resolveVi = r;
      });
    });

    const service = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: enId, name: enName },
        vi: { id: viId, name: viName },
      }),
      fetchText: fetchTextMock,
      parseCount: () => 1,
    });

    const handlePromise = service.handle(validSender);

    // Chờ microtasks để cả hai request fetchText được kích hoạt
    await new Promise((r) => setTimeout(r, 0));

    // CẢ HAI request đều đã được gọi ĐỒNG THỜI trước khi cái nào xong
    expect(fetchTextMock).toHaveBeenCalledTimes(2);
    expect(fetchTextMock).toHaveBeenCalledWith(enId);
    expect(fetchTextMock).toHaveBeenCalledWith(viId);

    // Giải quyết
    resolveEn({ ok: true, text: enText });
    resolveVi({ ok: true, text: viText });

    const res = await handlePromise;
    expect(res).toEqual({
      ok: true,
      mode: "pair",
      en: { name: enName, text: enText },
      vi: { name: viName, text: viText },
    });
  });

  it("2. pair mà vi lỗi → mode: 'en'; en lỗi → mode: 'vi'; cả hai lỗi → reason của en", async () => {
    // 2a. vi lỗi (not_found), en OK → mode "en"
    const serviceViErr = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: enId, name: enName },
        vi: { id: viId, name: viName },
      }),
      fetchText: async (id: string) => {
        if (id === enId) return { ok: true as const, text: enText };
        return { ok: false as const, reason: "not_found" as const };
      },
      parseCount: () => 1,
    });
    const resViErr = await serviceViErr.handle(validSender);
    expect(resViErr).toEqual({
      ok: true,
      mode: "en",
      en: { name: enName, text: enText },
    });

    // 2b. en lỗi (too_large), vi OK → mode "vi"
    const serviceEnErr = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: enId, name: enName },
        vi: { id: viId, name: viName },
      }),
      fetchText: async (id: string) => {
        if (id === enId) return { ok: false as const, reason: "too_large" as const };
        return { ok: true as const, text: viText };
      },
      parseCount: () => 1,
    });
    const resEnErr = await serviceEnErr.handle(validSender);
    expect(resEnErr).toEqual({
      ok: true,
      mode: "vi",
      vi: { name: viName, text: viText },
    });

    // 2c. Cả hai lỗi → trả reason của en
    const serviceBothErr = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: enId, name: enName },
        vi: { id: viId, name: viName },
      }),
      fetchText: async (id: string) => {
        if (id === enId) return { ok: false as const, reason: "not_found" as const };
        return { ok: false as const, reason: "timeout" as const };
      },
      parseCount: () => 1,
    });
    const resBothErr = await serviceBothErr.handle(validSender);
    expect(resBothErr).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("3. pair mà vi parse 0 câu → mode: 'en'", async () => {
    const service = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: enId, name: enName },
        vi: { id: viId, name: viName },
      }),
      fetchText: async (id: string) => {
        if (id === enId) return { ok: true as const, text: enText };
        return { ok: true as const, text: "invalid vi subtitle" };
      },
      parseCount: (text) => (text.includes("invalid") ? 0 : 1),
    });
    const res = await service.handle(validSender);
    expect(res).toEqual({
      ok: true,
      mode: "en",
      en: { name: enName, text: enText },
    });
  });

  it("4. Lookup vi → mode: 'vi', chỉ tải 1 file", async () => {
    const fetchTextMock = vi.fn(async () => ({ ok: true as const, text: viText }));
    const service = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "vi",
        vi: { id: viId, name: viName },
      }),
      fetchText: fetchTextMock,
      parseCount: () => 1,
    });
    const res = await service.handle(validSender);
    expect(res).toEqual({
      ok: true,
      mode: "vi",
      vi: { name: viName, text: viText },
    });
    expect(fetchTextMock).toHaveBeenCalledTimes(1);
    expect(fetchTextMock).toHaveBeenCalledWith(viId);
  });

  it("5. Ref có id sai → bị bỏ; cả hai sai → index_unavailable", async () => {
    // 5a. vi có id sai regex → bỏ vi, chỉ tải en → mode: "en"
    const fetchMock = vi.fn(async () => ({ ok: true as const, text: enText }));
    const serviceBadVi = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: enId, name: enName },
        vi: { id: "bad id with space!", name: viName },
      }),
      fetchText: fetchMock,
      parseCount: () => 1,
    });
    const resBadVi = await serviceBadVi.handle(validSender);
    expect(resBadVi).toEqual({
      ok: true,
      mode: "en",
      en: { name: enName, text: enText },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(enId);

    // 5b. en có id sai regex → bỏ en, chỉ tải vi → mode: "vi"
    const fetchMockVi = vi.fn(async () => ({ ok: true as const, text: viText }));
    const serviceBadEn = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: "short", name: enName },
        vi: { id: viId, name: viName },
      }),
      fetchText: fetchMockVi,
      parseCount: () => 1,
    });
    const resBadEn = await serviceBadEn.handle(validSender);
    expect(resBadEn).toEqual({
      ok: true,
      mode: "vi",
      vi: { name: viName, text: viText },
    });
    expect(fetchMockVi).toHaveBeenCalledTimes(1);
    expect(fetchMockVi).toHaveBeenCalledWith(viId);

    // 5c. Cả hai ref đều sai → index_unavailable và không fetch
    const fetchMockNone = vi.fn();
    const serviceBadBoth = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: "invalid en id", name: enName },
        vi: { id: "invalid vi id", name: viName },
      }),
      fetchText: fetchMockNone,
    });
    const resBadBoth = await serviceBadBoth.handle(validSender);
    expect(resBadBoth).toEqual({
      ok: false,
      reason: "index_unavailable",
    });
    expect(fetchMockNone).not.toHaveBeenCalled();
  });

  it("6. LRU hit cho file en vẫn tải vi", async () => {
    const fetchMock = vi.fn(async (id: string) => {
      if (id === enId) return { ok: true as const, text: enText };
      return { ok: true as const, text: viText };
    });

    const service = new DriveSidecarService({
      lookup: async (_tab, req) => {
        if (req.videoDocId === "video_doc_id_001") {
          return {
            ok: true,
            indexed: 5,
            result: "en",
            en: { id: enId, name: enName },
          };
        }
        return {
          ok: true,
          indexed: 5,
          result: "pair",
          en: { id: enId, name: enName },
          vi: { id: viId, name: viName },
        };
      },
      fetchText: fetchMock,
      parseCount: () => 1,
    });

    // Lần 1: tải en (lưu enId vào LRU)
    const res1 = await service.handle(validSender, "video_doc_id_001");
    expect(res1.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(enId);

    // Lần 2: lookup pair (enId đã có trong LRU, viId chưa có)
    const res2 = await service.handle(validSender, "video_doc_id_002");
    expect(res2).toEqual({
      ok: true,
      mode: "pair",
      en: { name: enName, text: enText },
      vi: { name: viName, text: viText },
    });
    // fetchText chỉ được gọi thêm đúng 1 lần cho viId
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(viId);
  });

  it("7. Hai request pair đồng thời cùng id → mỗi id chỉ tải 1 lần", async () => {
    let resolveEn!: (val: { ok: true; text: string }) => void;
    let resolveVi!: (val: { ok: true; text: string }) => void;

    const fetchMock = vi.fn(async (id: string) => {
      if (id === enId) {
        return new Promise<{ ok: true; text: string }>((r) => {
          resolveEn = r;
        });
      }
      return new Promise<{ ok: true; text: string }>((r) => {
        resolveVi = r;
      });
    });

    const service = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 10,
        result: "pair",
        en: { id: enId, name: enName },
        vi: { id: viId, name: viName },
      }),
      fetchText: fetchMock,
      parseCount: () => 1,
    });

    const p1 = service.handle(validSender);
    const p2 = service.handle(validSender);

    await new Promise((r) => setTimeout(r, 0));

    // Mỗi id chỉ được fetch đúng 1 lần
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveEn({ ok: true, text: enText });
    resolveVi({ ok: true, text: viText });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({
      ok: true,
      mode: "pair",
      en: { name: enName, text: enText },
      vi: { name: viName, text: viText },
    });
    expect(r2).toEqual(r1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Lookup bilingual → mode: 'bilingual'", async () => {
    const biId = "bi_file_id_12345678901234";
    const biName = "001 Intro_bilingual.srt";
    const biText = "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello\r\nXin chào\r\n";

    const service = new DriveSidecarService({
      lookup: async () => ({
        ok: true,
        indexed: 5,
        result: "bilingual",
        bi: { id: biId, name: biName },
      }),
      fetchText: async () => ({ ok: true as const, text: biText }),
      parseCount: () => 1,
    });

    const res = await service.handle(validSender);
    expect(res).toEqual({
      ok: true,
      mode: "bilingual",
      bi: { name: biName, text: biText },
    });
  });
});
