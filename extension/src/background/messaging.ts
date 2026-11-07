/**
 * SubTrans Extension — Xử lý kết nối và thông điệp trong Background (Messaging)
 * Phù hợp với Mục 6.2 và Phase 2 & Phase 3 của PLAN.md
 */

import type { B2C, BreakerView, C2B, UiReq } from "../shared/messages";
import type { TranslationRouter } from "./router";
import { GeminiEngine } from "./engines/gemini";
import type { CircuitBreaker } from "../shared/breaker";
import type { StateManager } from "./state";
import { apiFetch, createTimeoutSignal } from "./engines/http";
import type { SubtransDB } from "./cache/db";

export class MessagingHub {
  private activePorts = new Set<chrome.runtime.Port>();
  private inFlightByPort = new Map<chrome.runtime.Port, Map<string, AbortController>>();

  constructor(
    private router: TranslationRouter,
    private gtxBreaker: CircuitBreaker,
    private geminiBreaker: CircuitBreaker,
    private geminiEngine: GeminiEngine,
    private stateManager: StateManager,
    private db: SubtransDB,
    private getCachePolicy?: () => Promise<{ maxTracks: number; maxAgeDays: number }>
  ) {}

  public init(): void {
    if (typeof chrome === "undefined" || !chrome.runtime) {
      return;
    }

    // 1. Quản lý kết nối Port "subtrans" giữa Content Script và Background
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== "subtrans") {
        return;
      }

      this.activePorts.add(port);
      const portInFlight = new Map<string, AbortController>();
      this.inFlightByPort.set(port, portInFlight);

      // Gửi trạng thái ban đầu cho port mới kết nối
      this.sendPortStatus(port);

      port.onMessage.addListener((msg: C2B) => {
        this.handlePortMessage(port, msg, portInFlight);
      });

