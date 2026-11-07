/**
 * SubTrans Extension — Gemini Cloud Translation Engine
 * Port 1:1 từ gemini.go
 */

import { CircuitBreaker, OUTCOME_OK } from "../../shared/breaker";
import type { TokenBucket } from "../../shared/tokenBucket";
import { apiFetch, createTimeoutSignal } from "./http";
import {
  RateLimitedError,
  DisabledError,
  InvalidResponseIdsError,
  CanceledError,
  NetworkError,
  errToBreakerOutcome,
} from "./errors";

const SYSTEM_INSTRUCTION =
  "Bạn là chuyên gia dịch phụ đề khóa học lập trình. Dịch các câu tiếng Anh sang tiếng Việt, giữ nguyên các thuật ngữ kỹ thuật trong ngành lập trình, không thêm bớt nội dung ngoài câu gốc. Các dòng đánh dấu [CONTEXT - KHÔNG DỊCH] chỉ dùng để hiểu ngữ cảnh, tuyệt đối không dịch và không trả về ID của chúng.";

export interface GeminiConfig {
  apiKey: string;
  model: string;
  endpoint: string;
  timeoutTier1Ms: number;
  timeoutTier2Ms: number;
  maxItemsTier1: number;
  maxItemsTier2: number;
}

export interface GeminiItem {
  id: number;
  text: string;
}

export interface GeminiResponseItem {
  id: number;
  vi: string;
}

export function sanitizeApiKey(msg: string, apiKey?: string): string {
  if (apiKey && apiKey.length > 5 && msg.includes(apiKey)) {
    return msg.split(apiKey).join("[REDACTED_API_KEY]");
  }
  return msg;
}

/**
 * Loại bỏ wrapper Markdown (```json ... ```) và lấy chuỗi từ '[' đầu tiên tới ']' cuối cùng
 * Port từ cleanJSONText trong gemini.go:591
 */
export function cleanJSONText(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```json")) {
    s = s.slice(7);
  } else if (s.startsWith("```")) {
    s = s.slice(3);
  }
  if (s.endsWith("```")) {
    s = s.slice(0, -3);
  }
  s = s.trim();

  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    return s.slice(start, end + 1);
  }
  return s;
}

/**
 * Phân tích header Retry-After thành milliseconds
 * Port từ parseRetryAfter trong gemini.go:612
 */
export function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = h.trim();
  const secs = parseInt(s, 10);
  if (!isNaN(secs) && secs > 0) {
    return secs * 1000;
  }
  const date = Date.parse(s);
  if (!isNaN(date)) {
    const diff = date - Date.now();
    return diff > 0 ? diff : undefined;
  }
  return undefined;
}

/**
 * Trích xuất retryDelay từ payload body JSON lỗi của Google (vd: "retryDelay": "16s")
 * Port từ parseRetryDelayFromBody trong gemini.go:634
 */
export function parseRetryDelayFromBody(bodyText: string): number | undefined {
  const match = bodyText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?s)"/);
  if (match && match[1]) {
    const secs = parseFloat(match[1].replace("s", ""));
    if (!isNaN(secs) && secs > 0) {
      return Math.round(secs * 1000);
    }
  }
  return undefined;
}

export class GeminiEngine {
  constructor(
    private cfg: GeminiConfig,
    private breaker: CircuitBreaker,
    private rateLimiter: TokenBucket
  ) {}

  public updateConfig(newCfg: Partial<GeminiConfig>): void {
    this.cfg = { ...this.cfg, ...newCfg };
  }

  public getBreaker(): CircuitBreaker {
    return this.breaker;
  }

  public getRateLimiter(): TokenBucket {
    return this.rateLimiter;
  }

  public isAvailable(): boolean {
    return (
      Boolean(this.cfg.apiKey) &&
      !this.breaker.blocked() &&
      this.rateLimiter.hasTokens()
    );
  }

