/**
 * SubTrans Extension — Bộ định tuyến dịch thuật phân tầng (Translation Router)
 * Port từ translateWithTiers trong translator.go:512
 */

import type {
  EngineId,
  LineResult,
  Priority,
  TranslateMode,
} from "../shared/types";
import type { LRUCache } from "../shared/lru";
import { isIgnoredSubtitle, normalizeLine } from "../shared/text";
import { classifyErr, CanceledError, errToBreakerOutcome } from "./engines/errors";
import { googleBatchOrPerLine, GtxQueue } from "./engines/gtx";
import type { GeminiEngine } from "./engines/gemini";
import { CircuitBreaker, OUTCOME_OK } from "../shared/breaker";

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
}

interface TierDef {
  id: EngineId;
  fillGaps: boolean;
}

export class TranslationRouter {
  constructor(
    private config: RouterConfig,
    private phraseCache: LRUCache<string, string>,
    private gtxBreaker: CircuitBreaker,
    private gtxQueue: GtxQueue,
    private geminiEngine: GeminiEngine
  ) {}

  public updateConfig(newConfig: Partial<RouterConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Dịch danh sách các câu tiếng Anh sang tiếng Việt theo cơ chế phân tầng (tiers)
   * Port 1:1 từ translateWithTiers trong translator.go:512
   */
  public async translate(options: TranslateOptions): Promise<{
    results: LineResult[];
    error?: { kind: ReturnType<typeof classifyErr>; message: string; retryAfterMs?: number };
  }> {
    const { lines, srcLang = "auto", priority, prefer, signal } = options;
    const isTier1 = priority === "tier1";

    const results: LineResult[] = lines.map(() => ({
      text: "",
      engine: null,
    }));

    if (lines.length === 0) {
      return { results };
    }

    // 1. Tiền xử lý: chuẩn hoá khoảng trắng, lọc câu tiếng động/nốt nhạc, tra cứu cache
    const todoIndices: number[] = [];
    const todoLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const normalized = normalizeLine(raw);

      if (!normalized || isIgnoredSubtitle(normalized)) {
        results[i] = { text: "", engine: null };
        continue;
      }

      // Tra cứu LRU cache
      const preferredEngine = prefer || (this.config.mode === "gemini" ? "cloud" : "api");
      const cacheKey = `${preferredEngine}|${normalized}`;
      const cached = this.phraseCache.get(cacheKey);

      if (cached) {
        results[i] = { text: cached, engine: preferredEngine };
        continue;
      }

      todoIndices.push(i);
      todoLines.push(normalized);
    }

    if (todoLines.length === 0) {
      return { results };
    }

    // 2. Xác định danh sách các tầng dịch theo mode và priority (Mục 473 trong PLAN.md)
    const tiers: TierDef[] = [];
    const hasGeminiKey = this.geminiEngine.isAvailable();

    if (priority === "upgrade") {
      if (hasGeminiKey) {
        tiers.push({ id: "cloud", fillGaps: false });
      }
    } else if (this.config.mode === "google") {
      tiers.push({ id: "api", fillGaps: false });
      if (hasGeminiKey) {
        tiers.push({ id: "cloud", fillGaps: true });
      }
    } else if (this.config.mode === "gemini") {
      if (hasGeminiKey) {
        tiers.push({ id: "cloud", fillGaps: true });
      }
      tiers.push({ id: "api", fillGaps: false });
    } else {
      // mode === "hybrid"
      if (priority === "tier1") {
        tiers.push({ id: "api", fillGaps: false });
        if (hasGeminiKey) {
          tiers.push({ id: "cloud", fillGaps: true });
        }
      } else {
        // tier2
        if (hasGeminiKey) {
          tiers.push({ id: "cloud", fillGaps: true });
        }
        tiers.push({ id: "api", fillGaps: false });
      }
    }

    // Nếu prefer được chỉ định, đảo ưu tiên tầng đó lên đầu
    if (prefer) {
      const idx = tiers.findIndex((t) => t.id === prefer);
      if (idx > 0) {
        const [target] = tiers.splice(idx, 1);
        tiers.unshift(target);
      }
    }

    let pendingIndices = [...Array(todoLines.length).keys()];
    let skipCloud = false;
    let lastError: unknown = null;

    // 3. Thực thi qua từng tầng (Tier Loop)
    for (const tier of tiers) {
      if (pendingIndices.length === 0) {
        break;
      }
      if (signal?.aborted) {
        throw new CanceledError();
      }
      if (tier.id === "cloud" && skipCloud) {
        continue;
      }

      const pendingLines = pendingIndices.map((pIdx) => todoLines[pIdx]);
      let translated: string[] = [];

      try {
        if (tier.id === "api") {
          // Kiểm tra Breaker GTX
          const { allowed, isProbe } = this.gtxBreaker.allow();
          if (!allowed) {
            continue;
          }

          try {
            translated = await this.gtxQueue.run(
              () =>
                googleBatchOrPerLine(
                  pendingLines,
                  srcLang,
                  signal,
                  this.phraseCache
                ),
              isTier1,
              signal
            );
            this.gtxBreaker.report(OUTCOME_OK, isProbe);
          } catch (apiErr) {
            this.gtxBreaker.report(errToBreakerOutcome(apiErr), isProbe);
            throw apiErr;
          }
        } else {
          // tier.id === "cloud"
          // Ngữ cảnh: lấy 2 dòng trước đó từ todoLines (nếu có)
          const context =
            pendingIndices[0] > 0
              ? todoLines.slice(
                  Math.max(0, pendingIndices[0] - 2),
                  pendingIndices[0]
                )
              : [];

          translated = await this.geminiEngine.translateLines(
            pendingLines,
            context,
            isTier1,
            signal
          );
        }
      } catch (tierErr: unknown) {
        lastError = tierErr;

        // Quan trọng: nếu bị canceled thì dừng ngay, tuyệt đối không chuyển tầng
        if (
          tierErr instanceof CanceledError ||
          signal?.aborted ||
          classifyErr(tierErr) === "canceled"
        ) {
          throw tierErr;
        }

        // Nếu GTX lỗi kiểu network (mất mạng Internet) -> cả 2 đều cần mạng -> skip Cloud
        if (tier.id === "api" && classifyErr(tierErr) === "network") {
          skipCloud = true;
          // Không còn tầng local_ai trong Extension -> ném lỗi network ra ngay
          break;
        }

        continue;
      }

      // Xử lý kết quả trả về từ tầng
      const remaining: number[] = [];
      let successCount = 0;

      for (let j = 0; j < pendingIndices.length; j++) {
        const pIdx = pendingIndices[j];
        const origIdx = todoIndices[pIdx];
        const text = translated[j]?.trim();

        if (text) {
          results[origIdx] = { text, engine: tier.id };
          this.phraseCache.set(`${tier.id}|${todoLines[pIdx]}`, text);
          successCount++;
        } else if (tier.fillGaps) {
          remaining.push(pIdx);
        }
      }

      // Nếu tầng không cho phép fillGaps (fillGaps: false) và chạy thành công mà không có lỗi -> dừng
      if (!tier.fillGaps && successCount > 0) {
        break;
      }

      pendingIndices = remaining;
    }

    // Nếu không dịch được dòng nào và có lỗi -> trả về kèm error
    const anyTranslated = results.some((r) => r.text !== "");
    if (!anyTranslated && lastError) {
      const kind = classifyErr(lastError);
      return {
        results,
        error: {
          kind,
          message: (lastError as Error)?.message || String(lastError),
          retryAfterMs: (lastError as { retryAfterMs?: number })?.retryAfterMs,
        },
      };
    }

    return { results };
  }
}
