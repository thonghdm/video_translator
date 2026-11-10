/**
 * SubTrans Extension — DeepL Translation Engine
 * Phù hợp với Mục 1 và Phase G1 của PLAN-deepl.md
 */

import { apiFetch, createTimeoutSignal } from "./http";
import {
  RateLimitedError,
  DisabledError,
  InvalidResponseIdsError,
  CanceledError,
  NetworkError,
  DeepLQuotaError,
} from "./errors";
import { sanitizeApiKey } from "./gemini";

export const DEEPL_MAX_TEXTS = 50;
export const DEEPL_MAX_BODY_BYTES = 120 * 1024; // 120 KiB
export const DEEPL_TIMEOUT_MS = 8000;
export const DEEPL_SEND_MODEL_TYPE = false; // Theo kết quả G0-3 (status 400 trên Free key)

/**
 * Xác định Base URL của DeepL dựa trên hậu tố của API Key.
 * Key kết thúc bằng ":fx" thuộc gói DeepL API Free, ngược lại là Pro.
 */
export function deeplBaseUrl(apiKey: string): string {
  const trimmed = apiKey ? apiKey.trim() : "";
  return trimmed.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com";
}

/**
 * Chuẩn hóa mã ngôn ngữ nguồn cho DeepL.
 * "auto" hoặc chuỗi rỗng -> undefined (không gửi source_lang).
 * Ngôn ngữ khác: viết HOA, cắt phần vùng (ví dụ "en-US" -> "EN").
 */
export function toDeepLSourceLang(srcLang: string): string | undefined {
  const trimmed = srcLang ? srcLang.trim() : "";
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    return undefined;
  }
  const langOnly = trimmed.split(/[-_]/)[0];
  return langOnly ? langOnly.toUpperCase() : undefined;
}

/**
 * Chia danh sách dòng thành các lô thỏa mãn đồng thời:
 * - Tối đa DEEPL_MAX_TEXTS (50) phần tử mỗi lô.
 * - Kích thước JSON body ước tính <= DEEPL_MAX_BODY_BYTES (120 KiB).
 */
