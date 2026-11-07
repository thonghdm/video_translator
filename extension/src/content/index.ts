console.log("[SubTrans] Content script loaded");

const video = document.querySelector("video");
if (video) {
  console.log("[SubTrans] Video detected on page load:", video);
}

export {};
