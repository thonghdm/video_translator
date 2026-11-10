/**
 * SubTrans Extension — Bộ định tuyến dịch thuật phân tầng (Translation Router)
 * Port từ translateWithTiers / TranslateBatch trong translator.go (bỏ tầng local_ai).
 *
 * Quy tắc giữ nguyên như Go:
 * - Tầng lỗi → ghi lastError, chuyển tầng tiếp theo.
 * - GTX lỗi MẠNG → bỏ qua cloud (cả 2 cùng cần mạng) → trả lỗi network ngay.
 * - Tầng fillGaps=false chạy KHÔNG lỗi → dừng (không đánh thức tầng sau vì dòng rỗng).
 * - Bị hủy → dừng ngay, không chuyển tầng.
 * Bổ sung cho extension:
 * - Có tầng cloud hay không chỉ phụ thuộc việc ĐÃ CÓ KEY (Go: Enabled && APIKey != ""), không phụ thuộc
 *   bucket còn token lúc gọi — để chế độ "gemini" không lặng lẽ rơi về GTX khi bucket tạm cạn.
 * - Breaker GTX đang khóa → lastError = RateLimitedError(retryAfterMs) để content biết tạm nghỉ.
 * - Cache cụm từ tra theo engine của TẦNG ĐẦU; "upgrade" chỉ tra "cloud" (nếu không sẽ trúng bản GTX).
 */

import type { EngineError, EngineId, LineResult, Priority, TranslateMode } from "../shared/types";
import type { LRUCache } from "../shared/lru";
import { isIgnoredSubtitle, normalizeLine } from "../shared/text";
import {
  classifyErr,
  retryAfterOf,
  CanceledError,
  DisabledError,
  RateLimitedError,
  NetworkError,
  errToBreakerOutcome,
} from "./engines/errors";
import { googleBatchOrPerLine, type GtxQueue } from "./engines/gtx";
import type { GeminiEngine } from "./engines/gemini";
import type { DeepLEngine } from "./engines/deepl";
import { type CircuitBreaker, OUTCOME_OK } from "../shared/breaker";

export interface TranslateOptions {
  lines: string[];
  srcLang?: string;
  priority: Priority;
  prefer?: EngineId;
  signal?: AbortSignal;
}

export interface RouterConfig {
  mode: TranslateMode;
  geminiModel: string;
  gtxTimeoutMs?: number;
}

export interface TierDef {
  id: EngineId;
  fillGaps: boolean;
}

export interface TranslateOutput {
  results: LineResult[];
  error?: EngineError;
}

/** Thứ tự tầng theo mode/priority (PLAN Phase 2, bảng router). Hàm thuần để test. */
export function planTiers(
  mode: TranslateMode,
  priority: Priority,
  hasGeminiKey: boolean,
  prefer?: EngineId
): TierDef[] {
  const api: TierDef = { id: "api", fillGaps: false };
  const cloud: TierDef = { id: "cloud", fillGaps: true };
  let tiers: TierDef[];

  if (priority === "upgrade") {
    tiers = hasGeminiKey ? [{ id: "cloud", fillGaps: false }] : [];
  } else if (mode === "gemini" || (mode === "hybrid" && priority === "tier2")) {
    tiers = hasGeminiKey ? [cloud, api] : [api];
  } else {
    // "google", hoặc hybrid tier1
    tiers = hasGeminiKey ? [api, cloud] : [api];
  }

  if (prefer && priority !== "upgrade") {
    const idx = tiers.findIndex((t) => t.id === prefer);
    if (idx > 0) {
      const [t] = tiers.splice(idx, 1);
      tiers.unshift(t);
    }
  }
  return tiers;
}

export class TranslationRouter {
  constructor(
    private config: RouterConfig,
    private phraseCache: LRUCache<string, string>,
    private gtxBreaker: CircuitBreaker,
    private gtxQueue: GtxQueue,
    private geminiEngine: GeminiEngine,
    private deepl?: {
      engine: DeepLEngine;
      breaker: CircuitBreaker;
      queue: GtxQueue;
      getPrefs: () => { enabled: boolean; prefer: boolean };
    }
  ) {}

