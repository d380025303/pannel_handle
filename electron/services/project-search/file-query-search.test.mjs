import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectSearchService } from "./project-search-service.cjs";

describe("file regex worker isolation", () => {
  it.each(["searchFiles", "searchWorkspaceEntries"])("times out %s while timers stay responsive and recovers", async (method) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-regex-"));
    try {
      fs.writeFileSync(path.join(dir, `${"a".repeat(28)}!.txt`), "");
      fs.writeFileSync(path.join(dir, "Normal.TXT"), "");
      const service = createProjectSearchService({
        terminalManager: { getSession: () => ({ type: "windows", cwd: dir }) },
        fileRegexTimeoutMs: 500
      });
      let ticks = 0;
      const heartbeat = setInterval(() => { ticks += 1; }, 10);
      try {
        await expect(service[method]("run-1", "(a+)+$", undefined, { regex: true }))
          .rejects.toMatchObject({ code: "SEARCH_TIMEOUT" });
        expect(ticks).toBeGreaterThan(5);
      } finally {
        clearInterval(heartbeat);
      }
      const result = await service[method]("run-1", "^normal\\.txt$", undefined, { regex: true });
      expect(result.results.map((entry) => entry.name)).toEqual(["Normal.TXT"]);
      const sensitive = await service[method]("run-1", "^normal", undefined, { regex: true, caseSensitive: true });
      expect(sensitive.results).toEqual([]);
      await expect(service[method]("run-1", "[", undefined, { regex: true })).rejects.toThrow(/regular expression/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out matching SSH entries", async () => {
    const service = createProjectSearchService({
      terminalManager: { getSession: () => ({ type: "ssh", cwd: "/work" }) },
      remoteFileService: {
        getHome: async () => "/home/user",
        list: async () => [{ name: `${"a".repeat(28)}!.txt`, path: "/work/bad.txt", type: "file" }]
      },
      fileRegexTimeoutMs: 500
    });
    await expect(service.searchWorkspaceEntries("ssh-1", "(a+)+$", undefined, { regex: true }))
      .rejects.toMatchObject({ code: "SEARCH_TIMEOUT" });
  });
});
