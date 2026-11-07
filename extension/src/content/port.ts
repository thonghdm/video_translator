/**
 * SubTrans Extension — Kết nối Content Script ↔ Background (PLAN 4.3)
 * - Kết nối lười: chỉ mở Port khi có request đầu tiên (không mở Port ở mọi frame/trang).
 * - Tự kết nối lại khi Port ngắt (SW bị tắt/restart) với backoff 250ms → 1s → 3s,
 *   và GỬI LẠI mọi request chưa có kết quả (giữ nguyên reqId).
 * - Mỗi request có timeout (mặc định 30s).
 * - "Extension context invalidated" (extension bị reload/gỡ): từ chối mọi request, ngừng hẳn.
 */

import type { B2C, C2B } from "../shared/messages";

export interface PortLike {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

type ReqMsg = Extract<C2B, { reqId: string }>;
type StatusMsg = Extract<B2C, { type: "status" }>;

interface Pending {
  msg: ReqMsg;
  resolve: (value: B2C) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BackgroundPortOptions {
  timeoutMs?: number;
  backoffMs?: number[];
}

export class PortClosedError extends Error {
  constructor(message = "Extension context invalidated") {
    super(message);
    this.name = "PortClosedError";
  }
}

export function newReqId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaultConnect(): PortLike {
  return chrome.runtime.connect({ name: "subtrans" }) as unknown as PortLike;
}

export class BackgroundPort {
  private port: PortLike | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly statusListeners = new Set<(s: StatusMsg) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private dead = false;
  private readonly timeoutMs: number;
  private readonly backoffMs: number[];

  constructor(
    private readonly connectFn: () => PortLike = defaultConnect,
    opts: BackgroundPortOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.backoffMs = opts.backoffMs ?? [250, 1000, 3000];
  }

  /** Gửi request và chờ message trả lời có cùng reqId */
  public request<T extends B2C = B2C>(msg: ReqMsg): Promise<T> {
    if (this.dead) {
      return Promise.reject(new PortClosedError());
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.reqId);
        reject(new Error(`Hết thời gian chờ background (${this.timeoutMs}ms) cho ${msg.type}`));
      }, this.timeoutMs);
      this.pending.set(msg.reqId, {
        msg,
        resolve: resolve as (v: B2C) => void,
        reject,
        timer,
      });
      this.post(msg);
    });
  }

  /** Gửi message không cần trả lời (cancel, cache.saveLines...). Bỏ qua nếu không gửi được. */
  public send(msg: C2B): void {
    if (this.dead) return;
    this.post(msg);
  }

  /** Hủy một request đang chờ (và báo background hủy theo) */
  public cancel(reqId: string): void {
    const p = this.pending.get(reqId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(reqId);
      p.reject(new Error("canceled"));
    }
    this.send({ type: "cancel", reqId });
  }

  public onStatus(cb: (s: StatusMsg) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  public dispose(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failAll(new Error("disposed"));
    this.statusListeners.clear();
    const p = this.port;
    this.port = null;
    try {
      p?.disconnect();
    } catch {
      /* đã ngắt */
    }
    this.dead = true;
  }

  // ---------------------------------------------------------------------------

  private post(msg: C2B): void {
    const port = this.ensurePort();
    if (!port) return; // đang chờ kết nối lại; request trong pending sẽ được gửi lại
    try {
      port.postMessage(msg);
    } catch {
      // Port vừa ngắt giữa chừng: coi như disconnect, request sẽ được gửi lại
      this.handleDisconnect();
    }
  }

  private ensurePort(): PortLike | null {
    if (this.port) return this.port;
    if (this.dead || this.reconnectTimer) return null;
    try {
      const port = this.connectFn();
      port.onMessage.addListener((m) => this.handleMessage(m as B2C));
      port.onDisconnect.addListener(() => {
        if (this.port === port) this.handleDisconnect();
      });
      this.port = port;
      return port;
    } catch (err) {
      if (isContextInvalidated(err)) {
        this.dead = true;
        this.failAll(new PortClosedError());
        return null;
      }
      this.scheduleReconnect();
      return null;
    }
  }

  private handleMessage(msg: B2C): void {
    this.attempt = 0; // nhận được message = kết nối khỏe
    if (msg.type === "status") {
      for (const cb of this.statusListeners) {
        try {
          cb(msg);
        } catch {
          /* listener lỗi không làm hỏng port */
        }
      }
      return;
    }
    const reqId = (msg as { reqId?: string }).reqId;
    if (!reqId) return;
    const p = this.pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    p.resolve(msg);
  }

  private handleDisconnect(): void {
    // Đọc lastError để Chrome không in cảnh báo "Unchecked runtime.lastError"
    try {
      void (globalThis as { chrome?: typeof chrome }).chrome?.runtime?.lastError;
    } catch {
      /* bỏ qua */
    }
    this.port = null;
    if (this.pending.size > 0) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.dead || this.reconnectTimer) return;
    const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const port = this.ensurePort();
      if (!port) return;
      // Gửi lại toàn bộ request chưa có kết quả
      for (const p of this.pending.values()) {
        try {
          port.postMessage(p.msg);
        } catch {
          this.handleDisconnect();
          return;
        }
      }
    }, delay);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function isContextInvalidated(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /context invalidated/i.test(msg);
}
