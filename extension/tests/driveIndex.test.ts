import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getFolderId,
  getVideoDocId,
  isDriveTopFrame,
  isDrivePlayerFrame,
  DOC_ID_PARAM,
} from "../src/content/drive/driveFrame";
import {
  DriveIndex,
  DRIVE_SELECTORS,
  initDriveTopFrame,
} from "../src/content/drive/driveIndex";
import type { DriveLookupReq } from "../src/shared/driveTypes";

describe("driveFrame utility functions", () => {
  describe("getFolderId", () => {
    it("trích xuất đúng folderId chuẩn", () => {
      expect(
        getFolderId("https://drive.google.com/drive/folders/1a2b3c4d5e6f7g8h9i0j_valid_id")
      ).toBe("1a2b3c4d5e6f7g8h9i0j_valid_id");
    });

    it("trích xuất đúng folderId khi có u/0 hoặc u/2", () => {
      expect(
        getFolderId("https://drive.google.com/drive/u/0/folders/1a2b3c4d5e6f7g8h9i0j_valid_id")
      ).toBe("1a2b3c4d5e6f7g8h9i0j_valid_id");
      expect(
        getFolderId("https://drive.google.com/drive/u/2/folders/1a2b3c4d5e6f7g8h9i0j_valid_id?usp=sharing")
      ).toBe("1a2b3c4d5e6f7g8h9i0j_valid_id");
    });

    it("trả về null khi id quá ngắn hoặc sai regex", () => {
      expect(getFolderId("https://drive.google.com/drive/folders/short_id")).toBeNull();
      expect(getFolderId("https://drive.google.com/drive/folders/bad/slash/id12345")).toBeNull();
    });

    it("trả về null khi không phải URL thư mục", () => {
      expect(getFolderId("https://drive.google.com/drive/my-drive")).toBeNull();
      expect(getFolderId("https://drive.google.com/file/d/1a2b3c4d5e6f7g8h9i0j_valid_id/view")).toBeNull();
      expect(getFolderId("")).toBeNull();
      expect(getFolderId("not a url")).toBeNull();
    });
  });

  describe("getVideoDocId", () => {
    it("trả về null khi DOC_ID_PARAM rỗng", () => {
      expect(DOC_ID_PARAM).toBe("");
      expect(getVideoDocId("https://drive.google.com/preview?id=valid_id_1234567890")).toBeNull();
    });
  });

  describe("isDriveTopFrame", () => {
    it("trả về true khi win.top === win và hostname là drive.google.com", () => {
      const mockWin = {
        location: { hostname: "drive.google.com" },
      } as unknown as Window;
      (mockWin as unknown as { top: Window }).top = mockWin;

      expect(isDriveTopFrame(mockWin)).toBe(true);
    });

    it("trả về false khi không phải top frame (iframe)", () => {
      const mockTop = {} as Window;
      const mockWin = {
        top: mockTop,
        location: { hostname: "drive.google.com" },
      } as unknown as Window;

      expect(isDriveTopFrame(mockWin)).toBe(false);
    });

    it("trả về false khi hostname khác drive.google.com", () => {
      const mockWin = {
        location: { hostname: "youtube.com" },
      } as unknown as Window;
      (mockWin as unknown as { top: Window }).top = mockWin;

      expect(isDriveTopFrame(mockWin)).toBe(false);
    });

    it("trả về false khi truy cập win.top ném lỗi cross-origin", () => {
      const mockWin = {
        get top() {
          throw new Error("SecurityError: Blocked a frame with origin");
        },
        location: { hostname: "drive.google.com" },
      } as unknown as Window;

      expect(isDriveTopFrame(mockWin)).toBe(false);
    });
  });

  describe("isDrivePlayerFrame", () => {
    it("trả về true khi là iframe và ancestorOrigins chứa drive.google.com", () => {
      const mockWin = {
        top: {} as Window,
        location: {
          ancestorOrigins: {
            contains: (origin: string) => origin === "https://drive.google.com",
            length: 1,
            [0]: "https://drive.google.com",
          },
        },
      } as unknown as Window;

      expect(isDrivePlayerFrame(mockWin)).toBe(true);
    });

    it("trả về false khi win.top === win (là top frame)", () => {
      const mockWin = {
        location: {
          ancestorOrigins: { contains: () => true },
        },
      } as unknown as Window;
      (mockWin as unknown as { top: Window }).top = mockWin;

      expect(isDrivePlayerFrame(mockWin)).toBe(false);
    });

    it("trả về false khi ancestorOrigins không chứa drive.google.com", () => {
      const mockWin = {
        top: {} as Window,
        location: {
          ancestorOrigins: {
            contains: () => false,
            length: 1,
            [0]: "https://other.com",
          },
        },
      } as unknown as Window;

      expect(isDrivePlayerFrame(mockWin)).toBe(false);
    });

    it("trả về false khi ancestorOrigins ném lỗi hoặc undefined", () => {
      const mockWin1 = {
        top: {} as Window,
        location: {},
      } as unknown as Window;
      expect(isDrivePlayerFrame(mockWin1)).toBe(false);

      const mockWin2 = {
        top: {} as Window,
        location: {
          get ancestorOrigins() {
            throw new Error("SecurityError");
          },
        },
      } as unknown as Window;
      expect(isDrivePlayerFrame(mockWin2)).toBe(false);
    });
  });
});