  public updateConfig(newConfig: Partial<RouterConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /** Xóa cache cụm từ trong RAM (đi kèm "Xóa cache" ở Options, để lần dịch sau gọi API thật) */
  public clearPhraseCache(): void {
    this.phraseCache.clear();
  }

  public async translate(options: TranslateOptions): Promise<TranslateOutput> {
    const { lines, srcLang = "auto", priority, prefer, signal } = options;
    const isTier1 = priority === "tier1";
    const results: LineResult[] = lines.map(() => ({ text: "", engine: null }));
    if (lines.length === 0) return { results };

    const tiers = planTiers(this.config.mode, priority, this.geminiEngine.hasKey(), prefer);
    if (tiers.length === 0) {
      return {
        results,
        error: { kind: "disabled", message: "Chưa cấu hình Gemini API key (upgrade cần Gemini)" },
      };
    }

    // 1. Tiền xử lý: chuẩn hoá khoảng trắng, lọc tiếng động/nốt nhạc, tra cache của TẦNG ĐẦU
    const cacheEngine = tiers[0].id;
    const todoIndices: number[] = [];
    const todoLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const normalized = normalizeLine(lines[i]);
      if (!normalized || isIgnoredSubtitle(normalized)) continue;
      const cached = this.phraseCache.get(`${cacheEngine}|${normalized}`);
      if (cached) {
        results[i] = { text: cached, engine: cacheEngine };
        continue;
      }
      todoIndices.push(i);
      todoLines.push(normalized);
    }
    if (todoLines.length === 0) return { results };

    let pending = todoLines.map((_, k) => k);
    let skipCloud = false;
    let lastError: unknown = null;

    // 2. Chạy qua từng tầng
    for (const tier of tiers) {
      if (pending.length === 0) break;
      if (signal?.aborted) throw new CanceledError();
      if (tier.id === "cloud" && skipCloud) continue;

      const input = pending.map((k) => todoLines[k]);
      let out: string[];
      try {
        out =
          tier.id === "api"
            ? await this.viaMachine(input, srcLang, isTier1, signal)
            : await this.viaGemini(input, pending, todoLines, isTier1, signal);
      } catch (err) {
        if (err instanceof CanceledError || signal?.aborted) {
          throw err instanceof CanceledError ? err : new CanceledError();
        }
        lastError = err;
        if (tier.id === "api" && classifyErr(err) === "network") {
          skipCloud = true;
          break; // extension không còn tầng local_ai
        }
        continue;
      }

      const remaining: number[] = [];
      for (let j = 0; j < pending.length; j++) {
        const k = pending[j];
        const text = out[j]?.trim();
        if (text) {
          results[todoIndices[k]] = { text, engine: tier.id };
          this.phraseCache.set(`${tier.id}|${todoLines[k]}`, text);
        } else if (tier.fillGaps) {
          remaining.push(k);
        }
      }
      if (!tier.fillGaps) {
        pending = [];
        break;
      }
      pending = remaining;
    }

    const anyTranslated = todoIndices.some((i) => results[i].text !== "");
    if (!anyTranslated && lastError) {
      return {
        results,
        error: {
          kind: classifyErr(lastError),
          message: (lastError as Error)?.message || String(lastError),
          retryAfterMs: retryAfterOf(lastError),
        },
      };
    }
    return { results };
  }

  // ---------------------------------------------------------------------------

  private async viaMachine(
    lines: string[],
    srcLang: string,
    isTier1: boolean,
    signal?: AbortSignal
  ): Promise<string[]> {
    const hasDeepl = Boolean(
      this.deepl &&
      this.deepl.engine.hasKey() &&
      this.deepl.getPrefs().enabled
    );

    const preferDeepl = Boolean(hasDeepl && this.deepl!.getPrefs().prefer);

    const engines: Array<"gtx" | "deepl"> = [];
    if (hasDeepl) {
      if (preferDeepl) {
        engines.push("deepl", "gtx");
      } else {
        engines.push("gtx", "deepl");
      }
    } else {
      engines.push("gtx");
    }

    const errors: unknown[] = [];

    for (const eng of engines) {
      if (signal?.aborted) {
        throw new CanceledError();
      }
      try {
        if (eng === "gtx") {
          return await this.callGtx(lines, srcLang, isTier1, signal);
        } else {
          return await this.callDeepL(lines, srcLang, isTier1, signal);
        }
      } catch (err) {
        if (err instanceof CanceledError || signal?.aborted) {
          throw err instanceof CanceledError ? err : new CanceledError();
        }
        if (err instanceof NetworkError) {
          throw err;
        }
        errors.push(err);
      }
    }

    // Tất cả đều lỗi. Chọn lỗi "ít chặn nhất" để content không tạm nghỉ quá lâu:
    // - Bỏ DisabledError (key DeepL sai/thiếu là chuyện cấu hình của engine dự phòng, không nói gì về việc dịch).
    // - Còn lỗi tạm thời không phải rate-limit (HTTP 5xx, timeout…) → ném nó: content thử lại sớm, thay vì
    //   tạm nghỉ theo retryAfter của engine kia (vd DeepL hết hạn mức tháng = 6 giờ).
    // - Toàn rate-limit → retryAfterMs NHỎ NHẤT.
    const informative = errors.filter((e) => !(e instanceof DisabledError));
    if (informative.length === 0) throw errors[0];
    const transient = informative.find((e) => !(e instanceof RateLimitedError));
    if (transient !== undefined) throw transient;
    const rateLimitedErrors = informative as RateLimitedError[];
    let best = rateLimitedErrors[0];
    let minMs = best.retryAfterMs ?? Infinity;
    for (let i = 1; i < rateLimitedErrors.length; i++) {
      const ms = rateLimitedErrors[i].retryAfterMs ?? Infinity;
      if (ms < minMs) {
        minMs = ms;
        best = rateLimitedErrors[i];
      }
    }
    throw best;
  }

