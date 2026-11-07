// Kiểm tra dist/ sau khi build: bảo vệ các giả định quan trọng của Phase 0.
// 1) Content script MAIN world phải là file tự chứa (không import động, không dùng chrome.runtime),
//    vì trong MAIN world không có chrome.runtime và hook phải chạy đồng bộ ở document_start.
// 2) Phải có CSS (Tailwind) trong dist/assets.
import { readFileSync, readdirSync } from "node:fs";

const fail = (msg) => {
  console.error(`[verify-dist] LỖI: ${msg}`);
  process.exit(1);
};

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const mainWorld = (manifest.content_scripts ?? []).filter((c) => c.world === "MAIN");
if (mainWorld.length === 0) fail("thiếu content script MAIN world (yt-hook)");

for (const cs of mainWorld) {
  for (const file of cs.js) {
    const code = readFileSync(`dist/${file}`, "utf8");
    if (/\bimport\s*\(|^\s*import\s+[\w{*"']|chrome\.runtime/m.test(code)) {
      fail(`${file}: script MAIN world không được chứa import/chrome.runtime (CRXJS đã đổi sang loader?)`);
    }
  }
}

if (!readdirSync("dist/assets").some((f) => f.endsWith(".css"))) {
  fail("không thấy file .css trong dist/assets (Tailwind chưa được nạp?)");
}

console.log("[verify-dist] OK");
