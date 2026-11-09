// vite.config.ts
import { defineConfig } from "file:///D:/KhoaHoc/CODE/video_translator/extension/node_modules/.pnpm/vite@5.4.21/node_modules/vite/dist/node/index.js";
import react from "file:///D:/KhoaHoc/CODE/video_translator/extension/node_modules/.pnpm/@vitejs+plugin-react@4.7.0_vite@5.4.21/node_modules/@vitejs/plugin-react/dist/index.js";
import { crx } from "file:///D:/KhoaHoc/CODE/video_translator/extension/node_modules/.pnpm/@crxjs+vite-plugin@2.7.1_vite@5.4.21/node_modules/@crxjs/vite-plugin/dist/index.mjs";

// manifest.config.ts
import { defineManifest } from "file:///D:/KhoaHoc/CODE/video_translator/extension/node_modules/.pnpm/@crxjs+vite-plugin@2.7.1_vite@5.4.21/node_modules/@crxjs/vite-plugin/dist/index.mjs";

// package.json
var package_default = {
  name: "subtrans-extension",
  private: true,
  version: "0.1.0",
  type: "module",
  engines: {
    node: ">=18"
  },
  scripts: {
    dev: "vite",
    build: "tsc --noEmit && vite build && node scripts/verify-dist.mjs",
    zip: "pnpm run build && node scripts/zip.mjs",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    verify: "node scripts/verify-dist.mjs"
  },
  dependencies: {
    clsx: "^2.1.1",
    idb: "^8.0.0",
    "lucide-react": "^1.16.0",
    react: "^18.3.1",
    "react-dom": "^18.3.1"
  },
  devDependencies: {
    "@crxjs/vite-plugin": "^2.7.1",
    "@types/chrome": "^0.0.280",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    autoprefixer: "^10.4.20",
    "fake-indexeddb": "^6.0.0",
    jsdom: "^25.0.1",
    postcss: "^8.4.47",
    tailwindcss: "^3.4.14",
    typescript: "^5.6.3",
    vite: "^5.4.10",
    vitest: "^2.1.4"
  }
};