describe("DriveIndex", () => {
  let doc: Document;
  let currentUrl: string;

  beforeEach(() => {
    doc = document.implementation.createHTMLDocument("Drive Test");
    currentUrl = "https://drive.google.com/drive/folders/folder_valid_123456789";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("scan gom đúng file trong cả List View và Grid View (theo cấu trúc D0)", () => {
    // List view: [data-id] mang thuộc tính aria-label
    const listRow1 = doc.createElement("div");
    listRow1.setAttribute("data-id", "file_video_001_id_123456");
    listRow1.setAttribute("aria-label", "001 Introduction.mp4");
    doc.body.appendChild(listRow1);

    const listRow2 = doc.createElement("div");
    listRow2.setAttribute("data-id", "file_sub_001_en_id_123456");
    listRow2.setAttribute("aria-label", "001 Introduction_en.srt");
    doc.body.appendChild(listRow2);

    // Grid view: [data-id] có tên trong text con hoặc sub-selector
    const gridItem = doc.createElement("div");
    gridItem.setAttribute("data-id", "file_video_002_id_123456");
    const nameSpan = doc.createElement("span");
    nameSpan.className = "drive-item-name";
    nameSpan.textContent = "002 Getting Started.mp4";
    gridItem.appendChild(nameSpan);
    doc.body.appendChild(gridItem);

    const index = new DriveIndex(doc, () => currentUrl);
    index.scan();

    expect(index.size).toBe(3);
  });

  it("scan bỏ qua các id không khớp DRIVE_ID_RE hoặc tên rỗng/quá dài", () => {
    // ID sai regex
    const rowBadId = doc.createElement("div");
    rowBadId.setAttribute("data-id", "short");
    rowBadId.setAttribute("aria-label", "Valid Name.mp4");
    doc.body.appendChild(rowBadId);

    // Tên rỗng
    const rowEmptyName = doc.createElement("div");
    rowEmptyName.setAttribute("data-id", "valid_id_1234567890123");
    rowEmptyName.setAttribute("aria-label", "    ");
    doc.body.appendChild(rowEmptyName);

    // Tên > 512 ký tự
    const rowLongName = doc.createElement("div");
    rowLongName.setAttribute("data-id", "valid_id_long_name_1234");
    rowLongName.setAttribute("aria-label", "a".repeat(513));
    doc.body.appendChild(rowLongName);

    const index = new DriveIndex(doc, () => currentUrl);
    index.scan();

    expect(index.size).toBe(0);
  });

  it("scan giới hạn tối đa 5000 entry", () => {
    for (let i = 0; i < 5005; i++) {
      const row = doc.createElement("div");
      row.setAttribute("data-id", `file_id_${String(i).padStart(6, "0")}_1234567`);
      row.setAttribute("aria-label", `File_${i}.mp4`);
      doc.body.appendChild(row);
    }

    const index = new DriveIndex(doc, () => currentUrl);
    index.scan();

    expect(index.size).toBe(5000);
  });

  it("start() gọi scan ngay và debounce 300ms khi DOM thay đổi", async () => {
    vi.useFakeTimers();

    const row1 = doc.createElement("div");
    row1.setAttribute("data-id", "file_initial_id_123456");
    row1.setAttribute("aria-label", "Initial.mp4");
    doc.body.appendChild(row1);

    const index = new DriveIndex(doc, () => currentUrl);
    index.start();

    // Scan ngay lần đầu
    expect(index.size).toBe(1);

    // Thêm phần tử mới vào DOM
    const row2 = doc.createElement("div");
    row2.setAttribute("data-id", "file_second_id_123456");
    row2.setAttribute("aria-label", "Second.mp4");
    doc.body.appendChild(row2);

    // Cho microtask của MutationObserver chạy để đặt timer debounce
    await Promise.resolve();

    // Trước 300ms: chưa scan lại
    await vi.advanceTimersByTimeAsync(200);
    expect(index.size).toBe(1);

    // Sau 300ms: đã scan lại và nạp thêm
    await vi.advanceTimersByTimeAsync(150);
    expect(index.size).toBe(2);

    index.dispose();
  });

  it("gọi start() 2 lần không tạo thêm MutationObserver thứ 2", () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const index = new DriveIndex(doc, () => currentUrl);

    index.start();
    expect(observeSpy).toHaveBeenCalledTimes(1);

    index.start(); // Gọi lần 2
    expect(observeSpy).toHaveBeenCalledTimes(1); // Vẫn chỉ 1 lần

    observeSpy.mockRestore();
    index.dispose();
  });

  it("đổi folderId khi scan → map cũ bị xóa và nạp lại từ folder mới", () => {
    const row1 = doc.createElement("div");
    row1.setAttribute("data-id", "folder1_file_id_123456");
    row1.setAttribute("aria-label", "Folder1.mp4");
    doc.body.appendChild(row1);

    const index = new DriveIndex(doc, () => currentUrl);
    index.scan();
    expect(index.size).toBe(1);

    // Chuyển sang folder khác
    currentUrl = "https://drive.google.com/drive/folders/folder_another_123456";
    doc.body.innerHTML = "";

    const row2 = doc.createElement("div");
    row2.setAttribute("data-id", "folder2_file_id_123456");
    row2.setAttribute("aria-label", "Folder2.mp4");
    doc.body.appendChild(row2);

    index.scan();
    expect(index.size).toBe(1);
    expect(index.lookup("folder1_file_id_123456")).toEqual({
      ok: true,
      indexed: 1,
      result: "none",
    });
    expect(DRIVE_SELECTORS.row).toBe("[data-id]");
  });

  it("lookup theo videoDocId khớp phụ đề", () => {
    const rowVideo = doc.createElement("div");
    rowVideo.setAttribute("data-id", "video_doc_id_12345678");
    rowVideo.setAttribute("aria-label", "001 Setup.mp4");
    doc.body.appendChild(rowVideo);

    const rowSub = doc.createElement("div");
    rowSub.setAttribute("data-id", "sub_doc_id_1234567890");
    rowSub.setAttribute("aria-label", "001 Setup_en.srt");
    doc.body.appendChild(rowSub);

    const index = new DriveIndex(doc, () => currentUrl);
    index.scan();

    const res = index.lookup("video_doc_id_12345678");
    expect(res).toEqual({
      ok: true,
      indexed: 2,
      result: "match",
      id: "sub_doc_id_1234567890",
      name: "001 Setup_en.srt",
    });
  });

  it("lookup theo tiêu đề preview khi không có videoDocId", () => {
    // Không có video trong map, nhưng có tiêu đề preview trên thanh top bar
    const titleEl = doc.createElement("div");
    titleEl.setAttribute("role", "heading");
    titleEl.textContent = "002 Architecture.mp4";
    doc.body.appendChild(titleEl);

    const rowSub = doc.createElement("div");
    rowSub.setAttribute("data-id", "sub_arch_id_1234567890");
    rowSub.setAttribute("aria-label", "002 Architecture_en.srt");
    doc.body.appendChild(rowSub);

    const index = new DriveIndex(doc, () => currentUrl);
    index.scan();

    const res = index.lookup(); // không truyền videoDocId
    expect(res).toEqual({
      ok: true,
      indexed: 1,
      result: "match",
      id: "sub_arch_id_1234567890",
      name: "002 Architecture_en.srt",
    });
  });

  it("lookup trả none khi không có tiêu đề và không có videoDocId", () => {
    const index = new DriveIndex(doc, () => currentUrl);
    index.scan();
    const res = index.lookup();
    expect(res).toEqual({ ok: true, indexed: 0, result: "none" });
  });

  it("lookup trả ambiguous khi tìm theo tiêu đề mà có ≥ 2 video cùng tên base", () => {
    // 2 video cùng base name "Lesson 1" (.mp4 và .mkv)
    const rowV1 = doc.createElement("div");
    rowV1.setAttribute("data-id", "video1_id_1234567890");
    rowV1.setAttribute("aria-label", "Lesson 1.mp4");
    doc.body.appendChild(rowV1);

    const rowV2 = doc.createElement("div");
    rowV2.setAttribute("data-id", "video2_id_1234567890");
    rowV2.setAttribute("aria-label", "Lesson 1.mkv");
    doc.body.appendChild(rowV2);

    const rowSub = doc.createElement("div");
    rowSub.setAttribute("data-id", "sub_id_1234567890123");
    rowSub.setAttribute("aria-label", "Lesson 1_en.srt");
    doc.body.appendChild(rowSub);

    // Tiêu đề preview là "Lesson 1" (không có đuôi video)
    const titleEl = doc.createElement("div");
    titleEl.setAttribute("role", "heading");
    titleEl.textContent = "Lesson 1";
    doc.body.appendChild(titleEl);

    const index = new DriveIndex(doc, () => currentUrl);
    index.scan();

    const res = index.lookup(); // Khớp theo tiêu đề
    expect(res).toEqual({ ok: true, indexed: 3, result: "ambiguous" });
  });

  it("dispose() hủy observer, xóa map, chèn thêm DOM không làm tăng size", () => {
    vi.useFakeTimers();

    const row1 = doc.createElement("div");
    row1.setAttribute("data-id", "file1_id_1234567890");
    row1.setAttribute("aria-label", "Test.mp4");
    doc.body.appendChild(row1);

    const index = new DriveIndex(doc, () => currentUrl);
    index.start();
    expect(index.size).toBe(1);

    index.dispose();
    expect(index.size).toBe(0);

    // Thêm DOM sau khi dispose
    const row2 = doc.createElement("div");
    row2.setAttribute("data-id", "file2_id_1234567890");
    row2.setAttribute("aria-label", "Test2.mp4");
    doc.body.appendChild(row2);

    vi.advanceTimersByTime(500);
    expect(index.size).toBe(0);
  });
});

describe("Drive Top Frame Bootstrap & Message Handling", () => {
  let mockWin: Window;
  let mockDoc: Document;
  let messageListeners: ((
    msg: unknown,
    sender: unknown,
    sendResponse: (res: unknown) => void
  ) => boolean | undefined)[] = [];

  beforeEach(() => {
    messageListeners = [];
    mockDoc = document.implementation.createHTMLDocument("Bootstrap Test");
    const row = mockDoc.createElement("div");
    row.setAttribute("data-id", "video_id_1234567890");
    row.setAttribute("aria-label", "001 Hello.mp4");
    mockDoc.body.appendChild(row);

    const sub = mockDoc.createElement("div");
    sub.setAttribute("data-id", "sub_id_123456789012");
    sub.setAttribute("aria-label", "001 Hello_en.srt");
    mockDoc.body.appendChild(sub);

    mockWin = {
      location: {
        hostname: "drive.google.com",
        href: "https://drive.google.com/drive/folders/folder_test_12345678",
      },
    } as unknown as Window;
    (mockWin as unknown as { top: Window }).top = mockWin;

    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: "mock_extension_id",
        onMessage: {
          addListener: vi.fn((fn) => messageListeners.push(fn)),
          removeListener: vi.fn((fn) => {
            messageListeners = messageListeners.filter((l) => l !== fn);
          }),
        },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({ settings: { drive: { autoSidecar: true } } })),
          set: vi.fn(),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    delete (globalThis as unknown as { __subtransDrive?: unknown }).__subtransDrive;
  });

  it("không đăng ký listener nếu không phải top frame", () => {
    const notTopWin = {
      top: {} as Window,
      location: { hostname: "drive.google.com" },
    } as unknown as Window;

    const handle = initDriveTopFrame(notTopWin, mockDoc);
    expect(handle).toBeUndefined();
    expect(messageListeners).toHaveLength(0);
  });

  it("đăng ký listener và trả lời đúng message drive.lookup", async () => {
    const handle = initDriveTopFrame(mockWin, mockDoc);
    expect(handle).toBeDefined();
    expect(messageListeners).toHaveLength(1);

    // Chờ loadSettings hoàn thành
    await new Promise((r) => setTimeout(r, 10));

    const listener = messageListeners[0];
    let capturedRes: unknown;
    const sendResponse = vi.fn((res) => {
      capturedRes = res;
    });

    // 1. Message lạ (ví dụ popup tab.status) → không trả lời (sendResponse không được gọi)
    listener({ type: "tab.status" }, {}, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();

    // 2. Message drive.lookup → gọi sendResponse
    const req: DriveLookupReq = { type: "drive.lookup", videoDocId: "video_id_1234567890" };
    listener(req, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledOnce();
    expect(capturedRes).toEqual({
      ok: true,
      indexed: 2,
      result: "match",
      id: "sub_id_123456789012",
      name: "001 Hello_en.srt",
    });

    handle?.dispose();
  });

  it("trả về { ok: false } khi drive.autoSidecar bị tắt", async () => {
    (globalThis as unknown as { chrome: { storage: { local: { get: unknown } } } }).chrome.storage.local.get = vi.fn(
      async () => ({ settings: { drive: { autoSidecar: false } } })
    );

    const handle = initDriveTopFrame(mockWin, mockDoc);
    await new Promise((r) => setTimeout(r, 10));

    const listener = messageListeners[0];
    let capturedRes: unknown;
    const sendResponse = vi.fn((res) => {
      capturedRes = res;
    });

    listener({ type: "drive.lookup" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledOnce();
    expect(capturedRes).toEqual({ ok: false });

    handle?.dispose();
  });

  it("onPopupMessage của ContentController KHÔNG trả lời drive.lookup", () => {
    // Giả lập listener onPopupMessage trong ContentController
    const sendResponse = vi.fn();
    const fakeOnPopupMessage = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string };
      if (m.type === "tab.status" || m.type === "tab.export") {
        sendResponse({ ok: true });
      }
    };

    fakeOnPopupMessage({ type: "drive.lookup", videoDocId: "abc" });
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
