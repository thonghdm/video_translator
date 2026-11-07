/**
 * SubTrans Extension — Background Service Worker Entry Point
 */

import { CircuitBreaker, defaultBreakerConfig } from "../shared/breaker";
import { TokenBucket } from "../shared/tokenBucket";
import { LRUCache } from "../shared/lru";
import { loadSettings, onSettingsChanged } from "../shared/settings";
import { GtxQueue } from "./engines/gtx";
import { GeminiEngine } from "./engines/gemini";
import { TranslationRouter } from "./router";
import { StateManager } from "./state";
import { MessagingHub } from "./messaging";

console.log("[SubTrans] Service Worker initializing...");

// 1. Khởi tạo các thành phần cốt lõi
const phraseCache = new LRUCache<string, string>(8000);
const gtxBreaker = new CircuitBreaker(defaultBreakerConfig());
const geminiBreaker = new CircuitBreaker(defaultBreakerConfig());
const geminiBucket = new TokenBucket(12);

const gtxQueue = new GtxQueue(2, 150);

const geminiEngine = new GeminiEngine(
  {
    apiKey: "",
    model: "gemini-3.5-flash-lite",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    timeoutTier1Ms: 3500,
    timeoutTier2Ms: 8000,
    maxItemsTier1: 10,
    maxItemsTier2: 20,
  },
  geminiBreaker,
  geminiBucket
);

const router = new TranslationRouter(
  {
    mode: "google",
    geminiModel: "gemini-3.5-flash-lite",
  },
  phraseCache,
  gtxBreaker,
  gtxQueue,
  geminiEngine
);

const stateManager = new StateManager(gtxBreaker, geminiBreaker, geminiBucket);
const messagingHub = new MessagingHub(
  router,
  gtxBreaker,
  geminiBreaker,
  geminiEngine,
  stateManager
);

// 2. Nạp settings và restore state
async function init() {
  await stateManager.restore();
  const settings = await loadSettings();

  geminiEngine.updateConfig({
    apiKey: settings.gemini.apiKey,
    model: settings.gemini.model,
    endpoint: settings.gemini.endpoint,
    timeoutTier1Ms: settings.gemini.timeoutTier1Ms,
    timeoutTier2Ms: settings.gemini.timeoutTier2Ms,
    maxItemsTier1: settings.gemini.maxItemsTier1,
    maxItemsTier2: settings.gemini.maxItemsTier2,
  });

  gtxQueue.updateConfig(settings.gtx.concurrency, settings.gtx.gapMs);

  router.updateConfig({
    mode: settings.mode,
    geminiModel: settings.gemini.model,
  });

  messagingHub.init();
  console.log("[SubTrans] Service Worker ready!");
}

void init();

// 3. Lắng nghe thay đổi cài đặt từ Popup / Options
onSettingsChanged((newSettings) => {
  geminiEngine.updateConfig({
    apiKey: newSettings.gemini.apiKey,
    model: newSettings.gemini.model,
    endpoint: newSettings.gemini.endpoint,
    timeoutTier1Ms: newSettings.gemini.timeoutTier1Ms,
    timeoutTier2Ms: newSettings.gemini.timeoutTier2Ms,
    maxItemsTier1: newSettings.gemini.maxItemsTier1,
    maxItemsTier2: newSettings.gemini.maxItemsTier2,
  });

  gtxQueue.updateConfig(newSettings.gtx.concurrency, newSettings.gtx.gapMs);

  router.updateConfig({
    mode: newSettings.mode,
    geminiModel: newSettings.gemini.model,
  });

  messagingHub.broadcastStatus();
});

// 4. Debug helper trong môi trường development (Mục 501 PLAN.md)
if (import.meta.env.DEV) {
  (globalThis as unknown as { __subtransDebugTranslate: unknown }).__subtransDebugTranslate =
    async (lines: string[]) => {
      return await router.translate({
        lines,
        priority: "tier1",
      });
    };
}
