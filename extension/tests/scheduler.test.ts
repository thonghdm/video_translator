/**
 * SubTrans Extension — Unit tests cho Scheduler — PLAN Phase 6
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Scheduler, inPlayWindow } from "../src/content/scheduler";
import type { SubtitleItem } from "../src/shared/types";
import type { BackgroundPort } from "../src/content/port";
import { PortClosedError } from "../src/content/port";

function makeItems(count: number, dur = 3): SubtitleItem[] {
  const items: SubtitleItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: i,
      block: 0,
      start_sec: i * dur,
      end_sec: (i + 1) * dur,
      source_text: `Line ${i + 1}`,
      target_text: "",
      translated: false,
      engine: null,
      ignored: false,
    });
  }
  return items;
}

class FakePort {
  public sent: any[] = [];
  public cancelled: string[] = [];
  private statusListeners = new Set<(s: any) => void>();
  private handlers = new Map<string, (res: any) => void>();

  public onStatus(cb: (s: any) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  public emitStatus(s: any): void {
    for (const cb of this.statusListeners) cb(s);
  }

  public request<T = any>(msg: any): Promise<T> {
    this.sent.push(msg);
    return new Promise<T>((resolve) => {
      this.handlers.set(msg.reqId, resolve);
    });
  }

  public respond(reqId: string, res: any): void {
    const handler = this.handlers.get(reqId);
    if (handler) {
      this.handlers.delete(reqId);
      handler(res);
    }
  }

  public cancel(reqId: string): void {
    this.cancelled.push(reqId);
  }
}

describe("Scheduler inPlayWindow", () => {
  it("xác định đúng khoảng thời gian [t - 1s, t + 15s]", () => {
    const item: SubtitleItem = {
      id: 0,
      block: 0,
      start_sec: 10,
      end_sec: 14,
      source_text: "Test",
      target_text: "",
      translated: false,
      engine: null,
      ignored: false,
    };

    // playhead = 10 -> window [9, 25] -> true
    expect(inPlayWindow(item, 10)).toBe(true);
    // playhead = 0 -> window [-1, 15] -> item.start (10) <= 15 -> true
    expect(inPlayWindow(item, 0)).toBe(true);
    // playhead = 20 -> window [19, 35] -> item.end (14) < 19 -> false
    expect(inPlayWindow(item, 20)).toBe(false);
  });
});

describe("Scheduler Two-Tier Batching & Planning", () => {
  let fakePort: FakePort;

  beforeEach(() => {
    vi.useFakeTimers();
    fakePort = new FakePort();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops permanently on invalidated context and preserves the reload message", async () => {
    const request = vi.spyOn(fakePort, "request").mockRejectedValue(new PortClosedError());
    const onStatusMessage = vi.fn();
    const onItemsUpdated = vi.fn();
    const scheduler = new Scheduler({
      trackKey: "test:update", srcLang: "en", mode: "google",
      port: fakePort as unknown as BackgroundPort,
      getItems: () => makeItems(30), onItemsUpdated, onStatusMessage,
    });
    scheduler.plan(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatusMessage).toHaveBeenLastCalledWith(expect.stringContaining("F5"));
    expect(scheduler.inflightCount).toBe(0);
    expect(scheduler.queuedCount).toBe(0);
    const count = request.mock.calls.length;
    scheduler.tick(20);
    scheduler.onSeeked(40);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(count);
    expect(onItemsUpdated).not.toHaveBeenCalled();
    scheduler.dispose();
    expect(onStatusMessage).toHaveBeenLastCalledWith(expect.stringContaining("F5"));
  });

  it("continues retrying transient request errors", async () => {
    const request = vi.spyOn(fakePort, "request").mockRejectedValue(new Error("timeout"));
    const onStatusMessage = vi.fn();
    const scheduler = new Scheduler({
      trackKey: "test:timeout", srcLang: "en", mode: "google",
      port: fakePort as unknown as BackgroundPort,
      getItems: () => makeItems(30), onItemsUpdated: vi.fn(), onStatusMessage,
    });
    scheduler.plan(0);
    await vi.advanceTimersByTimeAsync(0);
    const count = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request.mock.calls.length).toBeGreaterThan(count);
    expect(onStatusMessage).not.toHaveBeenCalledWith(expect.stringContaining("F5"));
    scheduler.dispose();
  });

  it("ưu tiên tier1 -> ahead -> behind", () => {
    const items = makeItems(20, 2); // 0s tới 40s (mỗi câu 2s)
    let currentItems = [...items];

    const scheduler = new Scheduler({
      trackKey: "test:track",
      srcLang: "en",
      mode: "google",
      port: fakePort as unknown as BackgroundPort,
      getItems: () => currentItems,
      onItemsUpdated: (updated) => {
        currentItems = updated;
      },
    });

    // Playhead ở giây 20:
    // Window [19s, 35s] -> câu id 9 (18-20s) tới 17 (34-36s)
    scheduler.plan(20);

    // Kiểm tra các request được phát đi (tối đa 2 request ban đầu)
    expect(fakePort.sent.length).toBe(2);
    expect(fakePort.sent[0].priority).toBe("tier1");
    // Batch 1 chứa các câu thuộc vùng window quanh 20s
    expect(fakePort.sent[0].lines[0]).toBe("Line 10"); // id 9
    scheduler.dispose();
  });

  it("không bao giờ vượt quá 2 batch đang bay (inflight)", async () => {
    const items = makeItems(30, 2);
    const scheduler = new Scheduler({
      trackKey: "test:track",
      srcLang: "en",
      mode: "google",
      port: fakePort as unknown as BackgroundPort,
      getItems: () => items,
      onItemsUpdated: () => {},
    });

    scheduler.plan(0);
    expect(fakePort.sent.length).toBe(2);
    expect(scheduler.inflightCount).toBe(2);

    // Trả lời batch 1 -> batch 3 tự động được phát đi
    const req1 = fakePort.sent[0].reqId;
    fakePort.respond(req1, {
      type: "translate.result",
      reqId: req1,
      results: [{ text: "Dòng 1", engine: "api" }],
    });
    await Promise.resolve();

    expect(fakePort.sent.length).toBe(3);
    expect(scheduler.inflightCount).toBe(2);
    scheduler.dispose();
  });

  it("seek làm đổi thứ tự hàng đợi các batch chưa phát", async () => {
    const items = makeItems(40, 2);
    const scheduler = new Scheduler({
      trackKey: "test:track",
      srcLang: "en",
      mode: "google",
      port: fakePort as unknown as BackgroundPort,
      getItems: () => items,
      onItemsUpdated: () => {},
    });

    // Ban đầu playhead = 0 -> 2 batch đầu bay đi
    scheduler.plan(0);
    expect(fakePort.sent.length).toBe(2);

    // Tua tới giây 50
    scheduler.onSeeked(50);

    // Hoàn thành batch 1 -> batch tiếp theo được lấy từ vùng 50s chứ không phải vùng 0s cũ
    const req1 = fakePort.sent[0].reqId;
    fakePort.respond(req1, {
      type: "translate.result",
      reqId: req1,
      results: [{ text: "Dịch 1", engine: "api" }],
    });
    await Promise.resolve();

    expect(fakePort.sent.length).toBe(3);
    // Batch thứ 3 phải chứa câu quanh mốc 50s (Line 25: 48-50s)
    expect(fakePort.sent[2].lines[0]).toBe("Line 25");
    scheduler.dispose();
  });

  it("retry dòng rỗng tối đa 3 lần", async () => {
    const items = makeItems(1, 2);
    let currentItems = [...items];

    const scheduler = new Scheduler({
      trackKey: "test:track",
      srcLang: "en",
      mode: "google",
      port: fakePort as unknown as BackgroundPort,
      getItems: () => currentItems,
      onItemsUpdated: (up) => {
        currentItems = up;
      },
    });

    // Lần 1: dòng trả về rỗng
    scheduler.plan(0);
    const req1 = fakePort.sent[0].reqId;
    fakePort.respond(req1, {
      type: "translate.result",
      reqId: req1,
      results: [{ text: "", engine: null }],
    });
    await Promise.resolve();

    // Lần 2: plan lại -> vẫn được gửi
    scheduler.plan(0);
    expect(fakePort.sent.length).toBe(2);
    const req2 = fakePort.sent[1].reqId;
    fakePort.respond(req2, {
      type: "translate.result",
      reqId: req2,
      results: [{ text: "", engine: null }],
    });
    await Promise.resolve();

    // Lần 3: plan lại -> vẫn được gửi
    scheduler.plan(0);
    expect(fakePort.sent.length).toBe(3);
    const req3 = fakePort.sent[2].reqId;
    fakePort.respond(req3, {
      type: "translate.result",
      reqId: req3,
      results: [{ text: "", engine: null }],
    });
    await Promise.resolve();

    // Lần 4: đã đủ 3 lần retry -> không gửi nữa
    scheduler.plan(0);
    expect(fakePort.sent.length).toBe(3);
    scheduler.dispose();
  });

  it("tạm dừng khi gặp lỗi blocked và hiển thị thông báo đếm ngược", async () => {
    const items = makeItems(5, 2);
    const statusFn = vi.fn();

    const scheduler = new Scheduler({
      trackKey: "test:track",
      srcLang: "en",
      mode: "google",
      port: fakePort as unknown as BackgroundPort,
      getItems: () => items,
      onItemsUpdated: () => {},
      onStatusMessage: statusFn,
    });

    scheduler.plan(0);
    const req1 = fakePort.sent[0].reqId;
    // Báo lỗi blocked 15 giây
    fakePort.respond(req1, {
      type: "translate.result",
      reqId: req1,
      results: [],
      error: { kind: "blocked", message: "Rate limit", retryAfterMs: 15_000 },
    });
    await Promise.resolve();

    expect(statusFn).toHaveBeenCalledWith(expect.stringContaining("Đang tạm nghỉ"));

    // Trong lúc tạm dừng, plan không phát thêm batch nào
    fakePort.sent = [];
    scheduler.plan(0);
    expect(fakePort.sent.length).toBe(0);

    // Hết 15 giây -> tự động tiếp tục
    vi.advanceTimersByTime(16_000);
    expect(fakePort.sent.length).toBeGreaterThan(0);
    scheduler.dispose();
  });

  it("hybrid upgrade: chạy khi đã dịch hết, gửi priority 'upgrade'; bị chặn khi breaker cloud đang khóa", () => {
    const items: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 0,
        end_sec: 2,
        source_text: "Hello",
        target_text: "Xin chào",
        translated: true,
        engine: "api",
        ignored: false,
      },
    ];

    const scheduler = new Scheduler({
      trackKey: "test:track",
      srcLang: "en",
      mode: "hybrid",
      geminiModel: "gemini-3.5-flash-lite",
      port: fakePort as unknown as BackgroundPort,
      getItems: () => items,
      onItemsUpdated: () => {},
    });

    // Breaker cloud đang khóa → chưa upgrade
    fakePort.emitStatus({
      type: "status",
      geminiReady: false,
      breakers: { api: { blocked: false, until: 0 }, cloud: { blocked: true, until: Date.now() + 60_000 } },
    });
    scheduler.plan(0);
    expect(fakePort.sent.length).toBe(0);

    // Breaker mở lại (geminiReady có thể vẫn false vì bucket tạm cạn) → upgrade vẫn chạy
    fakePort.emitStatus({
      type: "status",
      geminiReady: false,
      breakers: { api: { blocked: false, until: 0 }, cloud: { blocked: false, until: 0 } },
    });
    scheduler.plan(0);
    expect(fakePort.sent.length).toBe(1);
    expect(fakePort.sent[0].priority).toBe("upgrade");
    expect(fakePort.sent[0].prefer).toBeUndefined();
    scheduler.dispose();
  });
});
