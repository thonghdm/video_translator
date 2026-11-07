/**
 * SubTrans Extension — Hook chạy trong MAIN world của youtube.com (document_start).
 * PHẢI build ra script tự chứa: không import runtime, không dùng chrome.* (xem scripts/verify-dist.mjs).
 *
 * Đã kiểm chứng trên YouTube thật (NOTES.md › Phase 5):
 * - baseUrl trong playerResponse KHÔNG có `pot` → fetch trả HTTP 200 nhưng body rỗng.
 * - Request timedtext do player gửi có `pot` và chạy NGAY khi tải trang (trước document_idle, khi
 *   content script chưa nghe) → hook giữ BỘ ĐỆM các lần bắt được và phát lại khi content yêu cầu.
 * - player.loadModule("captions") khiến player tự gửi request timedtext mới (có pot) → lấy được phụ đề
 *   mà không cần người dùng bấm CC.
 *
 * Giao thức window.postMessage (cùng origin, event.source === window):
 *   content → hook: { source:"subtrans-cs", kind: "getPlayerResponse" | "fetchTimedtext" | "replay"
 *                     | "ensureCaptions" | "restoreCaptions", reqId?, url? }
 *   hook → content: { source:"subtrans-yt", kind: "timedtext" | "playerResponse"
 *                     | "fetchTimedtext.result" | "ensureCaptions.result", reqId?, ... }
 */

type AnyPlayer = {
  getPlayerResponse?: () => any;
  getOption?: (mod: string, key: string) => any;
  loadModule?: (mod: string) => void;
  unloadModule?: (mod: string) => void;
};

