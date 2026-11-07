/**
 * SubTrans Extension — Google GTX Translation Engine
 * Port 1:1 từ translateFastGTX và googleBatchOrPerLine trong translator.go:252
 */

import type { LRUCache } from "../../shared/lru";
import { apiFetch, createTimeoutSignal } from "./http";
import {
  RateLimitedError,
  EmptyTranslationError,
  CanceledError,
  NetworkError,
} from "./errors";

/**
 * Dịch một câu hoặc một khối văn bản đơn lẻ qua Google GTX
 * Port từ translateFastGTX trong translator.go:252
 */
export async function translateFastGtx(
  text: string,
  srcLang = "auto",
  callerSignal?: AbortSignal,
  timeoutMs = 5000
): Promise<string> {
  if (!text.trim()) {
    return "";
  }

  const { signal, cleanup } = createTimeoutSignal(timeoutMs, callerSignal);

  try {
    const sl = srcLang ? encodeURIComponent(srcLang) : "auto";
    const q = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=vi&dt=t&q=${q}`;

    let res: Response;
    try {
      res = await apiFetch(url, { method: "GET", signal });
    } catch (fetchErr: unknown) {
      if (signal.aborted) {
        if (callerSignal?.aborted) {
          throw new CanceledError("Request aborted by caller");
        }
        throw new Error(`GTX request timed out after ${timeoutMs}ms`);
      }
      throw new NetworkError(
        `GTX network failure: ${(fetchErr as Error)?.message || fetchErr}`
      );
    }

    if (res.status === 429 || res.status === 403 || res.status === 503) {
      throw new RateLimitedError(`GTX HTTP ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(`GTX HTTP ${res.status}`);
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (jsonErr) {
      // Body không phải JSON coi như bị rate limit hoặc trang chặn/CAPTCHA
      throw new RateLimitedError(`GTX non-JSON response: ${jsonErr}`);
    }

    if (!Array.isArray(raw) || raw.length === 0 || !Array.isArray(raw[0])) {
      throw new Error("GTX invalid response structure");
    }

    const sentences = raw[0] as Array<unknown>;
    let result = "";
    for (const s of sentences) {
      if (Array.isArray(s) && s.length > 0 && typeof s[0] === "string") {
        result += s[0];
      }
    }

    return result.trim();
  } finally {
    cleanup();
  }
}

function randomJitter(baseMs: number, jitterMs = 15): number {
  const delta = (Math.random() * 2 - 1) * jitterMs;
  return Math.max(10, Math.round(baseMs + delta));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new CanceledError("Aborted during pause"));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new CanceledError("Aborted during pause"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Dịch theo batch các câu qua GTX. Nếu số dòng trả về bị lệch, tự động chuyển sang dịch từng dòng
 * kèm nhịp nghỉ (jitter 60ms) để chống burst/bị chặn.
 * Port 1:1 từ googleBatchOrPerLine trong translator.go:340
 */
export async function googleBatchOrPerLine(
  lines: string[],
  srcLang = "auto",
  signal?: AbortSignal,
  phraseCache?: LRUCache<string, string>,
  timeoutMs = 5000
): Promise<string[]> {
  if (lines.length === 0) {
    return [];
  }

  // 1. Dịch batch ghép bằng \n. Lỗi bất kỳ → trả về ngay (Go: `if err != nil { return nil, err }`).
  //    Chỉ khi batch THÀNH CÔNG nhưng lệch số dòng/có dòng rỗng mới chuyển sang dịch từng dòng.
  const batchOut = await translateFastGtx(lines.join("\n"), srcLang, signal, timeoutMs);
  const parts = batchOut.split("\n").map((p) => p.trim());
  if (parts.length === lines.length && parts.every((p) => p !== "")) {
    if (phraseCache) {
      for (let i = 0; i < lines.length; i++) {
        phraseCache.set(`api|${lines[i]}`, parts[i]);
      }
    }
    return parts;
  }

  // 2. Lệch dòng: dịch từng dòng có nhịp nghỉ (chống burst).
  //    Dòng đã có cache thì dùng luôn (không tốn HTTP, không nghỉ); lưu cache ngay từng dòng.
  const out: string[] = new Array(lines.length).fill("");
  let needPause = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (phraseCache) {
      const cached = phraseCache.get(`api|${line}`);
      if (cached) {
        out[i] = cached;
        continue;
      }
    }

    if (needPause) {
      await delay(randomJitter(60, 15), signal);
    }
    if (signal?.aborted) {
      throw new CanceledError();
    }

    const s = await translateFastGtx(line, srcLang, signal, timeoutMs);
    if (!s) {
      throw new EmptyTranslationError(`Dòng ${i} dịch ra kết quả rỗng`);
    }

    out[i] = s;
    if (phraseCache) {
      phraseCache.set(`api|${line}`, s);
    }
    needPause = true;
  }

  return out;
}

