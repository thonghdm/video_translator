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

  // 1. Thử dịch batch ghép bằng \n
  try {
    const batchOut = await translateFastGtx(
      lines.join("\n"),
      srcLang,
      signal,
      timeoutMs
    );
    const parts = batchOut.split("\n");

    if (parts.length === lines.length) {
      let allValid = true;
      for (let i = 0; i < parts.length; i++) {
        parts[i] = parts[i].trim();
        if (parts[i] === "") {
          allValid = false;
          break;
        }
      }

      if (allValid) {
        if (phraseCache) {
          for (let i = 0; i < lines.length; i++) {
            phraseCache.set(`api|${lines[i]}`, parts[i]);
          }
        }
        return parts;
      }
    }
  } catch (batchErr) {
    // Nếu bị rate limited, canceled hoặc network error thì throw ngay, không thử dịch từng dòng
    if (
      batchErr instanceof RateLimitedError ||
      batchErr instanceof CanceledError ||
      batchErr instanceof NetworkError ||
      signal?.aborted
    ) {
      throw batchErr;
    }
  }

  // 2. Lệch dòng hoặc batch rỗng: dịch từng dòng có nhịp nghỉ (chống burst)
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
 * Hàng đợi giới hạn số request đồng thời và giãn cách giữa các lượt gọi GTX
 */
export class GtxQueue {
  private activeCount = 0;
  private lastStartTime = 0;
  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (val: unknown) => void;
    reject: (err: unknown) => void;
    isTier1: boolean;
    signal?: AbortSignal;
  }> = [];

  constructor(
    private concurrency = 2,
    private gapMs = 150
  ) {}

  public updateConfig(concurrency: number, gapMs: number): void {
    if (concurrency > 0) this.concurrency = concurrency;
    if (gapMs >= 0) this.gapMs = gapMs;
  }

  public run<T>(
    fn: () => Promise<T>,
    isTier1: boolean,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new CanceledError());
    }

    return new Promise<T>((resolve, reject) => {
      const item = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (val: unknown) => void,
        reject,
        isTier1,
        signal,
      };

      if (isTier1) {
        // Tier-1 được ưu tiên chen lên đầu các task Tier-2
        const firstTier2Idx = this.queue.findIndex((q) => !q.isTier1);
        if (firstTier2Idx >= 0) {
          this.queue.splice(firstTier2Idx, 0, item);
        } else {
          this.queue.push(item);
        }
      } else {
        this.queue.push(item);
      }

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    if (item.signal?.aborted) {
      item.reject(new CanceledError());
      this.processQueue();
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastStartTime;
    if (elapsed < this.gapMs) {
      await delay(this.gapMs - elapsed);
    }

    this.activeCount++;
    this.lastStartTime = Date.now();

    item
      .fn()
      .then((res) => item.resolve(res))
      .catch((err) => item.reject(err))
      .finally(() => {
        this.activeCount--;
        this.processQueue();
      });

    // Tiếp tục khởi động các slot đồng thời khác nếu còn
    this.processQueue();
  }
}
