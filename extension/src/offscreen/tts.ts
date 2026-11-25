/**
 * SubTrans Extension — Offscreen Document cho Edge TTS trên Chromium
 *
 * Lý do tồn tại: Trong Chromium MV3, WebSocket mở trực tiếp từ Service Worker không có
 * RenderFrameHost nên declarativeNetRequest (modifyHeaders Origin/User-Agent) bị bỏ qua,
 * dẫn tới lỗi 403 từ speech.platform.bing.com.
 * Chạy WebSocket bên trong Offscreen Document (có RenderFrameHost đầy đủ) giúp rule DNR
 * gắn đúng Origin & User-Agent 100% mà không bị ảnh hưởng bởi CSP của trang web.
 */

import { synthesizeEdgeTtsLocal } from "../background/engines/edgeTts";
import type { TtsVoice } from "../shared/messages";

export interface OffscreenTtsRequest {
  target: "subtrans-offscreen-tts";
  type: "offscreen.tts.synthesize" | "offscreen.tts.cancel";
  reqId: string;
  text?: string;
  voice?: TtsVoice;
  rate?: string;
  timeoutMs?: number;
}

const inFlight = new Map<string, AbortController>();

chrome.runtime.onMessage.addListener(
  (msg: OffscreenTtsRequest, _sender, sendResponse) => {
    if (!msg || msg.target !== "subtrans-offscreen-tts") {
      return false;
    }

    if (msg.type === "offscreen.tts.cancel") {
      const ctrl = inFlight.get(msg.reqId);
      if (ctrl) {
        ctrl.abort();
        inFlight.delete(msg.reqId);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "offscreen.tts.synthesize") {
      const ctrl = new AbortController();
      inFlight.set(msg.reqId, ctrl);

      synthesizeEdgeTtsLocal({
        text: msg.text ?? "",
        voice: msg.voice ?? "vi-VN-HoaiMyNeural",
        rate: msg.rate,
        signal: ctrl.signal,
        timeoutMs: msg.timeoutMs,
      })
        .then((audioBase64) => {
          sendResponse({ ok: true, audioBase64 });
        })
        .catch((err: unknown) => {
          const isAbort = err instanceof Error && err.name === "AbortError";
          sendResponse({
            ok: false,
            aborted: isAbort,
            error: (err as Error)?.message || String(err),
          });
        })
        .finally(() => {
          inFlight.delete(msg.reqId);
        });

      return true;
    }

    return false;
  }
);