/**
 * Hàng đợi GTX dùng chung toàn service worker:
 * - Tối đa `concurrency` request chạy cùng lúc (giữ chỗ TRƯỚC khi chờ giãn cách → không vượt giới hạn).
 * - Giữa 2 lần bắt đầu request cách nhau ít nhất `gapMs`.
 * - Tier-1 chen lên trước mọi task Tier-2 còn trong hàng đợi.
 * - Task bị abort khi còn trong hàng đợi → bị loại ngay (CanceledError), không chiếm chỗ.
 * Chỉ MỘT vòng bơm (pump) được lấy task ra khỏi hàng đợi tại một thời điểm.
 */
interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (val: unknown) => void;
  reject: (err: unknown) => void;
  isTier1: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class GtxQueue {
  private active = 0;
  private lastStartTime = 0;
  private pumping = false;
  private readonly queue: QueueItem[] = [];

  constructor(
    private concurrency = 2,
    private gapMs = 150
  ) {}

  public updateConfig(concurrency: number, gapMs: number): void {
    if (concurrency > 0) this.concurrency = concurrency;
    if (gapMs >= 0) this.gapMs = gapMs;
    void this.pump();
  }

  public get activeCount(): number {
    return this.active;
  }

  public get queuedCount(): number {
    return this.queue.length;
  }

  public run<T>(fn: () => Promise<T>, isTier1: boolean, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new CanceledError());
    }
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (val: unknown) => void,
        reject,
        isTier1,
        signal,
      };
      if (signal) {
        item.onAbort = () => {
          const idx = this.queue.indexOf(item);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new CanceledError());
          }
        };
        signal.addEventListener("abort", item.onAbort, { once: true });
      }
      if (isTier1) {
        const firstTier2 = this.queue.findIndex((q) => !q.isTier1);
        if (firstTier2 >= 0) this.queue.splice(firstTier2, 0, item);
        else this.queue.push(item);
      } else {
        this.queue.push(item);
      }
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.active < this.concurrency) {
        // Giữ chỗ trước khi chờ giãn cách để không task nào khác vượt giới hạn
        this.active++;
        const wait = this.lastStartTime + this.gapMs - Date.now();
        if (wait > 0) {
          await delay(wait);
        }
        // Lấy task SAU khi chờ: Tier-1 đến trong lúc chờ vẫn được ưu tiên
        const item = this.queue.shift();
        if (!item) {
          this.active--;
          break;
        }
        if (item.signal && item.onAbort) {
          item.signal.removeEventListener("abort", item.onAbort);
        }
        if (item.signal?.aborted) {
          this.active--;
          item.reject(new CanceledError());
          continue;
        }
        this.lastStartTime = Date.now();
        item
          .fn()
          .then(item.resolve, item.reject)
          .finally(() => {
            this.active--;
            void this.pump();
          });
      }
    } finally {
      this.pumping = false;
    }
  }
}
