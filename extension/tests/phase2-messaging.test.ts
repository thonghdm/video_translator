/**
 * Lỗi 4 (listener đăng ký đồng bộ, handler chờ `ready`) và lỗi 9 (postMessage lên port đã ngắt).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { MessagingHub, safePost } from "../src/background/messaging";

type Fn = (...a: unknown[]) => unknown;

function fakeChrome() {
  const onConnect: Fn[] = [];
  const onMessage: Fn[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onConnect: { addListener: (f: Fn) => onConnect.push(f) },
      onMessage: { addListener: (f: Fn) => onMessage.push(f) },
    },
  };
  return { onConnect, onMessage };
}

function fakePort() {
  const msgFns: Fn[] = [];
  const discFns: Fn[] = [];
  return {
    name: "subtrans",
    sent: [] as unknown[],
    dead: false,
    postMessage(m: unknown) {
      if (this.dead) throw new Error("Attempting to use a disconnected port object");
      this.sent.push(m);
    },
    onMessage: { addListener: (f: Fn) => msgFns.push(f) },
    onDisconnect: { addListener: (f: Fn) => discFns.push(f) },
    emit: (m: unknown) => msgFns.forEach((f) => f(m)),
    drop() {
      this.dead = true;
      discFns.forEach((f) => f());
    },
  };
}

function makeHub(router: { translate: Fn }, driveSidecar?: unknown) {
  const br = { blocked: () => false, getBlockedUntil: () => 0 };
  return new MessagingHub(
    router as never,
    br as never,
    br as never,
    { isAvailable: () => false, getEndpoint: () => "https://x" } as never,
    { scheduleSave: vi.fn() } as never,
    {} as never,
    undefined,
    driveSidecar as never
  );
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("MessagingHub.init (MV3)", () => {
  it("đăng ký listener NGAY (đồng bộ) dù init bất đồng bộ chưa xong; message được xử lý sau khi ready", async () => {
    const { onConnect, onMessage } = fakeChrome();
    const translate = vi.fn(async () => ({ results: [{ text: "VI", engine: "api" }] }));
    let finishInit!: () => void;
    const ready = new Promise<void>((r) => (finishInit = r));

    makeHub({ translate }).init(ready);
    expect(onConnect).toHaveLength(1);
    expect(onMessage).toHaveLength(1);

    // SW vừa thức dậy vì content kết nối lại → event tới TRƯỚC khi init xong
    const port = fakePort();
    onConnect[0](port);
    port.emit({ type: "translate", reqId: "r1", trackKey: "k", srcLang: "en", lines: ["Hi"], priority: "tier1" });
    await Promise.resolve();
    expect(translate).not.toHaveBeenCalled(); // chưa ready → chưa xử lý (không bị mất)

    finishInit();
    await new Promise((r) => setTimeout(r, 0));
    expect(translate).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(port.sent.some((m) => (m as { type: string }).type === "translate.result")).toBe(true);
  });

  it("init lỗi vẫn không chặn handler (ready bị reject được nuốt)", async () => {
    const { onConnect } = fakeChrome();
    const translate = vi.fn(async () => ({ results: [] }));
    makeHub({ translate }).init(Promise.reject(new Error("restore fail")));
    const port = fakePort();
    onConnect[0](port);
    port.emit({ type: "translate", reqId: "r1", trackKey: "k", srcLang: "en", lines: ["Hi"], priority: "tier1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(translate).toHaveBeenCalledOnce();
  });

  it("port ngắt trong lúc đang dịch → không ném unhandled rejection khi gửi kết quả", async () => {
    const { onConnect } = fakeChrome();
    let resolve!: (v: unknown) => void;
    const translate = vi.fn(() => new Promise((r) => (resolve = r)));
    makeHub({ translate }).init();
    const port = fakePort();
    onConnect[0](port);
    port.emit({ type: "translate", reqId: "r1", trackKey: "k", srcLang: "en", lines: ["Hi"], priority: "tier1" });
    await new Promise((r) => setTimeout(r, 0));
    port.drop();
    const unhandled = vi.fn();
    const proc = (globalThis as unknown as { process: { on: Fn; off: Fn } }).process;
    proc.on("unhandledRejection", unhandled);
    resolve({ results: [{ text: "x", engine: "api" }] });
    await new Promise((r) => setTimeout(r, 10));
    proc.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("safePost trả false thay vì ném lỗi", () => {
    const port = fakePort();
    port.dead = true;
    expect(safePost(port as never, { type: "fetchText.result", reqId: "r", ok: false })).toBe(false);
  });

  it("drive.sidecar qua fake port → đúng drive.sidecar.result cùng reqId", async () => {
    const { onConnect } = fakeChrome();
    const mockSidecar = {
      handle: vi.fn(async (_sender, _docId) => ({
        ok: true as const,
        mode: "en" as const,
        en: {
          name: "test.srt",
          text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello",
        },
        fileName: "test.srt",
        text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello",
      })),
    };
    makeHub({ translate: vi.fn() }, mockSidecar as never).init();
    const port = Object.assign(fakePort(), {
      sender: { tab: { id: 10, url: "https://drive.google.com/test" } },
    });
    onConnect[0](port);

    port.emit({
      type: "drive.sidecar",
      reqId: "req-sidecar-1",
      videoDocId: "doc_1234567890",
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockSidecar.handle).toHaveBeenCalledWith(port.sender, "doc_1234567890");

    const result = port.sent.find((m) => (m as { type: string }).type === "drive.sidecar.result");
    expect(result).toEqual({
      type: "drive.sidecar.result",
      reqId: "req-sidecar-1",
      ok: true,
      mode: "en",
      en: {
        name: "test.srt",
        text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello",
      },
      fileName: "test.srt",
      text: "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello",
    });
  });

  it("drive.sidecar khi không truyền driveSidecar → trả về disabled", async () => {
    const { onConnect } = fakeChrome();
    makeHub({ translate: vi.fn() }).init();
    const port = fakePort();
    onConnect[0](port);

    port.emit({
      type: "drive.sidecar",
      reqId: "req-sidecar-2",
    });

    await new Promise((r) => setTimeout(r, 0));
    const result = port.sent.find((m) => (m as { type: string }).type === "drive.sidecar.result");
    expect(result).toEqual({
      type: "drive.sidecar.result",
      reqId: "req-sidecar-2",
      ok: false,
      reason: "disabled",
    });
  });

  it("drive.sidecar khi port đã ngắt trước khi có kết quả → không ném lỗi", async () => {
    const { onConnect } = fakeChrome();
    let resolveHandle!: (val: unknown) => void;
    const mockSidecar = {
      handle: vi.fn(() => new Promise((r) => (resolveHandle = r))),
    };
    makeHub({ translate: vi.fn() }, mockSidecar).init();
    const port = fakePort();
    onConnect[0](port);

    port.emit({
      type: "drive.sidecar",
      reqId: "req-sidecar-3",
    });

    await new Promise((r) => setTimeout(r, 0));
    port.drop();

    const unhandled = vi.fn();
    const proc = (globalThis as unknown as { process: { on: Fn; off: Fn } }).process;
    proc.on("unhandledRejection", unhandled);

    resolveHandle({ ok: true, fileName: "001.srt", text: "cues" });
    await new Promise((r) => setTimeout(r, 10));

    proc.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
