import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EDGE_TTS_CONFIG,
  arrayBufferToBase64,
  ensureEdgeTtsHeaderRules,
  extractAudioFromBinaryFrame,
  generateSecMsGec,
  getCachedClockSkewSec,
  resetClockSkewForTest,
  synthesizeEdgeTts,
} from "../src/background/engines/edgeTts";

function buildBinaryFrame(header: string, payload: Uint8Array): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(header);
  const total = 2 + headerBytes.length + payload.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint16(0, headerBytes.length, false);
  const out = new Uint8Array(buf);
  out.set(headerBytes, 2);
  out.set(payload, 2 + headerBytes.length);
  return buf;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  public url: string;
  public binaryType = "blob";
  public readyState = MockWebSocket.CONNECTING;
  public sent: string[] = [];
  public closed = false;

  public onopen: ((ev: Event) => void) | null = null;
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  public onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  public triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  public triggerMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  public triggerClose(code: number, reason = ""): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

describe("edgeTts engine", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;

  beforeEach(() => {
    resetClockSkewForTest();
    MockWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome;
    vi.restoreAllMocks();
  });

  it("generateSecMsGec tạo SHA-256 HEX IN HOA 64 ký tự và ổn định trong cửa sổ 5 phút", async () => {
    // 1700000100s và 1700000250s đều thuộc cửa sổ 5 phút [1700000100, 1700000400)
    const t1 = 1700000100 * 1000;
    const t2 = 1700000250 * 1000;
    const tNextWindow = 1700000400 * 1000;

    const g1 = await generateSecMsGec(t1, 0);
    const g2 = await generateSecMsGec(t2, 0);
    const gNext = await generateSecMsGec(tNextWindow, 0);
    const gSkewed = await generateSecMsGec(t1, 300);

    expect(g1).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
    expect(g1).toBe(g2);
    expect(g1).not.toBe(gNext);
    expect(gSkewed).toBe(gNext);
  });

  it("extractAudioFromBinaryFrame cắt đúng header Path:audio và bỏ qua frame không hợp lệ", () => {
    const payload = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x11, 0x22]);
    const audioFrame = buildBinaryFrame(
      "X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n",
      payload
    );
    const extracted = extractAudioFromBinaryFrame(audioFrame);
    expect(extracted).not.toBeNull();
    expect(Array.from(extracted!)).toEqual(Array.from(payload));

    const nonAudioFrame = buildBinaryFrame("Path:audio.metadata\r\n", payload);
    // Chú ý "Path:audio.metadata" vẫn chứa chuỗi "Path:audio", kiểm tra frame Path:turn.start
    const turnStartFrame = buildBinaryFrame("Path:turn.start\r\n", payload);
    expect(extractAudioFromBinaryFrame(turnStartFrame)).toBeNull();
    expect(nonAudioFrame.byteLength).toBeGreaterThan(2);

    // Frame quá ngắn (< 2 byte hoặc không có payload)
    expect(extractAudioFromBinaryFrame(new ArrayBuffer(1))).toBeNull();
    const emptyPayload = buildBinaryFrame("Path:audio\r\n", new Uint8Array(0));
    expect(extractAudioFromBinaryFrame(emptyPayload)).toBeNull();
  });

  it("arrayBufferToBase64 xử lý buffer > 100 KB không bị tràn call stack và giải mã khớp byte gốc", () => {
    const size = 120 * 1024 + 17;
    const raw = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      raw[i] = (i * 31 + 7) & 0xff;
    }

    const b64 = arrayBufferToBase64(raw);
    expect(b64.length).toBeGreaterThan(100_000);

    const decodedStr = atob(b64);
    expect(decodedStr.length).toBe(size);
    for (let i = 0; i < size; i += 997) {
      expect(decodedStr.charCodeAt(i)).toBe(raw[i]);
    }
  });

  it("ensureEdgeTtsHeaderRules gọi removeRuleIds cùng addRules (không gắn initiatorDomains) và an toàn khi thiếu API", async () => {
    const updateDynamicRules = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { id: "ext-test-id" },
      declarativeNetRequest: { updateDynamicRules },
    };

    await ensureEdgeTtsHeaderRules();
    expect(updateDynamicRules).toHaveBeenCalledTimes(1);
    const firstArg = updateDynamicRules.mock.calls[0][0];
    expect(firstArg.removeRuleIds).toEqual([EDGE_TTS_CONFIG.DNR_RULE_ID]);
    expect(firstArg.addRules).toHaveLength(1);
    expect(firstArg.addRules[0].condition.initiatorDomains).toBeUndefined();
    expect(firstArg.addRules[0].condition.urlFilter).toContain(
      "speech.platform.bing.com/consumer/speech/synthesize/readaloud/"
    );

    // Không ném lỗi khi không có declarativeNetRequest hoặc khi updateDynamicRules reject
    const updateReject = vi.fn().mockRejectedValueOnce(new Error("DNR error"));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      declarativeNetRequest: { updateDynamicRules: updateReject },
    };
    await expect(ensureEdgeTtsHeaderRules()).resolves.toBeUndefined();

    (globalThis as unknown as { chrome: unknown }).chrome = {};
    await expect(ensureEdgeTtsHeaderRules()).resolves.toBeUndefined();
  });

  it("synthesizeEdgeTts gửi đủ 2 frame, ghép binary MP3 và trả đúng Base64 khi gặp Path:turn.end", async () => {
    const promise = synthesizeEdgeTts({
      text: "Xin chào <thế giới> & bạn",
      voice: "vi-VN-HoaiMyNeural",
      rate: "+10%",
    });

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    expect(ws.binaryType).toBe("arraybuffer");
    expect(ws.url).toContain("TrustedClientToken=");
    expect(ws.url).toContain("Sec-MS-GEC=");

    ws.triggerOpen();
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]).toContain("Path:speech.config");
    expect(ws.sent[1]).toContain("Path:ssml");
    expect(ws.sent[1]).toContain("Xin chào &lt;thế giới&gt; &amp; bạn");
    // Không bị thừa chữ Z ở cuối ISO timestamp
    expect(ws.sent[1]).not.toMatch(/X-Timestamp:.*ZZ\r\n/);

    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6, 7]);
    ws.triggerMessage(buildBinaryFrame("Path:audio\r\n", chunk1));
    ws.triggerMessage(buildBinaryFrame("Path:audio\r\n", chunk2));
    ws.triggerMessage("X-RequestId:abc\r\nPath:turn.end\r\n\r\n");

    const b64 = await promise;
    expect(b64).toBe(arrayBufferToBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7])));
    expect(ws.closed).toBe(true);
  });

  it("synthesizeEdgeTts đóng WebSocket và reject AbortError khi AbortSignal kích hoạt", async () => {
    const controller = new AbortController();
    const promise = synthesizeEdgeTts({
      text: "Hủy giữa chừng",
      voice: "vi-VN-NamMinhNeural",
      rate: "+0%",
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(ws.closed).toBe(true);
    // Không retry khi đã abort
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("synthesizeEdgeTts đồng bộ đồng hồ và retry đúng 1 lần khi đóng bất thường trước khi nhận audio", async () => {
    const serverFutureDate = new Date(Date.now() + 600_000).toUTCString();
    const fetchMock = vi.fn().mockResolvedValue({
      headers: new Headers({ Date: serverFutureDate }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = synthesizeEdgeTts({
      text: "Kiểm tra bù lệch đồng hồ",
      voice: "vi-VN-HoaiMyNeural",
      rate: "+0%",
    });

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws1 = MockWebSocket.instances[0];
    // Lần 1 đóng bất thường trước khi có byte audio nào
    ws1.triggerClose(1006, "Abnormal Closure");

    // Chờ lần retry thứ 2 được tạo sau syncClockSkew
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "HEAD",
      credentials: "omit",
    });
    expect(getCachedClockSkewSec()).toBeGreaterThan(500);

    const ws2 = MockWebSocket.instances[1];
    ws2.triggerOpen();
    ws2.triggerMessage(buildBinaryFrame("Path:audio\r\n", new Uint8Array([9, 8, 7])));
    ws2.triggerMessage("Path:turn.end\r\n\r\n");

    const b64 = await promise;
    expect(b64).toBe(arrayBufferToBase64(new Uint8Array([9, 8, 7])));
  });

  it("synthesizeEdgeTts KHÔNG retry khi đã nhận được byte audio rồi mới mất kết nối", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = synthesizeEdgeTts({
      text: "Đứt kết nối giữa chừng",
      voice: "vi-VN-HoaiMyNeural",
      rate: "+0%",
    });

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    ws.triggerMessage(buildBinaryFrame("Path:audio\r\n", new Uint8Array([1, 2, 3])));
    ws.triggerClose(1006, "Dropped mid-stream");

    await expect(promise).rejects.toThrow(/code 1006/);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