// manifest.config.ts
var manifest_config_default = defineManifest({
  manifest_version: 3,
  name: "SubTrans \u2013 Ph\u1EE5 \u0111\u1EC1 song ng\u1EEF",
  version: package_default.version,
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
      matches: [
        "https://*.youtube.com/*",
        "https://youtube.googleapis.com/*",
        "https://*.youtube-nocookie.com/*",
        "https://drive.google.com/*"
      ],
      js: ["src/content/yt-hook.ts"],
      run_at: "document_start",
      world: "MAIN",
      all_frames: true
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

// vite.config.ts
var vite_config_default = defineConfig({
  plugins: [
    react(),
    crx({ manifest: manifest_config_default })
  ],
  build: {
    target: "esnext"
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiLCAibWFuaWZlc3QuY29uZmlnLnRzIiwgInBhY2thZ2UuanNvbiJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkQ6XFxcXEtob2FIb2NcXFxcQ09ERVxcXFx2aWRlb190cmFuc2xhdG9yXFxcXGV4dGVuc2lvblwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRDpcXFxcS2hvYUhvY1xcXFxDT0RFXFxcXHZpZGVvX3RyYW5zbGF0b3JcXFxcZXh0ZW5zaW9uXFxcXHZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9EOi9LaG9hSG9jL0NPREUvdmlkZW9fdHJhbnNsYXRvci9leHRlbnNpb24vdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHJlYWN0IGZyb20gXCJAdml0ZWpzL3BsdWdpbi1yZWFjdFwiO1xuaW1wb3J0IHsgY3J4IH0gZnJvbSBcIkBjcnhqcy92aXRlLXBsdWdpblwiO1xuaW1wb3J0IG1hbmlmZXN0IGZyb20gXCIuL21hbmlmZXN0LmNvbmZpZ1wiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbXG4gICAgcmVhY3QoKSxcbiAgICBjcngoeyBtYW5pZmVzdCB9KVxuICBdLFxuICBidWlsZDoge1xuICAgIHRhcmdldDogXCJlc25leHRcIlxuICB9XG59KTtcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiRDpcXFxcS2hvYUhvY1xcXFxDT0RFXFxcXHZpZGVvX3RyYW5zbGF0b3JcXFxcZXh0ZW5zaW9uXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJEOlxcXFxLaG9hSG9jXFxcXENPREVcXFxcdmlkZW9fdHJhbnNsYXRvclxcXFxleHRlbnNpb25cXFxcbWFuaWZlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9EOi9LaG9hSG9jL0NPREUvdmlkZW9fdHJhbnNsYXRvci9leHRlbnNpb24vbWFuaWZlc3QuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lTWFuaWZlc3QgfSBmcm9tIFwiQGNyeGpzL3ZpdGUtcGx1Z2luXCI7XG5pbXBvcnQgcGtnIGZyb20gXCIuL3BhY2thZ2UuanNvblwiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVNYW5pZmVzdCh7XG4gIG1hbmlmZXN0X3ZlcnNpb246IDMsXG4gIG5hbWU6IFwiU3ViVHJhbnMgXHUyMDEzIFBoXHUxRUU1IFx1MDExMVx1MUVDMSBzb25nIG5nXHUxRUVGXCIsXG4gIHZlcnNpb246IHBrZy52ZXJzaW9uLFxuICBtaW5pbXVtX2Nocm9tZV92ZXJzaW9uOiBcIjExNlwiLFxuICBwZXJtaXNzaW9uczogW1wic3RvcmFnZVwiLCBcInVubGltaXRlZFN0b3JhZ2VcIl0sXG4gIGhvc3RfcGVybWlzc2lvbnM6IFtcbiAgICBcImh0dHBzOi8vdHJhbnNsYXRlLmdvb2dsZWFwaXMuY29tLypcIixcbiAgICBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tLypcIixcbiAgICBcIjxhbGxfdXJscz5cIlxuICBdLFxuICBiYWNrZ3JvdW5kOiB7XG4gICAgc2VydmljZV93b3JrZXI6IFwic3JjL2JhY2tncm91bmQvaW5kZXgudHNcIixcbiAgICB0eXBlOiBcIm1vZHVsZVwiXG4gIH0sXG4gIGNvbnRlbnRfc2NyaXB0czogW1xuICAgIHtcbiAgICAgIG1hdGNoZXM6IFtcbiAgICAgICAgXCJodHRwczovLyoueW91dHViZS5jb20vKlwiLFxuICAgICAgICBcImh0dHBzOi8veW91dHViZS5nb29nbGVhcGlzLmNvbS8qXCIsXG4gICAgICAgIFwiaHR0cHM6Ly8qLnlvdXR1YmUtbm9jb29raWUuY29tLypcIixcbiAgICAgICAgXCJodHRwczovL2RyaXZlLmdvb2dsZS5jb20vKlwiXG4gICAgICBdLFxuICAgICAganM6IFtcInNyYy9jb250ZW50L3l0LWhvb2sudHNcIl0sXG4gICAgICBydW5fYXQ6IFwiZG9jdW1lbnRfc3RhcnRcIixcbiAgICAgIHdvcmxkOiBcIk1BSU5cIixcbiAgICAgIGFsbF9mcmFtZXM6IHRydWVcbiAgICB9LFxuICAgIHtcbiAgICAgIG1hdGNoZXM6IFtcIjxhbGxfdXJscz5cIl0sXG4gICAgICBqczogW1wic3JjL2NvbnRlbnQvaW5kZXgudHNcIl0sXG4gICAgICBydW5fYXQ6IFwiZG9jdW1lbnRfaWRsZVwiLFxuICAgICAgYWxsX2ZyYW1lczogdHJ1ZVxuICAgIH1cbiAgXSxcbiAgYWN0aW9uOiB7XG4gICAgZGVmYXVsdF9wb3B1cDogXCJzcmMvcG9wdXAvaW5kZXguaHRtbFwiLFxuICAgIGRlZmF1bHRfaWNvbjoge1xuICAgICAgXCIxNlwiOiBcImljb25zL2ljb24tMTYucG5nXCIsXG4gICAgICBcIjMyXCI6IFwiaWNvbnMvaWNvbi0zMi5wbmdcIixcbiAgICAgIFwiNDhcIjogXCJpY29ucy9pY29uLTQ4LnBuZ1wiLFxuICAgICAgXCIxMjhcIjogXCJpY29ucy9pY29uLTEyOC5wbmdcIlxuICAgIH1cbiAgfSxcbiAgb3B0aW9uc19wYWdlOiBcInNyYy9vcHRpb25zL2luZGV4Lmh0bWxcIixcbiAgaWNvbnM6IHtcbiAgICBcIjE2XCI6IFwiaWNvbnMvaWNvbi0xNi5wbmdcIixcbiAgICBcIjMyXCI6IFwiaWNvbnMvaWNvbi0zMi5wbmdcIixcbiAgICBcIjQ4XCI6IFwiaWNvbnMvaWNvbi00OC5wbmdcIixcbiAgICBcIjEyOFwiOiBcImljb25zL2ljb24tMTI4LnBuZ1wiXG4gIH1cbn0pO1xuIiwgIntcbiAgXCJuYW1lXCI6IFwic3VidHJhbnMtZXh0ZW5zaW9uXCIsXG4gIFwicHJpdmF0ZVwiOiB0cnVlLFxuICBcInZlcnNpb25cIjogXCIwLjEuMFwiLFxuICBcInR5cGVcIjogXCJtb2R1bGVcIixcbiAgXCJlbmdpbmVzXCI6IHtcbiAgICBcIm5vZGVcIjogXCI+PTE4XCJcbiAgfSxcbiAgXCJzY3JpcHRzXCI6IHtcbiAgICBcImRldlwiOiBcInZpdGVcIixcbiAgICBcImJ1aWxkXCI6IFwidHNjIC0tbm9FbWl0ICYmIHZpdGUgYnVpbGQgJiYgbm9kZSBzY3JpcHRzL3ZlcmlmeS1kaXN0Lm1qc1wiLFxuICAgIFwiemlwXCI6IFwicG5wbSBydW4gYnVpbGQgJiYgbm9kZSBzY3JpcHRzL3ppcC5tanNcIixcbiAgICBcInR5cGVjaGVja1wiOiBcInRzYyAtLW5vRW1pdFwiLFxuICAgIFwidGVzdFwiOiBcInZpdGVzdCBydW5cIixcbiAgICBcInZlcmlmeVwiOiBcIm5vZGUgc2NyaXB0cy92ZXJpZnktZGlzdC5tanNcIlxuICB9LFxuICBcImRlcGVuZGVuY2llc1wiOiB7XG4gICAgXCJjbHN4XCI6IFwiXjIuMS4xXCIsXG4gICAgXCJpZGJcIjogXCJeOC4wLjBcIixcbiAgICBcImx1Y2lkZS1yZWFjdFwiOiBcIl4xLjE2LjBcIixcbiAgICBcInJlYWN0XCI6IFwiXjE4LjMuMVwiLFxuICAgIFwicmVhY3QtZG9tXCI6IFwiXjE4LjMuMVwiXG4gIH0sXG4gIFwiZGV2RGVwZW5kZW5jaWVzXCI6IHtcbiAgICBcIkBjcnhqcy92aXRlLXBsdWdpblwiOiBcIl4yLjcuMVwiLFxuICAgIFwiQHR5cGVzL2Nocm9tZVwiOiBcIl4wLjAuMjgwXCIsXG4gICAgXCJAdHlwZXMvcmVhY3RcIjogXCJeMTguMy4xMlwiLFxuICAgIFwiQHR5cGVzL3JlYWN0LWRvbVwiOiBcIl4xOC4zLjFcIixcbiAgICBcIkB2aXRlanMvcGx1Z2luLXJlYWN0XCI6IFwiXjQuMy4zXCIsXG4gICAgXCJhdXRvcHJlZml4ZXJcIjogXCJeMTAuNC4yMFwiLFxuICAgIFwiZmFrZS1pbmRleGVkZGJcIjogXCJeNi4wLjBcIixcbiAgICBcImpzZG9tXCI6IFwiXjI1LjAuMVwiLFxuICAgIFwicG9zdGNzc1wiOiBcIl44LjQuNDdcIixcbiAgICBcInRhaWx3aW5kY3NzXCI6IFwiXjMuNC4xNFwiLFxuICAgIFwidHlwZXNjcmlwdFwiOiBcIl41LjYuM1wiLFxuICAgIFwidml0ZVwiOiBcIl41LjQuMTBcIixcbiAgICBcInZpdGVzdFwiOiBcIl4yLjEuNFwiXG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBMFQsU0FBUyxvQkFBb0I7QUFDdlYsT0FBTyxXQUFXO0FBQ2xCLFNBQVMsV0FBVzs7O0FDRjhTLFNBQVMsc0JBQXNCOzs7QUNBalc7QUFBQSxFQUNFLE1BQVE7QUFBQSxFQUNSLFNBQVc7QUFBQSxFQUNYLFNBQVc7QUFBQSxFQUNYLE1BQVE7QUFBQSxFQUNSLFNBQVc7QUFBQSxJQUNULE1BQVE7QUFBQSxFQUNWO0FBQUEsRUFDQSxTQUFXO0FBQUEsSUFDVCxLQUFPO0FBQUEsSUFDUCxPQUFTO0FBQUEsSUFDVCxLQUFPO0FBQUEsSUFDUCxXQUFhO0FBQUEsSUFDYixNQUFRO0FBQUEsSUFDUixRQUFVO0FBQUEsRUFDWjtBQUFBLEVBQ0EsY0FBZ0I7QUFBQSxJQUNkLE1BQVE7QUFBQSxJQUNSLEtBQU87QUFBQSxJQUNQLGdCQUFnQjtBQUFBLElBQ2hCLE9BQVM7QUFBQSxJQUNULGFBQWE7QUFBQSxFQUNmO0FBQUEsRUFDQSxpQkFBbUI7QUFBQSxJQUNqQixzQkFBc0I7QUFBQSxJQUN0QixpQkFBaUI7QUFBQSxJQUNqQixnQkFBZ0I7QUFBQSxJQUNoQixvQkFBb0I7QUFBQSxJQUNwQix3QkFBd0I7QUFBQSxJQUN4QixjQUFnQjtBQUFBLElBQ2hCLGtCQUFrQjtBQUFBLElBQ2xCLE9BQVM7QUFBQSxJQUNULFNBQVc7QUFBQSxJQUNYLGFBQWU7QUFBQSxJQUNmLFlBQWM7QUFBQSxJQUNkLE1BQVE7QUFBQSxJQUNSLFFBQVU7QUFBQSxFQUNaO0FBQ0Y7OztBRG5DQSxJQUFPLDBCQUFRLGVBQWU7QUFBQSxFQUM1QixrQkFBa0I7QUFBQSxFQUNsQixNQUFNO0FBQUEsRUFDTixTQUFTLGdCQUFJO0FBQUEsRUFDYix3QkFBd0I7QUFBQSxFQUN4QixhQUFhLENBQUMsV0FBVyxrQkFBa0I7QUFBQSxFQUMzQyxrQkFBa0I7QUFBQSxJQUNoQjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUFBLEVBQ0EsWUFBWTtBQUFBLElBQ1YsZ0JBQWdCO0FBQUEsSUFDaEIsTUFBTTtBQUFBLEVBQ1I7QUFBQSxFQUNBLGlCQUFpQjtBQUFBLElBQ2Y7QUFBQSxNQUNFLFNBQVM7QUFBQSxRQUNQO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUFBLE1BQ0EsSUFBSSxDQUFDLHdCQUF3QjtBQUFBLE1BQzdCLFFBQVE7QUFBQSxNQUNSLE9BQU87QUFBQSxNQUNQLFlBQVk7QUFBQSxJQUNkO0FBQUEsSUFDQTtBQUFBLE1BQ0UsU0FBUyxDQUFDLFlBQVk7QUFBQSxNQUN0QixJQUFJLENBQUMsc0JBQXNCO0FBQUEsTUFDM0IsUUFBUTtBQUFBLE1BQ1IsWUFBWTtBQUFBLElBQ2Q7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFRO0FBQUEsSUFDTixlQUFlO0FBQUEsSUFDZixjQUFjO0FBQUEsTUFDWixNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixPQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFBQSxFQUNBLGNBQWM7QUFBQSxFQUNkLE9BQU87QUFBQSxJQUNMLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxFQUNUO0FBQ0YsQ0FBQzs7O0FEakRELElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVM7QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLElBQUksRUFBRSxrQ0FBUyxDQUFDO0FBQUEsRUFDbEI7QUFBQSxFQUNBLE9BQU87QUFBQSxJQUNMLFFBQVE7QUFBQSxFQUNWO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
