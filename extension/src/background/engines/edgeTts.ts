/**
 * SubTrans Extension — Microsoft Edge Neural TTS Engine (Background)
 * Phù hợp với PLAN-tts.md (Phase 13, Bước 1)
 *
 * Thuần TypeScript + Web API chuẩn (WebSocket, crypto.subtle, TextEncoder, TextDecoder, DataView).
 * Mọi lệnh fetch phụ trợ luôn dùng credentials: "omit" (tuân thủ verify-dist.mjs).
 */

import type { TtsVoice } from "../../shared/messages";
import { generateSecMsGecV2 } from "./edgeTtsDrm";

export const EDGE_TTS_CONFIG = {
  TRUSTED_CLIENT_TOKEN: "6A5AA1D4EAFF4E9FB37E23D68491D6F4",
  SEC_MS_GEC_VERSION: "2-143.0.3650.75",
  EDGE_ORIGIN: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  EDGE_UA:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  WSS_URL: "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1",
  CLOCK_SYNC_URL: "https://speech.platform.bing.com/",
  DNR_RULE_ID: 9101,
  MAX_TEXT_CHARS: 600,
  MAX_CONCURRENCY: 2,
} as const;

const DEFAULT_TIMEOUT_MS = 10_000;

let cachedClockSkewSec = 0;

/** Dùng cho unit test để đặt lại trạng thái lệch đồng hồ */
export function resetClockSkewForTest(): void {
  cachedClockSkewSec = 0;
}

export function getCachedClockSkewSec(): number {
  return cachedClockSkewSec;
}

function createAbortError(message = "TTS request aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function makeConnectionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  let hex = "";
  for (let i = 0; i < 32; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return hex;
}

function getExtensionInitiatorDomain(): string | null {
  try {
    if (typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function") {
      const host = new URL(chrome.runtime.getURL("")).hostname;
      if (host) return host;
    }
  } catch {
    // bỏ qua
  }
  return typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : null;
}

let webRequestRegistered = false;

/**
 * Trên Firefox (bản đóng gói scripts/zip.mjs có quyền webRequest + webRequestBlocking),
 * gắn listener onBeforeSendHeaders làm lớp bảo hiểm chắc chắn ghi đè Origin & User-Agent
 * cho WebSocket handshake tới speech.platform.bing.com.
 * Trên Chrome MV3 không có quyền này → tự bỏ qua an toàn và dùng DNR.
 */
function ensureFirefoxWebRequestFallback(): void {
  if (webRequestRegistered) return;
  try {
    const wr = (
      chrome as unknown as {
        webRequest?: {
          onBeforeSendHeaders?: {
            addListener: (
              cb: (details: {
                requestHeaders?: Array<{ name: string; value?: string }>;
              }) => { requestHeaders?: Array<{ name: string; value?: string }> },
              filter: { urls: string[] },
              extraInfoSpec: string[]
            ) => void;
          };
        };
      }
    ).webRequest;
    if (!wr?.onBeforeSendHeaders?.addListener) return;

    wr.onBeforeSendHeaders.addListener(
      (details) => {
        const headers = (details.requestHeaders ?? []).filter((h) => {
          const lower = h.name.toLowerCase();
          return lower !== "origin" && lower !== "user-agent";
        });
        headers.push(
          { name: "Origin", value: EDGE_TTS_CONFIG.EDGE_ORIGIN },
          { name: "User-Agent", value: EDGE_TTS_CONFIG.EDGE_UA }
        );
        return { requestHeaders: headers };
      },
      {
        urls: [
          "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/*",
          "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/*",
        ],
      },
      ["blocking", "requestHeaders"]
    );
    webRequestRegistered = true;
  } catch {
    // Chrome MV3 không cho phép blocking webRequest → bỏ qua, dùng DNR
  }
}

/**
 * Cài đặt rule declarativeNetRequest gắn Origin và User-Agent chuẩn Edge Read Aloud
 * cho các request tới speech.platform.bing.com.
 * Luôn removeRuleIds cùng lúc với addRules để tránh lỗi trùng ID khi SW khởi động lại.
 */
export async function ensureEdgeTtsHeaderRules(): Promise<void> {
  ensureFirefoxWebRequestFallback();
  if (
    typeof chrome === "undefined" ||
    !chrome.declarativeNetRequest?.updateDynamicRules
  ) {
    return;
  }

  const initiatorDomain = getExtensionInitiatorDomain();
  const baseCondition: chrome.declarativeNetRequest.RuleCondition = {
    urlFilter: "||speech.platform.bing.com/consumer/speech/synthesize/readaloud/",
    resourceTypes: [
      "websocket",
      "xmlhttprequest",
      "other",
    ] as chrome.declarativeNetRequest.ResourceType[],
  };

  const buildRule = (withInitiator: boolean): chrome.declarativeNetRequest.Rule => ({
    id: EDGE_TTS_CONFIG.DNR_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: "Origin",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: EDGE_TTS_CONFIG.EDGE_ORIGIN,
        },
        {
          header: "User-Agent",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: EDGE_TTS_CONFIG.EDGE_UA,
        },
      ],
    },
    condition:
      withInitiator && initiatorDomain
        ? { ...baseCondition, initiatorDomains: [initiatorDomain] }
        : baseCondition,
  });

  try {
    if (initiatorDomain) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [EDGE_TTS_CONFIG.DNR_RULE_ID],
          addRules: [buildRule(true)],
        });
        return;
      } catch {
        // Một số bản trình duyệt không hỗ trợ initiatorDomains với extension host → fallback bỏ initiatorDomains
      }
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [EDGE_TTS_CONFIG.DNR_RULE_ID],
      addRules: [buildRule(false)],
    });
  } catch (err) {
    console.warn("[SubTrans][EdgeTTS] Không thể cài DNR header rule:", err);
  }
}

