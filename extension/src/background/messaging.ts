/**
 * SubTrans Extension — Xử lý kết nối và thông điệp trong Background (Messaging)
 * Phù hợp với Mục 6.2 và Phase 2 & Phase 3 của PLAN.md
 */

import type { B2C, BreakerView, C2B, UiReq } from "../shared/messages";
import type { TranslationRouter } from "./router";
import { GeminiEngine } from "./engines/gemini";
import { DeepLEngine } from "./engines/deepl";
import type { CircuitBreaker } from "../shared/breaker";
import type { StateManager } from "./state";
import { apiFetch, createTimeoutSignal } from "./engines/http";
import type { SubtransDB } from "./cache/db";
import type { DriveSidecarService } from "./drive/sidecarService";

/** postMessage an toàn: port có thể đã ngắt (tab đóng, content reload) → bỏ qua, không ném lỗi */
export function safePost(port: chrome.runtime.Port, msg: B2C): boolean {
  try {
    port.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

export class MessagingHub {
  /** Resolve khi SW đã restore state + nạp settings; handler luôn chờ promise này trước khi xử lý */
  private ready: Promise<void> = Promise.resolve();
  private activePorts = new Set<chrome.runtime.Port>();
  private inFlightByPort = new Map<chrome.runtime.Port, Map<string, AbortController>>();

  constructor(
    private router: TranslationRouter,
    private gtxBreaker: CircuitBreaker,
    private geminiBreaker: CircuitBreaker,
    private geminiEngine: GeminiEngine,
    private stateManager: StateManager,
    private db: SubtransDB,
    private getCachePolicy?: () => Promise<{ maxTracks: number; maxAgeDays: number }>,
    private driveSidecar?: DriveSidecarService,
    private deeplBreaker?: CircuitBreaker
  ) {}

  /**
   * PHẢI được gọi ĐỒNG BỘ ở top-level của service worker (MV3): nếu SW được đánh thức bởi
   * onConnect/onMessage mà listener chưa được đăng ký trong lượt chạy đầu tiên, event đó bị MẤT.
   * Việc khởi tạo bất đồng bộ (restore state, settings) truyền vào qua `ready`.
   */
  public init(ready: Promise<void> = Promise.resolve()): void {
    this.ready = ready.catch((err) => {
      if (import.meta.env.DEV) console.warn("[SubTrans] SW init lỗi:", err);
    });
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

      // Gửi trạng thái ban đầu cho port mới kết nối (sau khi state đã được restore)
      void this.ready.then(() => this.sendPortStatus(port));

      port.onMessage.addListener((msg: C2B) => {
        void this.ready.then(() => {
          if (this.activePorts.has(port)) this.handlePortMessage(port, msg, portInFlight);
        });
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
        this.ready
          .then(() => this.handleUiMessage(msg))
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
            safePost(port, resMsg);
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
            safePost(port, resMsg);
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
              const lines = await this.db.getLines(msg.trackKey, msg.sourceHash);
              const reply: B2C = {
                type: "cache.loaded",
                reqId: msg.reqId,
                hit: true,
                cues: track.cues,
                lines,
              };
              safePost(port, reply);
            } else {
              const reply: B2C = {
                type: "cache.loaded",
                reqId: msg.reqId,
                hit: false,
              };
              safePost(port, reply);
            }
          })
          .catch((err) => {
            console.warn("[SubTrans] cache.load error:", err);
            safePost(port, {
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

      case "drive.sidecar": {
        const promise = this.driveSidecar
          ? this.driveSidecar.handle(port.sender, msg.videoDocId)
          : Promise.resolve({ ok: false as const, reason: "disabled" as const });
        void promise
          .then((outcome) => {
            safePost(port, {
              type: "drive.sidecar.result",
              reqId: msg.reqId,
              ...outcome,
            });
          })
          .catch(() => {
            safePost(port, {
              type: "drive.sidecar.result",
              reqId: msg.reqId,
              ok: false,
              reason: "index_unavailable",
            });
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
        safePost(port, reply);
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
      safePost(port, reply);
    }
  }

  private async handleUiMessage(msg: UiReq): Promise<unknown> {
    switch (msg.type) {
      case "status": {
        const breakers: { api: BreakerView; cloud: BreakerView; deepl?: BreakerView } = {
          api: {
            blocked: this.gtxBreaker.blocked(),
            until: this.gtxBreaker.getBlockedUntil(),
          },
          cloud: {
            blocked: this.geminiBreaker.blocked(),
            until: this.geminiBreaker.getBlockedUntil(),
          },
        };
        if (this.deeplBreaker) {
          breakers.deepl = {
            blocked: this.deeplBreaker.blocked(),
            until: this.deeplBreaker.getBlockedUntil(),
          };
        }
        return {
          ok: true,
          breakers,
          geminiReady: this.geminiEngine.isAvailable(),
        };
      }
      case "deepl.test": {
        return await DeepLEngine.testConnection(msg.apiKey);
      }
      case "gemini.test": {
        return await GeminiEngine.testConnection(
          msg.apiKey,
          msg.model,
          this.geminiEngine.getEndpoint()
        );
      }
      case "gemini.listModels": {
        return await GeminiEngine.listModels(msg.apiKey, this.geminiEngine.getEndpoint());
      }
      case "cache.stats": {
        return await this.db.stats();
      }
      case "cache.listRecent": {
        return await this.db.listRecent(msg.limit || 50);
      }
      case "cache.clear": {
        await this.db.clear(msg.trackKey);
        // Xóa toàn bộ cache → xóa luôn cache cụm từ trong RAM của router
        if (!msg.trackKey) this.router.clearPhraseCache?.();
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

    const breakers: { api: BreakerView; cloud: BreakerView; deepl?: BreakerView } = {
      api: apiView,
      cloud: cloudView,
    };
    if (this.deeplBreaker) {
      breakers.deepl = {
        blocked: this.deeplBreaker.blocked(),
        until: this.deeplBreaker.getBlockedUntil(),
      };
    }

    const statusMsg: B2C = {
      type: "status",
      breakers,
      geminiReady: this.geminiEngine.isAvailable(),
    };

    safePost(port, statusMsg);
  }
}