      port.onDisconnect.addListener(() => {
        this.activePorts.delete(port);
        // Hủy tất cả các request đang chạy của port này
        for (const controller of portInFlight.values()) {
          controller.abort(new Error("Port disconnected"));
        }
        portInFlight.clear();
        this.inFlightByPort.delete(port);
      });
    });

    // 2. Lắng nghe thông điệp từ Popup/Options (UiReq)
    chrome.runtime.onMessage.addListener(
      (msg: UiReq, _sender, sendResponse: (response: unknown) => void) => {
        this.handleUiMessage(msg)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        // return true để Chrome giữ kênh trả lời bất đồng bộ
        return true;
      }
    );
  }

  private handlePortMessage(
    port: chrome.runtime.Port,
    msg: C2B,
    portInFlight: Map<string, AbortController>
  ): void {
    switch (msg.type) {
      case "translate": {
        const controller = new AbortController();
        portInFlight.set(msg.reqId, controller);

        this.router
          .translate({
            lines: msg.lines,
            srcLang: msg.srcLang,
            priority: msg.priority,
            prefer: msg.prefer,
            signal: controller.signal,
          })
          .then(({ results, error }) => {
            const resMsg: B2C = {
              type: "translate.result",
              reqId: msg.reqId,
              results,
              error,
            };
            port.postMessage(resMsg);
            this.stateManager.scheduleSave();
            this.broadcastStatus();
          })
          .catch((err: unknown) => {
            const resMsg: B2C = {
              type: "translate.result",
              reqId: msg.reqId,
              results: msg.lines.map(() => ({ text: "", engine: null })),
              error: {
                kind: "other",
                message: (err as Error)?.message || String(err),
              },
            };
            port.postMessage(resMsg);
          })
          .finally(() => {
            portInFlight.delete(msg.reqId);
          });
        break;
      }

      case "cancel": {
        const controller = portInFlight.get(msg.reqId);
        if (controller) {
          controller.abort(new Error("Canceled by content script"));
          portInFlight.delete(msg.reqId);
        }
        break;
      }

      case "fetchText": {
        this.handleFetchText(msg.reqId, msg.url, port);
        break;
      }

      case "cache.load": {
        this.db
          .getTrack(msg.trackKey)
          .then(async (track) => {
            if (track && track.sourceHash === msg.sourceHash) {
              await this.db.touchTrack(msg.trackKey);
              const lines = await this.db.getLines(msg.trackKey);
              const reply: B2C = {
                type: "cache.loaded",
                reqId: msg.reqId,
                hit: true,
                cues: track.cues,
                lines,
              };
              port.postMessage(reply);
            } else {
              const reply: B2C = {
                type: "cache.loaded",
                reqId: msg.reqId,
                hit: false,
              };
              port.postMessage(reply);
            }
          })
          .catch((err) => {
            console.warn("[SubTrans] cache.load error:", err);
            port.postMessage({
              type: "cache.loaded",
              reqId: msg.reqId,
              hit: false,
            });
          });
        break;
      }

      case "cache.saveTrack": {
        this.db
          .putTrack(msg.track, msg.cues, msg.sourceHash)
          .then(async () => {
            if (this.getCachePolicy) {
              const policy = await this.getCachePolicy();
              await this.db.evict(policy);
            }
          })
          .catch((err) => {
            console.warn("[SubTrans] cache.saveTrack error:", err);
          });
        break;
      }

      case "cache.saveLines": {
        this.db
          .mergeLines(
            msg.trackKey,
            msg.engineKey,
            msg.sourceHash,
            msg.total,
            msg.updates
          )
          .catch((err) => {
            console.warn("[SubTrans] cache.saveLines error:", err);
          });
        break;
      }

      default:
        break;
    }
  }

  /**
   * Tải nội dung text từ URL (chỉ nhận http/https, giới hạn tối đa 2MB, timeout 10s)
   */
  private async handleFetchText(
    reqId: string,
    url: string,
    port: chrome.runtime.Port
  ): Promise<void> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Chỉ hỗ trợ giao thức HTTP/HTTPS");
      }

      const { signal, cleanup } = createTimeoutSignal(10000);
      try {
        const res = await apiFetch(url, { method: "GET", signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const text = await res.text();
        // Kiểm tra kích thước tối đa 2MB
        if (text.length > 2 * 1024 * 1024) {
          throw new Error("Dung lượng vượt quá giới hạn 2MB");
        }

        const reply: B2C = {
          type: "fetchText.result",
          reqId,
          ok: true,
          text,
        };
        port.postMessage(reply);
      } finally {
        cleanup();
      }
    } catch (err: unknown) {
      const reply: B2C = {
        type: "fetchText.result",
        reqId,
        ok: false,
        error: (err as Error)?.message || String(err),
      };
      port.postMessage(reply);
    }
  }

  private async handleUiMessage(msg: UiReq): Promise<unknown> {
    switch (msg.type) {
      case "gemini.test": {
        return await GeminiEngine.testConnection(msg.apiKey, msg.model);
      }
      case "gemini.listModels": {
        return await GeminiEngine.listModels(msg.apiKey);
      }
      case "cache.stats": {
        return await this.db.stats();
      }
      case "cache.clear": {
        await this.db.clear(msg.trackKey);
        return { ok: true };
      }
      default:
        return { ok: false, error: "Unknown UiReq" };
    }
  }

  public broadcastStatus(): void {
    for (const port of this.activePorts) {
      this.sendPortStatus(port);
    }
  }

  private sendPortStatus(port: chrome.runtime.Port): void {
    const apiView: BreakerView = {
      blocked: this.gtxBreaker.blocked(),
      until: this.gtxBreaker.getBlockedUntil(),
    };
    const cloudView: BreakerView = {
      blocked: this.geminiBreaker.blocked(),
      until: this.geminiBreaker.getBlockedUntil(),
    };

    const statusMsg: B2C = {
      type: "status",
      breakers: {
        api: apiView,
        cloud: cloudView,
      },
      geminiReady: this.geminiEngine.isAvailable(),
    };

    try {
      port.postMessage(statusMsg);
    } catch {
      // Port có thể đã đóng
    }
  }
}
