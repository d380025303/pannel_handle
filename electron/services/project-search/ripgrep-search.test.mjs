import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runRipgrepSearch, createRipgrepInvocation } from "./ripgrep-search.cjs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";

function searchChunks(chunks) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  const result = runRipgrepSearch({
    spawnProcess: () => child,
    invocation: { command: "rg", args: [], cwd: "C:\\workspace" },
    session: { type: "windows" },
    displayRoot: "C:\\workspace",
    task: {}
  });
  for (const chunk of chunks) child.stdout.write(chunk);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0);
  return result;
}

describe("runRipgrepSearch UTF-8 streaming", () => {
  it.each(["\n", "\r\n", ""])("preserves paths, text and match positions at every byte boundary with %j terminator", async (terminator) => {
    const line = "前缀中文匹配😀后缀";
    const query = "中文匹配😀";
    const start = Buffer.byteLength("前缀", "utf8");
    const output = Buffer.from(JSON.stringify({
      type: "match",
      data: {
        path: { text: "中文.txt" },
        lines: { text: `${line}\n` },
        line_number: 7,
        submatches: [{ start, end: start + Buffer.byteLength(query, "utf8") }]
      }
    }) + terminator, "utf8");
    const expected = await searchChunks([output]);
    expect(expected).toEqual([{
      path: path.join("C:\\workspace", "中文.txt"),
      relativePath: "中文.txt",
      name: "中文.txt",
      lineNumber: 7,
      line,
      matchStart: 2,
      matchLength: query.length
    }]);
    for (let boundary = 1; boundary < output.length; boundary += 1) {
      expect(await searchChunks([output.subarray(0, boundary), output.subarray(boundary)]), `byte boundary ${boundary}`).toEqual(expected);
    }
    expect(await searchChunks(Array.from(output, (byte) => Buffer.from([byte])))).toEqual(expected);
  }, 60000);
});

describe("real ripgrep dense long lines", () => {
  it("keeps results and timers responsive at 256 KiB and 1 MiB", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rg-dense-"));
    try {
      for (const size of [256 * 1024, 1024 * 1024]) {
        await fs.writeFile(path.join(root, "dense.txt"), "a".repeat(size));
        const session = { type: "windows" };
        const invocation = await createRipgrepInvocation(session, "a", undefined, root);
        let previous = performance.now();
        let maxGap = 0;
        const started = previous;
        const timer = setInterval(() => {
          const now = performance.now();
          maxGap = Math.max(maxGap, now - previous);
          previous = now;
        }, 5);
        let results;
        try {
          results = await runRipgrepSearch({ spawnProcess: spawn, invocation, session, displayRoot: root, task: {} });
          maxGap = Math.max(maxGap, performance.now() - previous);
        } finally { clearInterval(timer); }
        console.log(JSON.stringify({ size, elapsedMs: performance.now() - started, maxGap }));
        expect(results).toEqual([{
          path: path.join(root, "dense.txt"), relativePath: "dense.txt", name: "dense.txt",
          lineNumber: 1, line: "a".repeat(121), matchStart: 0, matchLength: 1
        }]);
        expect(maxGap).toBeLessThan(100);
      }
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }, 20000);

  it.each(["cancel", "timeout"])("interrupts parsing promptly on %s", async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rg-stop-"));
    try {
      await fs.writeFile(path.join(root, "dense.txt"), "a".repeat(1024 * 1024));
      const session = { type: "windows" };
      const invocation = await createRipgrepInvocation(session, "a", undefined, root);
      const task = {};
      const started = performance.now();
      let stopTimer;
      const pending = runRipgrepSearch({
        spawnProcess: (...args) => {
          const child = spawn(...args);
          if (mode === "cancel") child.stdout.once("data", () => {
            stopTimer = setTimeout(() => { task.cancelled = true; task.cancelMatching(); }, 20);
          });
          return child;
        }, invocation, session, displayRoot: root, task, timeoutMs: mode === "timeout" ? 100 : 30000
      });
      await expect(pending).rejects.toMatchObject({ code: mode === "cancel" ? "SEARCH_CANCELLED" : "SEARCH_TIMEOUT" });
      clearTimeout(stopTimer);
      expect(performance.now() - started).toBeLessThan(500);
      expect(task.child).toBeNull();
      expect(task.cancelMatching).toBeNull();
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});

it("caps match records at 300 and ignores malformed records", async () => {
  const record = JSON.stringify({ type: "match", data: {
    path: { text: "many.txt" }, lines: { text: "a\n" }, line_number: 1,
    submatches: [{ start: 0, end: 1 }]
  } });
  const results = await searchChunks([Buffer.from("invalid\n" + (record + "\n").repeat(305))]);
  expect(results).toHaveLength(300);
  expect(results.every((result) => result.matchStart === 0 && result.matchLength === 1)).toBe(true);
});
