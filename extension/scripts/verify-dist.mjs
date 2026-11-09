// Kiểm tra dist/ sau khi build: bảo vệ các giả định quan trọng của Phase 0 và Phase 9.5 D6.
// 1) Content script MAIN world phải là file tự chứa (không import động, không dùng chrome.runtime),
//    vì trong MAIN world không có chrome.runtime và hook phải chạy đồng bộ ở document_start.
// 2) Phải có CSS (Tailwind) trong dist/assets.
// 3) Bảo vệ an toàn thông tin Phase 9.5 D6:
//    - Chuỗi credentials: "include" tuyệt đối không được xuất hiện trong bất kỳ content script nào
//      hoặc chunk mà content script import.
//    - Tổng số lần xuất hiện trong toàn bộ dist/**/*.js <= 1 (chỉ duy nhất trong driveFetch của service worker).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

// ---------------------------------------------------------------------------
// 3) Kiểm tra credentials: "include" (Phase 9.5 D6)
// ---------------------------------------------------------------------------
function getAllJsFiles(dir) {
  let results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getAllJsFiles(fullPath));
    } else if (entry.endsWith(".js")) {
      results.push(fullPath);
    }
  }
  return results;
}

const CREDENTIALS_INCLUDE_RE = /credentials\s*:\s*["']include["']/g;

// Thu thập toàn bộ file JS của content scripts và các chunk phụ thuộc
const contentScriptFiles = new Set();
for (const cs of manifest.content_scripts ?? []) {
  for (const file of cs.js ?? []) {
    contentScriptFiles.add(file.replace(/^[/\\]+/, ""));
  }
}
for (const war of manifest.web_accessible_resources ?? []) {
  for (const res of war.resources ?? []) {
    if (res.endsWith(".js")) {
      contentScriptFiles.add(res.replace(/^[/\\]+/, ""));
    }
  }
}

// Lần theo các import tĩnh và import động từ các file loader của content script
const queue = Array.from(contentScriptFiles);
while (queue.length > 0) {
  const relPath = queue.pop();
  const fullPath = join("dist", relPath);
  let code = "";
  try {
    code = readFileSync(fullPath, "utf8");
  } catch {
    continue;
  }
  const importRe = /(?:import\s+(?:[\w*\s{},]*from\s+)?|import\s*\(\s*)["']([^"']+)["']/g;
  let match;
  while ((match = importRe.exec(code)) !== null) {
    const importedRel = match[1];
    if (importedRel.endsWith(".js")) {
      const normalized = join(relPath, "..", importedRel).replace(/\\/g, "/");
      if (!contentScriptFiles.has(normalized)) {
        contentScriptFiles.add(normalized);
        queue.push(normalized);
      }
    }
  }
}

// Content scripts và các chunk không bao giờ được chứa credentials: "include"
for (const csFile of contentScriptFiles) {
  const fullPath = join("dist", csFile);
  try {
    const code = readFileSync(fullPath, "utf8");
    // Regex có cờ g giữ lastIndex giữa các lần .test() → reset trước mỗi file để không bỏ sót
    CREDENTIALS_INCLUDE_RE.lastIndex = 0;
    if (CREDENTIALS_INCLUDE_RE.test(code)) {
      fail(`Content script hoặc chunk phụ thuộc chứa credentials: "include": ${csFile}`);
    }
  } catch {
    // bỏ qua file không tìm thấy
  }
}

// Kiểm tra toàn bộ dist/**/*.js
const allJsFiles = getAllJsFiles("dist");
let totalMatches = 0;
const matchedFiles = [];

for (const file of allJsFiles) {
  const code = readFileSync(file, "utf8");
  const matches = code.match(CREDENTIALS_INCLUDE_RE);
  if (matches) {
    totalMatches += matches.length;
    matchedFiles.push({ file: file.replace(/\\/g, "/"), count: matches.length });
  }
}

if (totalMatches === 0) {
  fail('Không tìm thấy credentials: "include" trong dist (driveFetch bị mất hoặc không được build?)');
}

if (totalMatches > 1) {
  fail(
    `credentials: "include" xuất hiện ${totalMatches} lần trong dist (yêu cầu tối đa <= 1 lần trong service worker): ${JSON.stringify(matchedFiles)}`
  );
}

console.log("[verify-dist] OK");
