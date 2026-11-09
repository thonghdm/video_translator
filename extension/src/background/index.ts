/**
 * SubTrans Extension — Background Service Worker Entry Point
 *
 * MV3: MỌI listener (onConnect, onMessage, storage.onChanged) phải được đăng ký ĐỒNG BỘ ở top-level,
 * trong lượt chạy đầu tiên của script. Phần khởi tạo bất đồng bộ (restore state, nạp settings,
 * evict cache) chạy song song và được truyền vào MessagingHub dưới dạng promise `ready`.
 */

import { CircuitBreaker, defaultBreakerConfig } from "../shared/breaker";
import { TokenBucket } from "../shared/tokenBucket";
import { LRUCache } from "../shared/lru";
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from "../shared/settings";
import { GtxQueue } from "./engines/gtx";
import { GeminiEngine } from "./engines/gemini";
import { TranslationRouter } from "./router";
import { StateManager } from "./state";
import { MessagingHub } from "./messaging";
import { SubtransDB } from "./cache/db";
import { DriveSidecarService } from "./drive/sidecarService";

const log = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.log("[SubTrans][SW]", ...args);
};

// 1. Khởi tạo các thành phần cốt lõi (đồng bộ)
const D = DEFAULT_SETTINGS;
const phraseCache = new LRUCache<string, string>(8000);
const gtxBreaker = new CircuitBreaker(defaultBreakerConfig());
const geminiBreaker = new CircuitBreaker(defaultBreakerConfig()); // = cấu hình NewGeminiClient của Go
const geminiBucket = new TokenBucket(D.gemini.rpm);
const gtxQueue = new GtxQueue(D.gtx.concurrency, D.gtx.gapMs);
const subtransDB = new SubtransDB();

const geminiEngine = new GeminiEngine(
  {
    apiKey: "",
    model: D.gemini.model,
    endpoint: D.gemini.endpoint,
    timeoutTier1Ms: D.gemini.timeoutTier1Ms,
    timeoutTier2Ms: D.gemini.timeoutTier2Ms,
    maxItemsTier1: D.gemini.maxItemsTier1,
    maxItemsTier2: D.gemini.maxItemsTier2,
  },
  geminiBreaker,
  geminiBucket
);

const router = new TranslationRouter(
  { mode: D.mode, geminiModel: D.gemini.model, gtxTimeoutMs: D.gtx.timeoutMs },
  phraseCache,
  gtxBreaker,
  gtxQueue,
  geminiEngine
);

const stateManager = new StateManager(gtxBreaker, geminiBreaker, geminiBucket);
let cachePolicy: Settings["cache"] = { ...D.cache };
let driveAuto = DEFAULT_SETTINGS.drive.autoSidecar;
const driveSidecar = new DriveSidecarService({ isEnabled: () => driveAuto });

const messagingHub = new MessagingHub(
  router,
  gtxBreaker,
  geminiBreaker,
  geminiEngine,
  stateManager,
  subtransDB,
  async () => cachePolicy,
  driveSidecar
);

function applySettings(s: Settings): void {
  geminiEngine.updateConfig({
    apiKey: s.gemini.apiKey,
    model: s.gemini.model,
    endpoint: s.gemini.endpoint,
    timeoutTier1Ms: s.gemini.timeoutTier1Ms,
    timeoutTier2Ms: s.gemini.timeoutTier2Ms,
    maxItemsTier1: s.gemini.maxItemsTier1,
    maxItemsTier2: s.gemini.maxItemsTier2,
  });
  geminiBucket.setRpm(s.gemini.rpm);
  gtxQueue.updateConfig(s.gtx.concurrency, s.gtx.gapMs);
  router.updateConfig({ mode: s.mode, geminiModel: s.gemini.model, gtxTimeoutMs: s.gtx.timeoutMs });
  cachePolicy = { ...s.cache };
  driveAuto = s.drive.autoSidecar;
}

// 2. Khởi tạo bất đồng bộ
async function init(): Promise<void> {
  await stateManager.restore();
  const settings = await loadSettings();
  applySettings(settings);
  try {
    await subtransDB.evict(settings.cache);
  } catch (err) {
    console.warn("[SubTrans] Eviction error during startup:", err);
  }
  log("ready");
}

// 3. Đăng ký listener ĐỒNG BỘ (handler tự chờ `ready`)
messagingHub.init(init());

onSettingsChanged((s) => {
  applySettings(s);
  messagingHub.broadcastStatus();
});

// 4. Debug helper trong môi trường development (Phase 2)
if (import.meta.env.DEV) {
  (globalThis as unknown as { __subtransDebugTranslate: unknown }).__subtransDebugTranslate = (
    lines: string[]
  ) => router.translate({ lines, priority: "tier1" });
}