(function installSubtransHook() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__subtransYtHook) return; // không cài 2 lần
  w.__subtransYtHook = true;

  const TIMEDTEXT_PATH = "/api/timedtext";
  const MAX_BUFFER = 12;
  const MAX_BODY_CHARS = 4 * 1024 * 1024;
  const buffer: Array<{ url: string; body: string }> = [];

  const post = (msg: Record<string, unknown>) => {
    try {
      window.postMessage({ source: "subtrans-yt", ...msg }, location.origin);
    } catch {
      /* bỏ qua */
    }
  };

  const toUrlString = (input: unknown): string => {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input === "object" && "url" in input) return String((input as Request).url);
    } catch {
      /* bỏ qua */
    }
    return "";
  };

  const isTimedtext = (url: string) => url.includes(TIMEDTEXT_PATH);

  const capture = (url: string, body: string) => {
    if (!body || body.length > MAX_BODY_CHARS) return;
    buffer.push({ url, body });
    if (buffer.length > MAX_BUFFER) buffer.shift();
    post({ kind: "timedtext", url, body });
  };

  try {
    // 1. fetch: trong suốt — luôn trả response gốc, không throw thêm
    const origFetch = window.fetch;
    const patchedFetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const p = origFetch.apply(this as typeof window, args);
      try {
        const url = toUrlString(args[0]);
        if (url && isTimedtext(url)) {
          p.then((resp) => {
            try {
              resp
                .clone()
                .text()
                .then((body) => capture(new URL(url, location.href).href, body))
                .catch(() => {});
            } catch {
              /* bỏ qua */
            }
          }).catch(() => {});
        }
      } catch {
        /* bỏ qua */
      }
      return p;
    };
    try {
      Object.defineProperty(patchedFetch, "toString", {
        value: () => "function fetch() { [native code] }",
        configurable: true,
      });
    } catch {
      /* bỏ qua */
    }
    window.fetch = patchedFetch as typeof fetch;

    // 2. XHR
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        (this as unknown as { __stUrl?: string }).__stUrl = toUrlString(args[1]);
      } catch {
        /* bỏ qua */
      }
      return (origOpen as (...a: unknown[]) => void).apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        const url = (this as unknown as { __stUrl?: string }).__stUrl;
        if (url && isTimedtext(url)) {
          this.addEventListener("load", () => {
            try {
              const rt = this.responseType;
              const body =
                rt === "" || rt === "text"
                  ? this.responseText
                  : rt === "json" && this.response
                    ? JSON.stringify(this.response)
                    : "";
              capture(new URL(url, location.href).href, body);
            } catch {
              /* bỏ qua */
            }
          });
        }
      } catch {
        /* bỏ qua */
      }
      return (origSend as (...a: unknown[]) => void).apply(this, args);
    } as typeof XMLHttpRequest.prototype.send;

    const player = () => document.getElementById("movie_player") as unknown as AnyPlayer | null;

    const captionsOn = (p: AnyPlayer | null): boolean => {
      try {
        const t = p?.getOption?.("captions", "track");
        return Boolean(t && t.languageCode);
      } catch {
        return false;
      }
    };

    // 3. Lệnh từ content script
    window.addEventListener("message", (event: MessageEvent) => {
      try {
        if (event.source !== window && event.source !== null) return;
        const msg = event.data;
        if (!msg || msg.source !== "subtrans-cs") return;

        switch (msg.kind) {
          case "replay": {
            for (const c of buffer) post({ kind: "timedtext", url: c.url, body: c.body });
            break;
          }
          case "getPlayerResponse": {
            const pr = player()?.getPlayerResponse?.() || (w.ytInitialPlayerResponse as any) || null;
            const vd = pr?.videoDetails;
            const live = pr?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
            const data = pr
              ? {
                  videoId: vd?.videoId,
                  title: vd?.title,
                  isLiveContent: Boolean(vd?.isLiveContent),
                  // Đang phát trực tiếp (VOD của livestream đã kết thúc vẫn có isLiveContent=true)
                  isLiveNow: Boolean(vd?.isLive || live?.isLiveNow),
                  captionTracks: (pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map(
                    (t: any) => ({
                      baseUrl: t.baseUrl,
                      languageCode: t.languageCode,
                      kind: t.kind,
                      name: t.name?.simpleText || (Array.isArray(t.name?.runs) ? t.name.runs[0]?.text : "") || "",
                    })
                  ),
                }
              : null;
            post({ kind: "playerResponse", reqId: msg.reqId, data });
            break;
          }
          case "fetchTimedtext": {
            const { reqId, url } = msg;
            let target: URL | null = null;
            try {
              target = new URL(String(url), location.href);
            } catch {
              target = null;
            }
            // Chỉ cho tải đúng endpoint timedtext cùng origin
            if (!target || target.origin !== location.origin || target.pathname !== TIMEDTEXT_PATH) {
              post({ kind: "fetchTimedtext.result", reqId, ok: false, error: "URL không hợp lệ" });
              break;
            }
            origFetch(target.href, { credentials: "same-origin" })
              .then(async (res) => {
                const text = await res.text();
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                post({ kind: "fetchTimedtext.result", reqId, ok: true, status: res.status, text });
              })
              .catch((err) =>
                post({ kind: "fetchTimedtext.result", reqId, ok: false, error: String(err?.message || err) })
              );
            break;
          }
          case "ensureCaptions": {
            // Bật module phụ đề → player tự gửi request timedtext có pot (hook sẽ bắt được)
            const p = player();
            const wasOn = captionsOn(p);
            let ok = false;
            try {
              if (!wasOn) p?.loadModule?.("captions");
              ok = typeof p?.loadModule === "function";
            } catch {
              ok = false;
            }
            post({ kind: "ensureCaptions.result", reqId: msg.reqId, ok, wasOn });
            break;
          }
          case "restoreCaptions": {
            // Chỉ tắt nếu chính SubTrans đã bật (content quyết định)
            try {
              player()?.unloadModule?.("captions");
            } catch {
              /* bỏ qua */
            }
            break;
          }
        }
      } catch {
        /* luôn an toàn */
      }
    });

    if (import.meta.env?.DEV) {
      console.log("[SubTrans] YT hook loaded in MAIN world");
    }
  } catch {
    /* không làm gián đoạn trang */
  }
})();

export {};
