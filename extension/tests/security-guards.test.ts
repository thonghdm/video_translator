import { describe, it, expect, vi } from "vitest";
import { apiFetch } from "../src/background/engines/http";

interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  name: string;
}

interface FsModule {
  readdirSync(dir: string, options: { withFileTypes: true }): DirentLike[];
  readFileSync(path: string, encoding: string): string;
}

interface PathModule {
  resolve(...paths: string[]): string;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
}

declare const process: { cwd(): string };

describe("Security Guards", () => {
  it("apiFetch luôn ép credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'", async () => {
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;

    const mockFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      // Thử ghi đè credentials bằng "include"
      await apiFetch("https://example.com/api", {
        method: "POST",
        credentials: "include" as RequestCredentials,
        cache: "force-cache" as RequestCache,
        referrerPolicy: "unsafe-url" as ReferrerPolicy,
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(capturedInit?.credentials).toBe("omit");
      expect(capturedInit?.cache).toBe("no-store");
      expect(capturedInit?.referrerPolicy).toBe("no-referrer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("chỉ duy nhất đúng 1 file trong src/ được chứa credentials: 'include' (driveFetch.ts)", async () => {
    const fs = ((await import("" + "node:fs")) as unknown as { default: FsModule }).default ||
      ((await import("" + "node:fs")) as unknown as FsModule);
    const path = ((await import("" + "node:path")) as unknown as { default: PathModule }).default ||
      ((await import("" + "node:path")) as unknown as PathModule);

    const srcDir = path.resolve(process.cwd(), "src");
    const matchedFiles: string[] = [];
    const includePattern = /credentials\s*:\s*["']include["']/;

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (includePattern.test(content)) {
            matchedFiles.push(fullPath);
          }
        }
      }
    }

    scanDir(srcDir);

    expect(matchedFiles).toHaveLength(1);
    const relativePath = path.relative(srcDir, matchedFiles[0]).replace(/\\/g, "/");
    expect(relativePath).toBe("background/engines/driveFetch.ts");
  });
});