  /**
   * Dịch một mảng câu qua Gemini Cloud.
   * - Tự động chia nhỏ theo maxItemsTier1 / maxItemsTier2.
   * - Kèm ngữ cảnh 2 dòng trước mỗi chunk.
   * - Validate ID, retry 1 lần cho ID thiếu nếu còn token.
   * Port từ TranslateLines trong gemini.go:278
   */
  public async translateLines(
    lines: string[],
    contextLines: string[] = [],
    isTier1: boolean,
    callerSignal?: AbortSignal
  ): Promise<string[]> {
    if (!this.cfg.apiKey) {
      throw new DisabledError("Gemini API key is not configured");
    }
    if (lines.length === 0) {
      return [];
    }

    const maxChunk = isTier1 ? this.cfg.maxItemsTier1 : this.cfg.maxItemsTier2;
    const timeoutMs = isTier1
      ? this.cfg.timeoutTier1Ms
      : this.cfg.timeoutTier2Ms;

    const result: string[] = new Array(lines.length).fill("");
    let anySuccess = false;
    let lastError: unknown = null;

    for (let chunkStart = 0; chunkStart < lines.length; chunkStart += maxChunk) {
      if (callerSignal?.aborted) {
        throw new CanceledError();
      }

      const chunkEnd = Math.min(chunkStart + maxChunk, lines.length);
      const chunkLines = lines.slice(chunkStart, chunkEnd);

      // Ngữ cảnh: từ chunk thứ 2 trở đi lấy 2 dòng ngay trước chunk
      let chunkContext: string[] = [];
      if (chunkStart === 0) {
        chunkContext = contextLines;
      } else {
        chunkContext = lines.slice(Math.max(0, chunkStart - 2), chunkStart);
      }

      // Chuẩn bị danh sách item cho chunk (ID đánh số từ 0 đến chunkLines.length - 1)
      const items: GeminiItem[] = chunkLines.map((text, idx) => ({
        id: idx,
        text,
      }));

      try {
        const chunkMap = await this.executeSingleChunk(
          items,
          chunkContext,
          isTier1,
          timeoutMs,
          callerSignal
        );
        for (let i = 0; i < chunkLines.length; i++) {
          if (chunkMap.has(i)) {
            result[chunkStart + i] = chunkMap.get(i)!;
            anySuccess = true;
          }
        }
      } catch (chunkErr) {
        lastError = chunkErr;
        // Bị hủy hoặc mất mạng thì ngắt luôn toàn bộ
        if (
          chunkErr instanceof CanceledError ||
          chunkErr instanceof NetworkError ||
          callerSignal?.aborted
        ) {
          throw chunkErr;
        }
      }
    }

    if (!anySuccess && lastError) {
      throw lastError;
    }

    return result;
  }

  /**
   * Thực hiện gọi 1 chunk: check breaker, wait rateLimiter token, call API, retry ID thiếu
   */
  private async executeSingleChunk(
    items: GeminiItem[],
    contextLines: string[],
    isTier1: boolean,
    timeoutMs: number,
    callerSignal?: AbortSignal
  ): Promise<Map<number, string>> {
    // 1. Kiểm tra Breaker
    const { allowed, isProbe } = this.breaker.allow();
    if (!allowed) {
      throw new RateLimitedError("Gemini circuit breaker is blocked");
    }

    // 2. Chờ lấy token từ TokenBucket
    const acquired = await this.rateLimiter.acquire(
      isTier1,
      timeoutMs,
      callerSignal
    );
    if (!acquired) {
      throw new RateLimitedError("Gemini local rate limit (out of tokens)");
    }

    let resultMap: Map<number, string>;
    try {
      resultMap = await this.doRequest(
        items,
        contextLines,
        timeoutMs,
        callerSignal
      );
    } catch (reqErr) {
      this.breaker.report(errToBreakerOutcome(reqErr), isProbe);
      throw reqErr;
    }

    // 3. Kiểm tra xem có ID nào bị thiếu không
    const missingItems = items.filter((item) => !resultMap.has(item.id));

    // 4. Nếu thiếu ID: retry ĐÚNG 1 LẦN CHỈ RIÊNG các ID thiếu (nếu lấy được token)
    if (missingItems.length > 0) {
      if (this.rateLimiter.tryAcquire(isTier1)) {
        try {
          const retryMap = await this.doRequest(
            missingItems,
            contextLines,
            timeoutMs,
            callerSignal
          );
          for (const [id, vi] of retryMap.entries()) {
            resultMap.set(id, vi);
          }
        } catch {
          // Bỏ qua lỗi retry, giữ nguyên phần đã dịch được
        }
      }
    }

    // Báo cáo thành công cho Breaker
    this.breaker.report(OUTCOME_OK, isProbe);
    return resultMap;
  }

