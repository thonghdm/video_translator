/**
 * SubTrans Extension — Lưu trữ trạng thái Service Worker (State Persistence)
 * Giúp Breakers và TokenBucket sống sót qua các lần Service Worker restart (MV3)
 */

import type { CircuitBreaker, BreakerSnapshot } from "../shared/breaker";
import type { TokenBucket, TokenBucketSnapshot } from "../shared/tokenBucket";

export interface SessionState {
  gtxBreaker?: BreakerSnapshot;
  geminiBreaker?: BreakerSnapshot;
  geminiBucket?: TokenBucketSnapshot;
  deeplBreaker?: BreakerSnapshot;
}

const SESSION_KEY = "subtrans_sw_state";

export class StateManager {
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private gtxBreaker: CircuitBreaker,
    private geminiBreaker: CircuitBreaker,
    private geminiBucket: TokenBucket,
    private deeplBreaker?: CircuitBreaker
  ) {}

  /**
   * Lưu snapshot của các breaker và bucket vào chrome.storage.session với debounce 500ms
   */
  public scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.saveNow().catch((err) => {
        console.warn("[SubTrans] Không thể lưu state vào storage.session:", err);
      });
    }, 500);
  }

  public async saveNow(): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.storage?.session) {
      return;
    }

    const state: SessionState = {
      gtxBreaker: this.gtxBreaker.snapshot(),
      geminiBreaker: this.geminiBreaker.snapshot(),
      geminiBucket: this.geminiBucket.snapshot(),
    };
    if (this.deeplBreaker) {
      state.deeplBreaker = this.deeplBreaker.snapshot();
    }

    await chrome.storage.session.set({ [SESSION_KEY]: state });
  }

  /**
   * Khôi phục trạng thái từ chrome.storage.session khi Service Worker khởi động
   */
  public async restore(): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.storage?.session) {
      return;
    }

    try {
      const data = await chrome.storage.session.get(SESSION_KEY);
      const state = data[SESSION_KEY] as SessionState | undefined;

      if (state) {
        if (state.gtxBreaker) {
          this.gtxBreaker.restore(state.gtxBreaker);
        }
        if (state.geminiBreaker) {
          this.geminiBreaker.restore(state.geminiBreaker);
        }
        if (state.geminiBucket) {
          this.geminiBucket.restore(state.geminiBucket);
        }
        if (state.deeplBreaker && this.deeplBreaker) {
          this.deeplBreaker.restore(state.deeplBreaker);
        }
      }
    } catch (err) {
      console.warn("[SubTrans] Không thể khôi phục state từ storage.session:", err);
    }
  }
}
