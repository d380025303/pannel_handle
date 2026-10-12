import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runRipgrepSearch } from "./ripgrep-search.cjs";

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
  });
});
