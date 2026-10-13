import { describe, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
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


describe("batched file regex search", () => {
  function sshService(entries, overrides = {}) {
    return createProjectSearchService({
      terminalManager: { getSession: () => ({ type: "ssh", cwd: "/work" }) },
      remoteFileService: {
        getHome: async () => "/home/user",
        list: async (sessionId, root) => entries[root] || []
      },
      ...overrides
    });
  }

  it("uses 391 bounded Worker messages for 100,000 nonmatching SSH entries", async () => {
    const entries = Array.from({ length: 100000 }, (_, index) => ({
      name: `file-${index}.txt`, path: `/work/file-${index}.txt`, type: "file"
    }));
    const postMessage = vi.spyOn(Worker.prototype, "postMessage");
    try {
      const service = sshService({ "/work": entries });
      const timings = [];
      for (let run = 0; run < 3; run += 1) {
        postMessage.mockClear();
        const start = performance.now();
        expect((await service.searchWorkspaceEntries("ssh", "nonexistent", undefined, { regex: true })).results).toEqual([]);
        timings.push(Math.round(performance.now() - start));
        expect(postMessage).toHaveBeenCalledTimes(391);
        expect(postMessage.mock.calls.every(([message]) => message.entries.length <= 256)).toBe(true);
      }
      console.log("100k SSH regex no-match (ms):", timings);
    } finally {
      postMessage.mockRestore();
    }
  }, 30000);

  it("preserves traversal order and matches relative paths across partial batches", async () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      name: `file-${index}`, path: `/work/folder/file-${index}`, type: "file"
    }));
    const service = sshService({
      "/work": [{ name: "folder", path: "/work/folder", type: "directory" }],
      "/work/folder": entries
    });
    const result = await service.searchWorkspaceEntries("ssh", "^folder/file-(0|255|256|299)$", undefined, { regex: true });
    expect(result.results.map(entry => entry.relativePath)).toEqual(["folder/file-0", "folder/file-255", "folder/file-256", "folder/file-299"]);
  });

  it("stops matching at 200 results before a catastrophic entry in the same batch", async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      name: `hit-${index}`, path: `/work/hit-${index}`, type: "file"
    }));
    entries.push({ name: `${"a".repeat(28)}!`, path: "/work/bad", type: "file" });
    const service = sshService({ "/work": entries }, { fileRegexTimeoutMs: 500 });
    const result = await service.searchWorkspaceEntries("ssh", "^hit-|(a+)+$", undefined, { regex: true });
    expect(result.results.map(entry => entry.name)).toEqual(entries.slice(0, 200).map(entry => entry.name));
  });
});
