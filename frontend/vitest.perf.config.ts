import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: { include: ["perf/**/*.perf.tsx"], environment: "jsdom" },
});
