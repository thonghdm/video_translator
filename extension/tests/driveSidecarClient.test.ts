import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { act } from "react";
import {
  requestSidecar,
  defaultSleep,
  type SidecarClientDeps,
  SIDECAR_RETRY_DELAY_MS,
  SIDECAR_TOTAL_TIMEOUT_MS,
} from "../src/content/drive/sidecarClient";
import { ContentController } from "../src/content/index";
import type { C2B } from "../src/shared/messages";
import type { SidecarFailReason } from "../src/shared/driveTypes";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// ============================================================================
// Phần 1: 7 tests cho requestSidecar
// ============================================================================
describe("requestSidecar (sidecarClient.ts)", () => {
  let deps: SidecarClientDeps;
  let reqCount = 0;
  let requestsSent: Extract<C2B, { type: "drive.sidecar" }>[] = [];

  beforeEach(() => {
    reqCount = 0;
    requestsSent = [];
    deps = {
      request: vi.fn<SidecarClientDeps["request"]>(async (msg) => {
        requestsSent.push(msg);
        return {
          type: "drive.sidecar.result" as const,
          reqId: msg.reqId,
          ok: true as const,
          fileName: "001 Intro_en.srt",
          text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello\r\n",
        };
      }),
      sleep: vi.fn(async () => {}),
      newReqId: () => `req_${++reqCount}`,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. ok lần đầu (1 request)
  it("1. ok lần đầu → trả về kết quả, chỉ gửi 1 request", async () => {
    const controller = new AbortController();
    const res = await requestSidecar("video123", deps, controller.signal);

    expect(res).toEqual({
      ok: true,
      fileName: "001 Intro_en.srt",
      text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello\r\n",
    });
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  // 2. index_unavailable rồi ok (2 request, reqId khác nhau)
  it("2. index_unavailable lần 1 rồi ok lần 2 → gửi 2 request với reqId khác nhau", async () => {
    const controller = new AbortController();
    deps.request = vi.fn()
      .mockResolvedValueOnce({
        type: "drive.sidecar.result",
        reqId: "req_1",
        ok: false,
        reason: "index_unavailable",
      })
      .mockResolvedValueOnce({
        type: "drive.sidecar.result",
        reqId: "req_2",
        ok: true,
        fileName: "retry_ok.srt",
        text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nSuccess\r\n",
      });

    const res = await requestSidecar("video123", deps, controller.signal);

    expect(res).toEqual({
      ok: true,
      fileName: "retry_ok.srt",
      text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nSuccess\r\n",
    });
    expect(deps.request).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(SIDECAR_RETRY_DELAY_MS, controller.signal);

    // Kiểm tra reqId của 2 lần gửi khác nhau
    const req1 = vi.mocked(deps.request).mock.calls[0][0];
    const req2 = vi.mocked(deps.request).mock.calls[1][0];
    expect(req1.reqId).not.toBe(req2.reqId);
  });

  // 3. index_unavailable × 2 → fail, đúng 2 request
  it("3. index_unavailable cả 2 lần → trả về fail, đúng 2 request", async () => {
    const controller = new AbortController();
    deps.request = vi.fn().mockResolvedValue({
      type: "drive.sidecar.result",
      reqId: "req_x",
      ok: false,
      reason: "index_unavailable",
    });

    const res = await requestSidecar("video123", deps, controller.signal);

    expect(res).toEqual({
      ok: false,
      reason: "index_unavailable",
    });
    expect(deps.request).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  // 4. no_match với indexed > 0 → 1 request (không retry)
  it("4. no_match với indexed > 0 → không retry, chỉ 1 request", async () => {
    const controller = new AbortController();
    deps.request = vi.fn().mockResolvedValueOnce({
      type: "drive.sidecar.result",
      reqId: "req_1",
      ok: false,
      reason: "no_match",
      indexed: 15,
    });

    const res = await requestSidecar("video123", deps, controller.signal);

    expect(res).toEqual({
      ok: false,
      reason: "no_match",
    });
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  // 5. Abort trong lúc sleep → reject, không có request thứ 2
  it("5. Abort trong lúc sleep → reject AbortError, không có request thứ 2", async () => {
    const controller = new AbortController();
    deps.request = vi.fn().mockResolvedValueOnce({
      type: "drive.sidecar.result",
      reqId: "req_1",
      ok: false,
      reason: "index_unavailable",
    });

    deps.sleep = vi.fn(async (_ms, signal) => {
      return new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const promise = requestSidecar("video123", deps, controller.signal);
    await new Promise((r) => setTimeout(r, 0));

    // Abort khi đang sleep
    controller.abort();

    await expect(promise).rejects.toThrow("Aborted");
    expect(deps.request).toHaveBeenCalledTimes(1);
  });

  // 6. Quá 12 s (fake timers) → timeout
  it("6. Quá 12s → trả về timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    // Request bị treo không trả lời
    deps.request = vi.fn<SidecarClientDeps["request"]>(() => new Promise(() => {}));

    const promise = requestSidecar("video123", deps, controller.signal);
    vi.advanceTimersByTime(SIDECAR_TOTAL_TIMEOUT_MS + 100);

    const res = await promise;
    expect(res).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  // 7. request ném lỗi → network
  it("7. request ném lỗi (port đóng/ngắt) → trả về network", async () => {
    const controller = new AbortController();
    deps.request = vi.fn().mockRejectedValue(new Error("Port closed"));

    const res = await requestSidecar("video123", deps, controller.signal);
    expect(res).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("defaultSleep hoạt động với fake timers và reject khi abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const p = defaultSleep(1000, controller.signal);
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();

    const c2 = new AbortController();
    c2.abort();
    await expect(defaultSleep(1000, c2.signal)).rejects.toThrow("Aborted");
  });
});

// ============================================================================
// Phần 2: 13 tests cho ContentController integration
// ============================================================================
describe("ContentController — Tích hợp Sidecar Drive", () => {
  let mockPort: {
    postMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: (fn: (m: unknown) => void) => void };
    onDisconnect: { addListener: (fn: () => void) => void };
    disconnect: ReturnType<typeof vi.fn>;
  };
  let messageCallback: ((m: unknown) => void) | null = null;
  let onPopupMessageCallback: ((m: unknown, s: unknown, r: (res: unknown) => void) => void) | null = null;
  let connectCount = 0;
  let storageData: Record<string, unknown> = {};

  function setupFakeEnvironment(isDrive = true, autoSidecar = true) {
    connectCount = 0;
    messageCallback = null;
    onPopupMessageCallback = null;
    storageData = {
      settings: {
        mode: "google",
        subtitleMode: "bilingual",
        drive: { autoSidecar },
        youtube: { hideNativeCaptions: false },
        shortcuts: { enabled: true },
      },
    };

    mockPort = {
      postMessage: vi.fn(),
      onMessage: {
        addListener: (fn) => {
          messageCallback = fn;
        },
      },
      onDisconnect: { addListener: vi.fn() },
      disconnect: vi.fn(),
    };

    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: "mock_ext",
        connect: vi.fn(() => {
          connectCount++;
          return mockPort;
        }),
        onMessage: {
          addListener: vi.fn((fn) => {
            onPopupMessageCallback = fn;
          }),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn(async (key: string | string[]) => {
            if (typeof key === "string") {
              return { [key]: storageData[key] };
            }
            return storageData;
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(storageData, obj);
          }),
          remove: vi.fn(),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    };

    if (isDrive) {
      // Giả lập iframe player trên Google Drive
      Object.defineProperty(window, "top", {
        value: {}, // khác window → không phải top frame
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window.location, "ancestorOrigins", {
        value: {
          contains: (origin: string) => origin === "https://drive.google.com",
          length: 1,
          [0]: "https://drive.google.com",
        },
        configurable: true,
        writable: true,
      });
    } else {
      // Trang thường (ví dụ YouTube / localhost)
      Object.defineProperty(window, "top", {
        value: window,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window.location, "ancestorOrigins", {
        value: {
          contains: () => false,
          length: 0,
        },
        configurable: true,
        writable: true,
      });
    }
    if (!window.URL.createObjectURL) {
      window.URL.createObjectURL = vi.fn(() => "blob:mock-object-url");
    }
    if (!window.URL.revokeObjectURL) {
      window.URL.revokeObjectURL = vi.fn();
    }
  }

  function makeVideo(): HTMLVideoElement {
    const v = document.createElement("video");
    v.src = "blob:test-video";
    Object.defineProperty(v, "paused", { value: true, configurable: true });
    Object.defineProperty(v, "currentTime", { value: 1, writable: true, configurable: true });
    v.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0, toJSON() {} }) as DOMRect;
    document.body.appendChild(v);
    return v;
  }

  afterEach(() => {
    document.body.innerHTML = "";
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    window.history.replaceState({}, "", "/");
    vi.useRealTimers();
  });

  // 1. listSources rỗng + sidecar ok → session trackKey bắt đầu bằng file:, toast "Đã tự nhận phụ đề: …", sessionOrigin === "sidecar"
  it("1. listSources rỗng + sidecar ok → session trackKey bắt đầu bằng file:, có toast OK, sessionOrigin === 'sidecar'", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "drive.sidecar" })
    );

    // Trả lời kết quả sidecar thành công
    const lastMsg = mockPort.postMessage.mock.calls[0][0] as { reqId: string };
    const srtText = "1\r\n00:00:00,000 --> 00:00:02,000\r\nHello Drive\r\n";
    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: lastMsg.reqId,
        ok: true,
        fileName: "Lesson01_en.srt",
        text: srtText,
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(controller.getSessionOrigin()).toBe("sidecar");
    const session = controller.getSession();
    expect(session).not.toBeNull();
    expect(session?.track.trackKey).toMatch(/^file:/);
    expect(controller.getStore()?.getState().toast).toBe("Đã tự nhận phụ đề: Lesson01_en.srt");

    controller.dispose();
  });

  // 2. Adapter ra nguồn trước, sidecar ok sau → session thay bằng sidecar; đúng 1 overlay host trong DOM
  it("2. Adapter ra nguồn trước, sidecar ok sau → session thay bằng sidecar, đúng 1 overlay", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    // Thêm track text để adapter HTML5 nhận diện trước
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.srclang = "en";
    track.src = "data:text/vtt,WEBVTT\n\n00:00.000 --> 00:02.000\nNative cue\n";
    v.appendChild(track);

    controller.onVideoForTest(v);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Sidecar phản hồi sau
    const sidecarCall = mockPort.postMessage.mock.calls.find((c) => c[0].type === "drive.sidecar");
    expect(sidecarCall).toBeDefined();

    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: sidecarCall![0].reqId,
        ok: true,
        fileName: "SidecarWins.srt",
        text: "1\r\n00:00:00,000 --> 00:00:02,000\r\nSidecar cue\r\n",
      });
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(controller.getSessionOrigin()).toBe("sidecar");
    expect(document.querySelectorAll("subtrans-overlay")).toHaveLength(1);

    controller.dispose();
  });

  // 3. Sidecar ok trước, rồi sự kiện playing làm adapter có nguồn → vẫn giữ sidecar
  it("3. Sidecar ok trước, sự kiện playing kích hoạt adapter → vẫn giữ sidecar", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    // Sidecar hoàn thành trước
    const lastMsg = mockPort.postMessage.mock.calls[0][0] as { reqId: string };
    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: lastMsg.reqId,
        ok: true,
        fileName: "First.srt",
        text: "1\r\n00:00:00,000 --> 00:00:02,000\r\nFirst\r\n",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(controller.getSessionOrigin()).toBe("sidecar");

    // Sự kiện playing kích hoạt trySetup
    v.dispatchEvent(new Event("playing"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Vẫn giữ sidecar, không bị đè bởi adapter
    expect(controller.getSessionOrigin()).toBe("sidecar");

    controller.dispose();
  });

  // 4. Bạn Nhập trước, sidecar ok sau → giữ bản Nhập
  it("4. Bạn Nhập trước, sidecar ok sau → giữ bản Nhập", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    // Người dùng bấm Nhập file thủ công
    const manualFile = new File(
      ["1\r\n00:00:00,000 --> 00:00:02,000\r\nManual\r\n"],
      "manual.srt",
      { type: "text/plain" }
    );
    await act(async () => {
      await controller.handleImportFileForTest(manualFile);
    });

    expect(controller.getSessionOrigin()).toBe("user");

    // Sidecar phản hồi sau đó
    const lastMsg = mockPort.postMessage.mock.calls.find((c) => c[0].type === "drive.sidecar");
    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: lastMsg![0].reqId,
        ok: true,
        fileName: "LateSidecar.srt",
        text: "1\r\n00:00:00,000 --> 00:00:02,000\r\nLate\r\n",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    // Vẫn giữ bản Nhập của user
    expect(controller.getSessionOrigin()).toBe("user");
    expect(controller.getStore()?.getState().trackTitle).toBe("manual");

    controller.dispose();
  });

  // 5. Sidecar đã nạp, bạn Nhập → thay; 1 overlay; sessionOrigin === "user"
  it("5. Sidecar đã nạp, bạn Nhập → thay thế; 1 overlay; sessionOrigin === 'user'", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    const lastMsg = mockPort.postMessage.mock.calls[0][0] as { reqId: string };
    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: lastMsg.reqId,
        ok: true,
        fileName: "InitialSidecar.srt",
        text: "1\r\n00:00:00,000 --> 00:00:02,000\r\nInitial\r\n",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(controller.getSessionOrigin()).toBe("sidecar");

    // Người dùng bấm Nhập file đè lên
    const manualFile = new File(
      ["1\r\n00:00:00,000 --> 00:00:02,000\r\nUser Override\r\n"],
      "override.srt",
      { type: "text/plain" }
    );
    await act(async () => {
      await controller.handleImportFileForTest(manualFile);
    });

    expect(controller.getSessionOrigin()).toBe("user");
    expect(document.querySelectorAll("subtrans-overlay")).toHaveLength(1);
    expect(controller.getStore()?.getState().trackTitle).toBe("override");

    controller.dispose();
  });

  // 6. Đổi video (tăng generation) trước khi có kết quả → kết quả bị bỏ, không toast
  it("6. Đổi video trước khi có kết quả → kết quả bị bỏ, không toast", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const v1 = makeVideo();
    controller.onVideoForTest(v1);

    const lastMsg = mockPort.postMessage.mock.calls[0][0] as { reqId: string };

    // Đổi sang video khác
    const v2 = makeVideo();
    controller.onVideoForTest(v2);

    // Kết quả của video cũ tới
    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: lastMsg.reqId,
        ok: true,
        fileName: "OldVideo.srt",
        text: "1\r\n00:00:00,000 --> 00:00:02,000\r\nOld\r\n",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    // Toast không phải của video cũ
    expect(controller.getStore()?.getState().toast).not.toBe("Đã tự nhận phụ đề: OldVideo.srt");

    controller.dispose();
  });

  // 7. onSourceChanged dựng lại → drive.sidecar chỉ gửi 1 lần (khi có docId)
  it("7. onSourceChanged dựng lại → drive.sidecar chỉ gửi 1 lần khi có docId (nhờ cache)", async () => {
    setupFakeEnvironment(true, true);
    // Giả lập URL có docId hợp lệ
    window.history.replaceState({}, "", "/preview?id=valid_video_doc_id_1234");

    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    expect(mockPort.postMessage).toHaveBeenCalledTimes(1);
    const lastMsg = mockPort.postMessage.mock.calls[0][0] as { reqId: string };

    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: lastMsg.reqId,
        ok: true,
        fileName: "Cached.srt",
        text: "1\r\n00:00:00,000 --> 00:00:02,000\r\nCached\r\n",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    // onSourceChanged gọi lại onVideo
    controller.onVideoForTest(v);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Không gửi thêm request drive.sidecar nào nữa vì đã cache theo docId
    const sidecarCalls = mockPort.postMessage.mock.calls.filter((c) => c[0].type === "drive.sidecar");
    expect(sidecarCalls).toHaveLength(1);

    controller.dispose();
  });

  // 8. autoSidecar = false → không mở port, không gửi gì
  it("8. autoSidecar = false → không mở port, không gửi drive.sidecar", async () => {
    setupFakeEnvironment(true, false); // autoSidecar = false
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    expect(connectCount).toBe(0);
    expect(mockPort.postMessage).not.toHaveBeenCalled();

    controller.dispose();
  });

  // 9. Frame không phải Drive (YouTube thường, trang <track>) → không gửi drive.sidecar
  it("9. Frame không phải Drive → không gửi drive.sidecar", async () => {
    setupFakeEnvironment(false, true); // not drive
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    expect(connectCount).toBe(0);
    expect(mockPort.postMessage).not.toHaveBeenCalled();

    controller.dispose();
  });

  // 10. Từng reason → đúng chữ toast ở §4; các reason "im lặng" → không toast
  it("10. Từng reason hiển thị đúng toast theo §4 và các reason im lặng không toast", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const cases: { reason: SidecarFailReason; expectedToast: string | null }[] = [
      { reason: "ambiguous", expectedToast: "Có nhiều file trùng tên – bấm Nhập để chọn" },
      { reason: "not_permitted", expectedToast: "Không có quyền tải phụ đề – bấm Nhập để chọn file" },
      { reason: "not_found", expectedToast: "Không tìm thấy file phụ đề – bấm Nhập" },
      { reason: "too_large", expectedToast: "File phụ đề quá lớn (> 1MB)" },
      { reason: "bad_format", expectedToast: "File phụ đề không hợp lệ – bấm Nhập" },
      { reason: "network", expectedToast: "Không tải được phụ đề (mạng) – bấm Nhập" },
      { reason: "timeout", expectedToast: "Không tải được phụ đề (mạng) – bấm Nhập" },
      { reason: "disabled", expectedToast: null },
      { reason: "not_drive", expectedToast: null },
      { reason: "index_unavailable", expectedToast: null },
      { reason: "no_match", expectedToast: null },
    ];

    for (const c of cases) {
      window.history.replaceState({}, "", `/preview?id=case_${c.reason}_12345678`);
      const v = makeVideo();
      controller.onVideoForTest(v);
      const calls = mockPort.postMessage.mock.calls;
      const lastMsg = calls[calls.length - 1][0] as { reqId: string };

      await act(async () => {
        messageCallback?.({
          type: "drive.sidecar.result",
          reqId: lastMsg.reqId,
          ok: false,
          reason: c.reason,
        });
        await new Promise((r) => setTimeout(r, 10));
      });

      if (c.expectedToast) {
        expect(controller.getStore()?.getState().toast).toBe(c.expectedToast);
      } else {
        expect(controller.getStore()?.getState().toast).toBeNull();
      }
    }

    controller.dispose();
  });

  // 11. network → không cache (lần onVideo sau gửi lại); no_match → cache (không gửi lại)
  it("11. network không cache (gửi lại lần sau); no_match cache (không gửi lại)", async () => {
    setupFakeEnvironment(true, true);
    window.history.replaceState({}, "", "/preview?id=key_test_1234567890");

    const controller = new ContentController();
    await controller.init();

    // 1. Thất bại vì network
    const v1 = makeVideo();
    controller.onVideoForTest(v1);
    const calls1 = mockPort.postMessage.mock.calls;
    const msg1 = calls1[calls1.length - 1][0] as { reqId: string };

    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: msg1.reqId,
        ok: false,
        reason: "network",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    const callsCount1 = mockPort.postMessage.mock.calls.filter((c) => c[0].type === "drive.sidecar").length;
    expect(callsCount1).toBe(1);

    // Gọi lại onVideo → network không cache nên GỬI LẠI
    controller.onVideoForTest(v1);
    const callsCount2 = mockPort.postMessage.mock.calls.filter((c) => c[0].type === "drive.sidecar").length;
    expect(callsCount2).toBe(2);

    // 2. Thất bại vì no_match
    const calls2 = mockPort.postMessage.mock.calls;
    const msg2 = calls2[calls2.length - 1][0] as { reqId: string };
    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: msg2.reqId,
        ok: false,
        reason: "no_match",
        indexed: 10,
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    // Gọi lại onVideo → no_match ĐÃ ĐƯỢC CACHE nên KHÔNG GỬI LẠI
    controller.onVideoForTest(v1);
    const callsCount3 = mockPort.postMessage.mock.calls.filter((c) => c[0].type === "drive.sidecar").length;
    expect(callsCount3).toBe(2); // vẫn là 2, không tăng

    controller.dispose();
  });

  // 12. deactivate() giữa chừng → không toast, không session
  it("12. deactivate() giữa chừng → không toast, không session", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    const lastMsg = mockPort.postMessage.mock.calls[0][0] as { reqId: string };

    // Tắt extension (deactivate) trong lúc request đang chờ
    controller.dispose();

    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: lastMsg.reqId,
        ok: true,
        fileName: "AfterDispose.srt",
        text: "1\r\n00:00:00,000 --> 00:00:02,000\r\nDead\r\n",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(controller.getSession()).toBeNull();
  });

  // 13. tab.status và tab.export hoạt động với session sidecar
  it("13. tab.status và tab.export hoạt động đúng với session sidecar", async () => {
    setupFakeEnvironment(true, true);
    const controller = new ContentController();
    await controller.init();

    const v = makeVideo();
    controller.onVideoForTest(v);

    const lastMsg = mockPort.postMessage.mock.calls[0][0] as { reqId: string };
    await act(async () => {
      messageCallback?.({
        type: "drive.sidecar.result",
        reqId: lastMsg.reqId,
        ok: true,
        fileName: "SidecarStatus.srt",
        text: "1\r\n00:00:00,000 --> 00:00:02,000\r\nStatus test\r\n",
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(onPopupMessageCallback).toBeDefined();

    // Test tab.status
    let statusResponse: any = null;
    onPopupMessageCallback!({ type: "tab.status" }, {}, (res) => {
      statusResponse = res;
    });

    expect(statusResponse).not.toBeNull();
    expect(statusResponse.active).toBe(true);
    expect(statusResponse.total).toBe(1);
    expect(statusResponse.title).toBe("SidecarStatus");

    // Test tab.export
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    let exportResponse: any = null;
    onPopupMessageCallback!(
      { type: "tab.export", format: "srt", mode: "bilingual" },
      {},
      (res) => {
        exportResponse = res;
      }
    );

    expect(exportResponse).toEqual({ ok: true });
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();

    controller.dispose();
  });
});

describe("Review D5", () => {
  it("requestSidecar gỡ listener abort khỏi signal sau khi xong", async () => {
    const ctrl = new AbortController();
    const add = vi.spyOn(ctrl.signal, "addEventListener");
    const remove = vi.spyOn(ctrl.signal, "removeEventListener");
    const r = await requestSidecar(
      undefined,
      {
        request: async (m) => ({ type: "drive.sidecar.result", reqId: m.reqId, ok: true, fileName: "a.srt", text: "x" }),
        sleep: async () => undefined,
        newReqId: () => "r1",
      },
      ctrl.signal
    );
    expect(r.ok).toBe(true);
    const added = add.mock.calls.filter((c) => c[0] === "abort").map((c) => c[1]);
    const removed = remove.mock.calls.filter((c) => c[0] === "abort").map((c) => c[1]);
    for (const fn of added) expect(removed).toContain(fn);
  });
});
