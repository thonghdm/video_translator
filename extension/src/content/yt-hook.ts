// Hook chạy trong MAIN world (document_start).
// Lưu ý: file này phải luôn build ra script tự chứa (xem scripts/verify-dist.mjs).

(function () {
  try {
    const origFetch = window.fetch;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    // 1. Patch window.fetch để bắt /api/timedtext
    window.fetch = async function (...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : args[0] && typeof args[0] === "object" && "url" in args[0]
            ? (args[0] as Request).url
            : "";
        if (url && url.includes("/api/timedtext")) {
          const clone = resp.clone();
          clone
            .text()
            .then((body) => {
              window.postMessage(
                { source: "subtrans-yt", kind: "timedtext", url, body },
                location.origin
              );
            })
            .catch(() => {});
        }
      } catch {
        // Luôn trong suốt, không bao giờ throw lỗi ra trang YouTube
      }
      return resp;
    };

    try {
      Object.defineProperty(window.fetch, "toString", {
        value: function () {
          return "function fetch() { [native code] }";
        },
        configurable: true,
      });
    } catch {}

    // 2. Patch XMLHttpRequest để bắt /api/timedtext
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
      try {
        (this as any).__st_url = typeof url === "string" ? url : url.toString();
      } catch {}
      return origOpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.send = function (...args: any[]) {
      try {
        const url = (this as any).__st_url;
        if (url && typeof url === "string" && url.includes("/api/timedtext")) {
          this.addEventListener("load", function () {
            try {
              const body = typeof this.responseText === "string" ? this.responseText : "";
              window.postMessage(
                { source: "subtrans-yt", kind: "timedtext", url, body },
                location.origin
              );
            } catch {}
          });
        }
      } catch {}
      return origSend.apply(this, args as any);
    };

    // 3. Lắng nghe yêu cầu từ Content Script (subtrans-cs)
    window.addEventListener("message", (event) => {
      try {
        if (event.source && event.source !== window) return;
        if (
          event.origin &&
          location.origin &&
          location.origin !== "null" &&
          event.origin !== location.origin
        ) {
          return;
        }
        const msg = event.data;
        if (!msg || msg.source !== "subtrans-cs") return;

        if (msg.kind === "getPlayerResponse") {
          const player = document.getElementById("movie_player") as any;
          const pr =
            (typeof player?.getPlayerResponse === "function" && player.getPlayerResponse()) ||
            (window as any).ytInitialPlayerResponse ||
            null;

          const data = pr
            ? {
                videoId: pr.videoDetails?.videoId,
                title: pr.videoDetails?.title,
                isLiveContent: Boolean(pr.videoDetails?.isLiveContent),
                captionTracks: (
                  pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
                ).map((t: any) => ({
                  baseUrl: t.baseUrl,
                  languageCode: t.languageCode,
                  kind: t.kind,
                  name:
                    t.name?.simpleText ||
                    (Array.isArray(t.name?.runs) ? t.name.runs[0]?.text : "") ||
                    "",
                })),
              }
            : null;

          window.postMessage(
            { source: "subtrans-yt", kind: "playerResponse", reqId: msg.reqId, data },
            location.origin
          );
        } else if (msg.kind === "fetchTimedtext") {
          const { reqId, url } = msg;
          if (!url || typeof url !== "string") return;
          origFetch(url, { credentials: "same-origin" })
            .then(async (res) => {
              if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
              }
              const text = await res.text();
              window.postMessage(
                { source: "subtrans-yt", kind: "fetchTimedtext.result", reqId, ok: true, text },
                location.origin
              );
            })
            .catch((err) => {
              window.postMessage(
                {
                  source: "subtrans-yt",
                  kind: "fetchTimedtext.result",
                  reqId,
                  ok: false,
                  error: String(err?.message || err),
                },
                location.origin
              );
            });
        }
      } catch {
        // Luôn an toàn
      }
    });

    console.log("[SubTrans] YT hook loaded in MAIN world");
  } catch {
    // Không làm gián đoạn script trang
  }
})();

export {};
