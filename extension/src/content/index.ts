// Điểm vào content script (ISOLATED world). Phase 0: chỉ log khi chạy bản dev.
if (import.meta.env.DEV) {
  console.log("[SubTrans] Content script loaded", location.href);
  const video = document.querySelector("video");
  if (video) {
    console.log("[SubTrans] Video detected on page load:", video);
  }
}

export {};
