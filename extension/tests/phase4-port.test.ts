/**
 * Phase 4 — BackgroundPort: kết nối lười, tự kết nối lại + gửi lại request (PLAN 4.3)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BackgroundPort, PortClosedError, type PortLike } from "../src/content/port";

class FakePort implements PortLike {
  public sent: unknown[] = [];
  private msgFns: Array<(m: unknown) => void> = [];
  private discFns: Array<() => void> = [];
  public onMessage = { addListener: (fn: (m: unknown) => void) => this.msgFns.push(fn) };
  public onDisconnect = { addListener: (fn: () => void) => this.discFns.push(fn) };
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  disconnect() {}
  emit(m: unknown) {
    this.msgFns.forEach((f) => f(m));
  }
  drop() {
    this.discFns.forEach((f) => f());
  }
}

describe("BackgroundPort", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("không kết nối cho tới request đầu tiên", () => {
    const connect = vi.fn(() => new FakePort());
    new BackgroundPort(connect);
    expect(connect).not.toHaveBeenCalled();
  });

  it("request nhận đúng message cùng reqId; status đi tới listener", async () => {
    const fp = new FakePort();
    const bp = new BackgroundPort(() => fp);
    const status = vi.fn();
    bp.onStatus(status);
    const p = bp.request({ type: "fetchText", reqId: "r1", url: "https://x/a.vtt" });
    expect(fp.sent).toHaveLength(1);
    fp.emit({ type: "status", breakers: { api: { blocked: false, until: 0 }, cloud: { blocked: false, until: 0 } }, geminiReady: false });
    fp.emit({ type: "fetchText.result", reqId: "khac", ok: true, text: "no" });
    fp.emit({ type: "fetchText.result", reqId: "r1", ok: true, text: "WEBVTT" });
    await expect(p).resolves.toMatchObject({ reqId: "r1", text: "WEBVTT" });
    expect(status).toHaveBeenCalledOnce();
    expect(bp.pendingCount).toBe(0);
  });

  it("port ngắt khi đang chờ → kết nối lại sau 250ms và GỬI LẠI request", async () => {
    const ports: FakePort[] = [];
    const bp = new BackgroundPort(() => {
      const p = new FakePort();
      ports.push(p);
      return p;
    });
    const req = bp.request({ type: "fetchText", reqId: "r1", url: "https://x" });
    ports[0].drop(); // SW bị tắt
    expect(ports).toHaveLength(1);
    vi.advanceTimersByTime(249);
    expect(ports).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ports).toHaveLength(2);
    expect(ports[1].sent).toEqual([{ type: "fetchText", reqId: "r1", url: "https://x" }]);
    ports[1].emit({ type: "fetchText.result", reqId: "r1", ok: true, text: "ok" });
    await expect(req).resolves.toMatchObject({ text: "ok" });
  });

  it("connect lỗi liên tiếp → backoff 250ms, 1s, 3s", () => {
    let calls = 0;
    const bp = new BackgroundPort(() => {
      calls++;
      throw new Error("Could not establish connection");
    });
    void bp.request({ type: "fetchText", reqId: "r1", url: "https://x" }).catch(() => {});
    expect(calls).toBe(1);
    vi.advanceTimersByTime(250);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(999);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(3);
    vi.advanceTimersByTime(3000);
    expect(calls).toBe(4);
    bp.dispose();
  });

  it("'Extension context invalidated' → từ chối ngay, không thử lại", async () => {
    let calls = 0;
    const bp = new BackgroundPort(() => {
      calls++;
      throw new Error("Extension context invalidated.");
    });
    await expect(bp.request({ type: "fetchText", reqId: "r1", url: "https://x" })).rejects.toBeInstanceOf(PortClosedError);
    vi.advanceTimersByTime(10_000);
    expect(calls).toBe(1);
    await expect(bp.request({ type: "fetchText", reqId: "r2", url: "https://x" })).rejects.toBeInstanceOf(PortClosedError);
  });

  it("timeout request; cancel gửi message cancel và từ chối promise", async () => {
    const fp = new FakePort();
    const bp = new BackgroundPort(() => fp, { timeoutMs: 1000 });
    const p1 = bp.request({ type: "fetchText", reqId: "r1", url: "https://x" });
    const p1Err = p1.catch((e) => e);
    vi.advanceTimersByTime(1000);
    expect(String(await p1Err)).toMatch(/Hết thời gian/);

    const p2 = bp.request({ type: "fetchText", reqId: "r2", url: "https://x" });
    const p2Err = p2.catch((e) => e);
    bp.cancel("r2");
    expect(String(await p2Err)).toMatch(/canceled/);
    expect(fp.sent[fp.sent.length - 1]).toEqual({ type: "cancel", reqId: "r2" });
  });

  it("không có request chờ thì port ngắt KHÔNG tự kết nối lại (kết nối lười)", () => {
    const ports: FakePort[] = [];
    const bp = new BackgroundPort(() => {
      const p = new FakePort();
      ports.push(p);
      return p;
    });
    bp.send({ type: "cancel", reqId: "x" });
    ports[0].drop();
    vi.advanceTimersByTime(10_000);
    expect(ports).toHaveLength(1);
  });
});