/**
 * Sinh token Sec-MS-GEC v2 ("<16 HEX>-<64 HEX>") theo thuật toán Edge Read Aloud mới nhất.
 */
export async function generateSecMsGec(
  nowMs = Date.now(),
  clockSkewSec = 0
): Promise<string> {
  return generateSecMsGecV2(EDGE_TTS_CONFIG.TRUSTED_CLIENT_TOKEN, nowMs, clockSkewSec);
}

/**
 * Đồng bộ độ lệch đồng hồ cục bộ với server Microsoft qua header HTTP Date.
 * Luôn dùng credentials: "omit" để tuân thủ verify-dist.mjs.
 */
export async function syncClockSkew(): Promise<number> {
  try {
    const res = await fetch(EDGE_TTS_CONFIG.CLOCK_SYNC_URL, {
      method: "HEAD",
      credentials: "omit",
      cache: "no-store",
    });
    const dateHeader = res.headers.get("Date");
    if (dateHeader) {
      const serverMs = Date.parse(dateHeader);
      if (Number.isFinite(serverMs)) {
        cachedClockSkewSec = Math.round((serverMs - Date.now()) / 1000);
      }
    }
  } catch {
    // Giữ nguyên cachedClockSkewSec hiện có nếu không gọi được HEAD
  }
  return cachedClockSkewSec;
}

/**
 * Cắt payload MP3 từ frame binary của Edge TTS:
 * - 2 byte đầu (Big-Endian uint16) là độ dài phần header text.
 * - Chỉ trả về phần byte sau (2 + headerLen) nếu header chứa "Path:audio".
 */
export function extractAudioFromBinaryFrame(buf: ArrayBuffer): Uint8Array | null {
  if (buf.byteLength < 2) return null;
  const headerLen = new DataView(buf).getUint16(0, false);
  const payloadOffset = 2 + headerLen;
  if (buf.byteLength <= payloadOffset) return null;
  const headerText = new TextDecoder().decode(buf.slice(2, payloadOffset));
  if (!headerText.includes("Path:audio")) return null;
  return new Uint8Array(buf, payloadOffset);
}