  private async callGtx(
    lines: string[],
    srcLang: string,
    isTier1: boolean,
    signal?: AbortSignal
  ): Promise<string[]> {
    // Chờ chỗ trong hàng đợi TRƯỚC, rồi mới xin quyền breaker ngay trước khi gọi HTTP
    // (không giữ cờ probe half-open trong lúc xếp hàng).
    return this.gtxQueue.run(
      async () => {
        const { allowed, isProbe } = this.gtxBreaker.allow();
        if (!allowed) {
          const until = this.gtxBreaker.getBlockedUntil();
          throw new RateLimitedError(
            "GTX circuit breaker is open",
            until > 0 ? Math.max(0, until - Date.now()) : undefined
          );
        }
        try {
          const out = await googleBatchOrPerLine(
            lines,
            srcLang,
            signal,
            this.phraseCache,
            this.config.gtxTimeoutMs ?? 5000
          );
          this.gtxBreaker.report(OUTCOME_OK, isProbe);
          return out; // luôn đủ lines.length phần tử (batch khớp, hoặc dịch từng dòng)
        } catch (err) {
          this.gtxBreaker.report(errToBreakerOutcome(err), isProbe);
          throw err;
        }
      },
      isTier1,
      signal
    );
  }

  private async callDeepL(
    lines: string[],
    srcLang: string,
    isTier1: boolean,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (!this.deepl) {
      throw new DisabledError("DeepL engine not configured");
    }
    const { engine, breaker, queue } = this.deepl;
    return queue.run(
      async () => {
        const { allowed, isProbe } = breaker.allow();
        if (!allowed) {
          const until = breaker.getBlockedUntil();
          throw new RateLimitedError(
            "DeepL circuit breaker is open",
            until > 0 ? Math.max(0, until - Date.now()) : undefined
          );
        }
        try {
          const out = await engine.translateLines(lines, srcLang, signal);
          breaker.report(OUTCOME_OK, isProbe);
          return out;
        } catch (err) {
          if (!(err instanceof DisabledError)) {
            breaker.report(errToBreakerOutcome(err), isProbe);
          } else if (isProbe) {
            // Key sai không phải lỗi tạm thời của DeepL → không phạt breaker, NHƯNG phải trả lượt probe
            // half-open (report "canceled" = giải phóng cờ probing, không đổi trạng thái); nếu không,
            // breaker kẹt half-open mãi và DeepL bị khóa tới khi service worker khởi động lại.
            breaker.report({ kind: "canceled" }, true);
          }
          throw err;
        }
      },
      isTier1,
      signal
    );
  }

  private viaGemini(
    input: string[],
    pending: number[],
    todoLines: string[],
    isTier1: boolean,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (!this.geminiEngine.hasKey()) {
      return Promise.reject(new DisabledError());
    }
    // Ngữ cảnh: 2 dòng ngay trước dòng đầu tiên cần dịch (nếu có trong batch)
    const first = pending[0];
    const context = first > 0 ? todoLines.slice(Math.max(0, first - 2), first) : [];
    return this.geminiEngine.translateLines(input, context, isTier1, signal);
  }
}