  /**
   * Gọi trực tiếp API generateContent của Gemini với JSON Schema
   * Port từ doRequest trong gemini.go:433
   */
  public async doRequest(
    items: GeminiItem[],
    contextLines: string[],
    timeoutMs: number,
    callerSignal?: AbortSignal
  ): Promise<Map<number, string>> {
    if (items.length === 0) {
      return new Map();
    }

    // Tạo prompt
    let promptText = "";
    if (contextLines.length > 0) {
      for (const cl of contextLines) {
        const trimmed = cl.trim();
        if (trimmed) {
          promptText += `[CONTEXT - KHÔNG DỊCH] ${trimmed}\n`;
        }
      }
    }
    promptText += `Dưới đây là các câu cần dịch dạng JSON:\n${JSON.stringify(items)}`;

    const reqBody = {
      system_instruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: promptText }],
        },
      ],
      generation_config: {
        response_mime_type: "application/json",
        response_schema: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              id: { type: "INTEGER" },
              vi: { type: "STRING" },
            },
            required: ["id", "vi"],
          },
        },
      },
    };

    const endpoint = this.cfg.endpoint.replace(/\/+$/, "");
    const url = `${endpoint}/${encodeURIComponent(this.cfg.model)}:generateContent`;

    const { signal, cleanup } = createTimeoutSignal(timeoutMs, callerSignal);

    try {
      let res: Response;
      try {
        res = await apiFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.cfg.apiKey,
          },
          body: JSON.stringify(reqBody),
          signal,
        });
      } catch (fetchErr: unknown) {
        if (signal.aborted) {
          if (callerSignal?.aborted) {
            throw new CanceledError();
          }
          throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
        }
        throw new NetworkError(
          `Gemini network failure: ${sanitizeApiKey(
            (fetchErr as Error)?.message || String(fetchErr),
            this.cfg.apiKey
          )}`
        );
      }

      const bodyText = await res.text();

      if (res.status === 429) {
        let retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
        if (!retryAfterMs) {
          retryAfterMs = parseRetryDelayFromBody(bodyText);
        }
        throw new RateLimitedError(
          `Gemini rate limited (429)`,
          retryAfterMs
        );
      }

      if (!res.ok) {
        const sanitizedErr = sanitizeApiKey(bodyText, this.cfg.apiKey);
        throw new Error(`Gemini HTTP ${res.status}: ${sanitizedErr}`);
      }

      let parsedBody: Record<string, unknown>;
      try {
        parsedBody = JSON.parse(bodyText);
      } catch (jsonErr) {
        throw new Error(`Gemini parse response error: ${jsonErr}`);
      }

      if (parsedBody.error) {
        const errMsg = (parsedBody.error as { message?: string }).message || "API error";
        throw new Error(
          `Gemini API error: ${sanitizeApiKey(errMsg, this.cfg.apiKey)}`
        );
      }

      const candidates = parsedBody.candidates as Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string }> };
      }>;

      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error("Gemini: empty candidates in response");
      }

      const cand = candidates[0];
      if (cand.finishReason && cand.finishReason !== "STOP") {
        throw new Error(
          `Gemini: generation stopped abnormally (finishReason=${cand.finishReason})`
        );
      }

      const parts = cand.content?.parts;
      if (!Array.isArray(parts) || parts.length === 0 || !parts[0]?.text) {
        throw new Error("Gemini: empty candidate text parts");
      }

      const cleanedJson = cleanJSONText(parts[0].text);
      let outputItems: GeminiResponseItem[];
      try {
        outputItems = JSON.parse(cleanedJson);
      } catch (parseItemsErr) {
        throw new Error(
          `Gemini invalid JSON array output: ${parseItemsErr}`
        );
      }

      // Validate: Các ID trả về phải nằm trong tập ID đã gửi và không bị trùng lặp
      const sentIdSet = new Set(items.map((it) => it.id));
      const resultMap = new Map<number, string>();

      for (const out of outputItems) {
        if (!sentIdSet.has(out.id)) {
          throw new InvalidResponseIdsError(
            `Nhận ID ${out.id} không có trong danh sách gửi`
          );
        }
        if (resultMap.has(out.id)) {
          throw new InvalidResponseIdsError(
            `ID ${out.id} bị trùng lặp trong phản hồi`
          );
        }
        resultMap.set(out.id, out.vi);
      }

      return resultMap;
    } finally {
      cleanup();
    }
  }

  /**
   * Lấy danh sách các model Gemini hỗ trợ generateContent
   * Port từ listModels trong gemini.go:65
   */
  public static async listModels(
    apiKey: string,
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models"
  ): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    try {
      // Chuẩn hoá URL: bỏ /models ở đuôi nếu có để lấy danh sách models
      const base = endpoint.replace(/\/+$/, "").replace(/\/models$/, "");
      const url = `${base}/models`;

      const res = await apiFetch(url, {
        method: "GET",
        headers: {
          "x-goog-api-key": apiKey,
        },
      });

      const bodyText = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          error: sanitizeApiKey(`HTTP ${res.status}: ${bodyText}`, apiKey),
        };
      }

      const data = JSON.parse(bodyText) as {
        models?: Array<{
          name: string;
          supportedGenerationMethods?: string[];
        }>;
      };

      if (!Array.isArray(data.models)) {
        return { ok: false, error: "Invalid models payload structure" };
      }

      const supported = data.models
        .filter((m) =>
          m.supportedGenerationMethods?.includes("generateContent")
        )
        .map((m) => m.name.replace(/^models\//, ""));

      return { ok: true, models: supported };
    } catch (err: unknown) {
      return {
        ok: false,
        error: sanitizeApiKey((err as Error)?.message || String(err), apiKey),
      };
    }
  }

  /**
   * Kiểm tra kết nối với Gemini bằng một câu test đơn giản, đo độ trễ
   */
  public static async testConnection(
    apiKey: string,
    model: string,
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models"
  ): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      const dummyEngine = new GeminiEngine(
        {
          apiKey,
          model,
          endpoint,
          timeoutTier1Ms: 8000,
          timeoutTier2Ms: 8000,
          maxItemsTier1: 10,
          maxItemsTier2: 20,
        },
        null as unknown as CircuitBreaker,
        null as unknown as TokenBucket
      );

      const items: GeminiItem[] = [{ id: 0, text: "Hello world" }];
      await dummyEngine.doRequest(items, [], 8000);
      const latencyMs = Date.now() - start;
      return { ok: true, latencyMs };
    } catch (err: unknown) {
      return {
        ok: false,
        error: sanitizeApiKey((err as Error)?.message || String(err), apiKey),
      };
    }
  }
}