/**
 * Chuyển Uint8Array sang Base64 theo từng khối 32 KB để không bao giờ bị tràn call stack.
 */
export function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

function sanitizeAndEscapeSsmlText(raw: string): string {
  // Loại bỏ ký tự điều khiển không hợp lệ trong XML/SSML
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").trim();
  if (!cleaned) return "";
  const truncated =
    cleaned.length > EDGE_TTS_CONFIG.MAX_TEXT_CHARS
      ? cleaned.slice(0, EDGE_TTS_CONFIG.MAX_TEXT_CHARS)
      : cleaned;
  return truncated
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeRate(rate?: string): string {
  const trimmed = (rate ?? "+0%").trim();
  return /^[+-]?\d+%$/.test(trimmed)
    ? trimmed.startsWith("+") || trimmed.startsWith("-")
      ? trimmed
      : `+${trimmed}`
    : "+0%";
}

function mergeChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Hàng đợi giới hạn đồng thời (MAX_CONCURRENCY = 2)
// ---------------------------------------------------------------------------

interface QueueWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

let activeCount = 0;
const waitQueue: QueueWaiter[] = [];

function acquireSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (activeCount < EDGE_TTS_CONFIG.MAX_CONCURRENCY) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const idx = waitQueue.indexOf(waiter);
      if (idx >= 0) waitQueue.splice(idx, 1);
      waiter.cleanup();
      reject(createAbortError());
    };
    const waiter: QueueWaiter = {
      resolve: () => {
        waiter.cleanup();
        activeCount++;
        resolve();
      },
      reject: (err) => {
        waiter.cleanup();
        reject(err);
      },
      cleanup: () => {
        signal?.removeEventListener("abort", onAbort);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waitQueue.push(waiter);
  });
}

function releaseSlot(): void {
  activeCount = Math.max(0, activeCount - 1);
  while (waitQueue.length > 0 && activeCount < EDGE_TTS_CONFIG.MAX_CONCURRENCY) {
    const next = waitQueue.shift();
    if (next) {
      next.resolve();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Thực thi một lần kết nối WebSocket Edge TTS
// ---------------------------------------------------------------------------

interface AttemptOutcome {
  audioBase64: string;
}

interface AttemptError extends Error {
  receivedAudioBytes: number;
  closeCode?: number;
}

function makeAttemptError(
  message: string,
  receivedAudioBytes: number,
  closeCode?: number
): AttemptError {
  const err = new Error(message) as AttemptError;
  err.receivedAudioBytes = receivedAudioBytes;
  err.closeCode = closeCode;
  return err;
}

async function runSingleAttempt(params: {
  escapedText: string;
  voice: TtsVoice;
  rate: string;
  clockSkewSec: number;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<AttemptOutcome> {
  if (params.signal?.aborted) {
    throw createAbortError();
  }

  const gec = await generateSecMsGec(Date.now(), params.clockSkewSec);
  if (params.signal?.aborted) {
    throw createAbortError();
  }

  const connId = makeConnectionId();
  const url =
    `${EDGE_TTS_CONFIG.WSS_URL}?TrustedClientToken=${EDGE_TTS_CONFIG.TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=${EDGE_TTS_CONFIG.SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connId}`;

  return new Promise<AttemptOutcome>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    const audioChunks: Uint8Array[] = [];
    let receivedAudioBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
    };

    const safeClose = () => {
      try {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      } catch {
        // bỏ qua lỗi đóng socket
      }
    };

    const finishOk = (audioBase64: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      safeClose();
      resolve({ audioBase64 });
    };

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      safeClose();
      reject(err);
    };

    const onAbort = () => {
      finishErr(createAbortError());
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      finishErr(
        makeAttemptError(
          `Edge TTS hết thời gian chờ (${params.timeoutMs}ms)`,
          receivedAudioBytes
        )
      );
    }, params.timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      const ts = new Date().toISOString();
      const configFrame =
        `X-Timestamp:${ts}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;

      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
        `<voice name='${params.voice}'>` +
        `<prosody pitch='+0Hz' rate='${params.rate}' volume='+0%'>${params.escapedText}</prosody>` +
        `</voice></speak>`;

      const ssmlFrame =
        `X-RequestId:${connId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${ts}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;

      try {
        ws.send(configFrame);
        ws.send(ssmlFrame);
      } catch (err) {
        finishErr(
          makeAttemptError(
            `Edge TTS gửi frame thất bại: ${(err as Error)?.message || String(err)}`,
            receivedAudioBytes
          )
        );
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (settled) return;
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) {
          if (receivedAudioBytes === 0) {
            finishErr(
              makeAttemptError("Edge TTS không trả về dữ liệu âm thanh", 0)
            );
            return;
          }
          const merged = mergeChunks(audioChunks, receivedAudioBytes);
          finishOk(arrayBufferToBase64(merged));
        }
        return;
      }

      if (ev.data instanceof ArrayBuffer) {
        const chunk = extractAudioFromBinaryFrame(ev.data);
        if (chunk && chunk.byteLength > 0) {
          audioChunks.push(chunk);
          receivedAudioBytes += chunk.byteLength;
        }
      }
    };

    ws.onerror = () => {
      // Đợi onclose để lấy close code nếu có; nếu socket không gọi onclose thì timeout sẽ xử lý
    };

    ws.onclose = (ev: CloseEvent) => {
      if (settled) return;
      const reason = ev.reason ? ` (${ev.reason})` : "";
      finishErr(
        makeAttemptError(
          `Edge TTS đóng kết nối bất thường (code ${ev.code}${reason})`,
          receivedAudioBytes,
          ev.code
        )
      );
    };
  });
}

