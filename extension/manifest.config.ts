import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "SubTrans – Phụ đề song ngữ",
  version: pkg.version,
  minimum_chrome_version: "116",
  permissions: ["storage", "unlimitedStorage"],
  host_permissions: [
    "https://translate.googleapis.com/*",
    "https://generativelanguage.googleapis.com/*",
    "<all_urls>"
  ],
  background: {
    service_worker: "src/background/index.ts",
    type: "module"
  },
  content_scripts: [
    {
      matches: ["https://www.youtube.com/*"],
      js: ["src/content/yt-hook.ts"],
      run_at: "document_start",
      world: "MAIN"
    },
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: true
    }
  ],
  action: {
    default_popup: "src/popup/index.html",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  options_page: "src/options/index.html",
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
});
