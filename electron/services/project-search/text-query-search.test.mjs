import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectSearchService } from "./project-search-service.cjs";

async function withService(test, timeoutMs = 500) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-text-regex-"));
  fs.writeFileSync(path.join(dir, "bad.txt"), `${"a".repeat(30)}!`);
  fs.writeFileSync(path.join(dir, "normal.txt"), "prefix HELLO123 suffix\nhello456\nhello1234");
  const service = createProjectSearchService({
    terminalManager: { getSession: () => ({ type: "windows", cwd: dir }) },
    forceTextFallback: true,
    textRegexTimeoutMs: timeoutMs
  });
  try {
    await test(service);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("fallback text regex worker isolation", () => {
  it("times out catastrophic backtracking while the event loop remains responsive", async () => {
    await withService(async (service) => {
      let ticks = 0;
      const heartbeat = setInterval(() => { ticks += 1; }, 10);
      try {
        await expect(service.searchText("run", "(a+)+$", "bad", undefined, { regex: true }))
          .rejects.toMatchObject({ code: "SEARCH_TIMEOUT" });
        expect(ticks).toBeGreaterThan(5);
      } finally {
        clearInterval(heartbeat);
      }
      const result = await service.searchText("run", "hello\\d{3}", "normal", undefined, { regex: true, wholeWord: true });
      expect(result.results.map(({ lineNumber, matchStart, matchLength }) => ({ lineNumber, matchStart, matchLength })))
        .toEqual([{ lineNumber: 1, matchStart: 7, matchLength: 8 }, { lineNumber: 2, matchStart: 0, matchLength: 8 }]);
      const sensitive = await service.searchText("run", "hello\\d{3}", "sensitive", undefined,
        { regex: true, wholeWord: true, caseSensitive: true });
      expect(sensitive.results.map((entry) => entry.lineNumber)).toEqual([2]);
      await expect(service.searchText("run", "[", "invalid", undefined, { regex: true }))
        .rejects.toThrow(/regular expression/i);
    });
  });

  it.each([false, true])("terminates a busy worker when replaced=%s", async (replace) => {
    await withService(async (service) => {
      const started = Date.now();
      const pending = service.searchText("run", "(a+)+$", "bad", undefined, { regex: true });
      const cancelled = expect(pending).rejects.toMatchObject({ code: "SEARCH_CANCELLED" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (replace) {
        const result = await service.searchText("run", "HELLO123", "replacement");
        expect(result.results).toHaveLength(2);
      } else {
        expect(service.cancelTextSearch("run", "other")).toBe(false);
        expect(service.cancelTextSearch("run", "bad")).toBe(true);
      }
      await cancelled;
      expect(Date.now() - started).toBeLessThan(2000);
      expect(service.cancelTextSearch("run", "bad")).toBe(false);
    }, 5000);
  });
});