export interface SynthesizeEdgeTtsOptions {
  text: string;
  voice: TtsVoice;
  rate?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Tổng hợp giọng nói tiếng Việt từ Edge Neural TTS, trả về chuỗi MP3 Base64.
 * Có giới hạn đồng thời (MAX_CONCURRENCY = 2), hỗ trợ AbortSignal, và tự đồng bộ
 * đồng hồ + retry đúng 1 lần nếu lỗi xảy ra trước khi nhận bất kỳ byte audio nào.
 */
export async function synthesizeEdgeTts(
  opts: SynthesizeEdgeTtsOptions
): Promise<string> {
  const escapedText = sanitizeAndEscapeSsmlText(opts.text);
  if (!escapedText) {
    throw new Error("Văn bản TTS rỗng");
  }

  const rate = normalizeRate(opts.rate);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await acquireSlot(opts.signal);
  try {
    try {
      const outcome = await runSingleAttempt({
        escapedText,
        voice: opts.voice,
        rate,
        clockSkewSec: cachedClockSkewSec,
        signal: opts.signal,
        timeoutMs,
      });
      return outcome.audioBase64;
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) {
        throw err;
      }
      const receivedAudioBytes =
        typeof (err as AttemptError)?.receivedAudioBytes === "number"
          ? (err as AttemptError).receivedAudioBytes
          : 0;
      if (receivedAudioBytes > 0) {
        throw err;
      }

      // Chưa nhận byte audio nào → đồng bộ lệch đồng hồ và thử lại đúng 1 lần
      await syncClockSkew();
      if (opts.signal?.aborted) {
        throw createAbortError();
      }
      const retryOutcome = await runSingleAttempt({
        escapedText,
        voice: opts.voice,
        rate,
        clockSkewSec: cachedClockSkewSec,
        signal: opts.signal,
        timeoutMs,
      });
      return retryOutcome.audioBase64;
    }
  } finally {
    releaseSlot();
  }
}