export function chunkForDeepL(lines: string[]): string[][] {
  if (lines.length === 0) return [];
  const encoder = new TextEncoder();
  const chunks: string[][] = [];
  let currentChunk: string[] = [];

  const estimateBodyBytes = (texts: string[]): number => {
    const payload: Record<string, unknown> = {
      text: texts,
      target_lang: "VI",
      split_sentences: "nonewlines",
      preserve_formatting: true,
      source_lang: "EN",
    };
    if (DEEPL_SEND_MODEL_TYPE) {
      payload.model_type = "quality_optimized";
    }
    return encoder.encode(JSON.stringify(payload)).length;
  };

  for (const line of lines) {
    if (currentChunk.length === 0) {
      currentChunk.push(line);
      continue;
    }

    if (currentChunk.length >= DEEPL_MAX_TEXTS) {
      chunks.push(currentChunk);
      currentChunk = [line];
      continue;
    }

    const candidate = [...currentChunk, line];
    if (estimateBodyBytes(candidate) <= DEEPL_MAX_BODY_BYTES) {
      currentChunk = candidate;
    } else {
      chunks.push(currentChunk);
      currentChunk = [line];
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks;
}

export class DeepLEngine {
  private apiKey: string;
  private readonly fetchFn?: typeof fetch;

  constructor(cfg: { apiKey: string }, fetchFn?: typeof fetch) {
    this.apiKey = (cfg.apiKey || "").trim();
    this.fetchFn = fetchFn;
  }

  public updateKey(apiKey: string): void {
    this.apiKey = (apiKey || "").trim();
  }

  public hasKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Dịch danh sách các dòng văn bản sang tiếng Việt.
   * Dòng rỗng / chỉ khoảng trắng không gửi lên DeepL và trả về "" đúng vị trí.
   * Chia lô theo chunkForDeepL, gọi tuần tự, trả về mảng kết quả đủ lines.length phần tử.
   */
  public async translateLines(
    lines: string[],
    srcLang: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (!this.hasKey()) {
      throw new DisabledError("DeepL: key không hợp lệ hoặc chưa cấu hình");
    }

    if (signal?.aborted) {
      throw new CanceledError("DeepL operation canceled");
    }

    if (lines.length === 0) {
      return [];
    }

    const results: string[] = new Array(lines.length).fill("");
    const nonEmpties: { index: number; text: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw && raw.trim().length > 0) {
        nonEmpties.push({ index: i, text: raw });
      }
    }

    if (nonEmpties.length === 0) {
      return results;
    }

    const chunks = chunkForDeepL(nonEmpties.map((item) => item.text));
    const translatedTexts: string[] = [];

    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw new CanceledError("DeepL operation canceled");
      }

      const chunkResults = await this.doTranslateChunk(chunk, srcLang, signal);
      translatedTexts.push(...chunkResults);
    }

    for (let j = 0; j < nonEmpties.length; j++) {
      results[nonEmpties[j].index] = translatedTexts[j] ?? "";
    }

    return results;
  }

  private async fetchWithOmit(
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> {
    const enforcedInit: RequestInit = {
      ...init,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    };
    if (this.fetchFn) {
      return this.fetchFn(input, enforcedInit);
    }
    return apiFetch(input, init);
  }

  private async doTranslateChunk(
    chunk: string[],
    srcLang: string,
    callerSignal?: AbortSignal
  ): Promise<string[]> {
    const { signal, cleanup } = createTimeoutSignal(DEEPL_TIMEOUT_MS, callerSignal);

    try {
      const url = `${deeplBaseUrl(this.apiKey)}/v2/translate`;
      const sourceLang = toDeepLSourceLang(srcLang);
      const bodyObj: Record<string, unknown> = {
        text: chunk,
        target_lang: "VI",
        split_sentences: "nonewlines",
        preserve_formatting: true,
        ...(sourceLang ? { source_lang: sourceLang } : {}),
        ...(DEEPL_SEND_MODEL_TYPE ? { model_type: "quality_optimized" } : {}),
      };

      const headers: Record<string, string> = {
        "Authorization": `DeepL-Auth-Key ${this.apiKey}`,
        "Content-Type": "application/json",
      };

      let res: Response;
      try {
        res = await this.fetchWithOmit(url, {
          method: "POST",
          headers,
          body: JSON.stringify(bodyObj),
          signal,
        });
      } catch (fetchErr: unknown) {
        if (signal.aborted) {
          if (callerSignal?.aborted) {
            throw new CanceledError("DeepL request canceled by caller");
          }
          throw new Error(`DeepL request timed out after ${DEEPL_TIMEOUT_MS}ms`);
        }
        throw new NetworkError(
          sanitizeApiKey(
            `DeepL network failure: ${(fetchErr as Error)?.message || fetchErr}`,
            this.apiKey
          )
        );
      }

      if (res.status === 429) {
        let retryAfterMs = 5000;
        const retryHeader = res.headers.get("retry-after") || res.headers.get("Retry-After");
        if (retryHeader) {
          const sec = parseInt(retryHeader, 10);
          if (!isNaN(sec) && sec > 0) {
            retryAfterMs = sec * 1000;
          } else {
            const parsedDate = Date.parse(retryHeader);
            if (!isNaN(parsedDate) && parsedDate > Date.now()) {
              retryAfterMs = parsedDate - Date.now();
            }
          }
        }
        throw new RateLimitedError(
          sanitizeApiKey(`DeepL rate limited (429)`, this.apiKey),
          retryAfterMs
        );
      }

      if (res.status === 456) {
        throw new DeepLQuotaError(
          sanitizeApiKey("DeepL quota exceeded (456)", this.apiKey)
        );
      }

      if (res.status === 401 || res.status === 403) {
        throw new DisabledError(
          sanitizeApiKey(`DeepL: key không hợp lệ (HTTP ${res.status})`, this.apiKey)
        );
      }

      if (
        res.status === 400 ||
        res.status === 413 ||
        res.status === 529 ||
        res.status >= 500 ||
        !res.ok
      ) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          sanitizeApiKey(
            `DeepL HTTP ${res.status}${errText ? `: ${errText}` : ""}`,
            this.apiKey
          )
        );
      }

      let data: { translations?: Array<{ text?: string }> };
      try {
        data = (await res.json()) as { translations?: Array<{ text?: string }> };
      } catch (jsonErr) {
        throw new InvalidResponseIdsError(
          sanitizeApiKey(
            `DeepL invalid JSON response: ${(jsonErr as Error)?.message || jsonErr}`,
            this.apiKey
          )
        );
      }

      if (!data || !Array.isArray(data.translations) || data.translations.length !== chunk.length) {
        throw new InvalidResponseIdsError(
          `DeepL response translation count mismatch: expected ${chunk.length}, got ${data?.translations?.length ?? 0}`
        );
      }

      return data.translations.map((t) => t.text ?? "");
    } finally {
      cleanup();
    }
  }

  /**
   * Kiểm tra kết nối với DeepL: gọi GET /v2/usage để lấy thông tin hạn mức,
   * sau đó dịch 1 câu "Hello world" để đo độ trễ và lấy mẫu kết quả.
   */
  public static async testConnection(
    apiKey: string,
    fetchFn?: typeof fetch
  ): Promise<
    | { ok: true; latencyMs: number; used: number; limit: number; sample: string }
    | { ok: false; error: string }
  > {
    const cleanKey = (apiKey || "").trim();
    if (!cleanKey) {
      return { ok: false, error: "DeepL API key không được để trống" };
    }

    const start = performance.now();
    const baseUrl = deeplBaseUrl(cleanKey);

    const doFetch = async (
      input: RequestInfo | URL,
      init: RequestInit = {}
    ): Promise<Response> => {
      const enforcedInit: RequestInit = {
        ...init,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      };
      return fetchFn ? fetchFn(input, enforcedInit) : apiFetch(input, init);
    };

    try {
      // 1. Kiểm tra usage
      const usageUrl = `${baseUrl}/v2/usage`;
      const usageRes = await doFetch(usageUrl, {
        method: "GET",
        headers: {
          "Authorization": `DeepL-Auth-Key ${cleanKey}`,
        },
      });

      if (usageRes.status === 401 || usageRes.status === 403) {
        return {
          ok: false,
          error: sanitizeApiKey(
            `DeepL: key không hợp lệ (HTTP ${usageRes.status})`,
            cleanKey
          ),
        };
      }

      if (!usageRes.ok) {
        const errText = await usageRes.text().catch(() => "");
        return {
          ok: false,
          error: sanitizeApiKey(
            `DeepL usage HTTP ${usageRes.status}${errText ? `: ${errText}` : ""}`,
            cleanKey
          ),
        };
      }

      const usageData = (await usageRes.json()) as {
        character_count?: number;
        character_limit?: number;
      };
      const used = usageData.character_count ?? 0;
      const limit = usageData.character_limit ?? 0;

      // 2. Dịch thử một câu mẫu
      const engine = new DeepLEngine({ apiKey: cleanKey }, fetchFn);
      const sampleResults = await engine.translateLines(["Hello world"], "en");
      const sample = sampleResults[0] ?? "";
      const latencyMs = Math.round(performance.now() - start);

      return { ok: true, latencyMs, used, limit, sample };
    } catch (err: unknown) {
      return {
        ok: false,
        error: sanitizeApiKey((err as Error)?.message || String(err), cleanKey),
      };
    }
  }
}
