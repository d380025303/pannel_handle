import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { readOpenCodeExport } = require("./opencode-export.cjs");
const { createAgentTokenStatsService } = require("./agent-token-stats-service.cjs");
const session = { id: "panel", type: "wsl", wslDistro: "Ubuntu", cwd: "/project" };
const limit = 64 * 1024 * 1024;

function fakeSpawn(responses) {
  const children = [];
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    children.push(child);
    const response = responses.shift();
    queueMicrotask(() => {
      if (response.error) return child.emit("error", response.error);
      for (const chunk of response.stdout || []) child.stdout.emit("data", chunk);
      for (const chunk of response.stderr || []) child.stderr.emit("data", chunk);
      child.emit("close", response.code ?? 0);
    });
    return child;
  });
  return { spawn, children };
}

function splitPositions(bytes) {
  return Array.from({ length: bytes.length - 1 }, (_, i) => i + 1)
    .filter(i => (bytes[i] & 0xc0) === 0x80);
}

async function readTranscript(response) {
  const process = fakeSpawn([{ stdout: [Buffer.from('["/tmp/session.jsonl"]')] }, response]);
  const update = vi.fn();
  const service = createAgentTokenStatsService({ terminalManager: {}, statsStore: { update },
    spawn: process.spawn, retryDelaysMs: [0] });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await service.recordGraphicalCodeBuddy({ threadId: "thread", session });
    return { update, errors: [...error.mock.calls], children: process.children };
  } finally { service.shutdown(); error.mockRestore(); }
}

describe("token subprocess output", () => {
  const model = "模型😀";
  const exported = Buffer.from(JSON.stringify({ info: { id: "thread", model: { providerID: "provider", id: model } }, messages: [] }));
  const transcript = Buffer.from(JSON.stringify({ files: [[JSON.stringify({ type: "message",
    providerData: { messageId: "message", model, usage: { inputTokens: 2, outputTokens: 1 } } })]] }));

  it("preserves model names at every multibyte split in OpenCode exports", async () => {
    for (const position of splitPositions(exported)) {
      const { spawn } = fakeSpawn([{ stdout: [exported.subarray(0, position), exported.subarray(position)] }]);
      const result = await readOpenCodeExport({ threadId: "thread", session, spawn });
      expect(result.models).toEqual([`provider/${model}`]);
    }
  });

  it("preserves model names at every multibyte split in transcript output", async () => {
    for (const position of splitPositions(transcript)) {
      const { update, errors } = await readTranscript({ stdout: [transcript.subarray(0, position), transcript.subarray(position)] });
      expect(errors).toEqual([]);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ models: [model] }));
    }
  });

  it("rejects oversized raw output even when the process exits successfully", async () => {
    const chunks = [Buffer.alloc(limit, 0x20), Buffer.from("x")];
    const process = fakeSpawn([{ stdout: chunks }]);
    await expect(readOpenCodeExport({ threadId: "thread", session, spawn: process.spawn })).rejects.toThrow("size limit");
    expect(process.children[0].kill).toHaveBeenCalled();
    const result = await readTranscript({ stdout: chunks });
    expect(result.update).not.toHaveBeenCalled();
    expect(result.errors[0][1].message).toContain("size limit");
    expect(result.children[1].kill).toHaveBeenCalled();
  });

  it("accepts exports exactly at the raw byte limit", async () => {
    const { spawn } = fakeSpawn([{ stdout: [exported, Buffer.alloc(limit - exported.length, 0x20)] }]);
    expect((await readOpenCodeExport({ threadId: "thread", session, spawn })).models).toEqual([`provider/${model}`]);
  });

  it("preserves split stderr on process failure and flushes trailing bytes", async () => {
    const bytes = Buffer.from("失败");
    const stderr = [bytes.subarray(0, 1), bytes.subarray(1), Buffer.from([0xe6])];
    const { spawn } = fakeSpawn([{ stderr, code: 1 }]);
    await expect(readOpenCodeExport({ threadId: "thread", session, spawn })).rejects.toThrow("失败�");
    const result = await readTranscript({ stderr, code: 1 });
    expect(result.update).not.toHaveBeenCalled();
    expect(result.errors[0][1].message).toBe("失败�");
  });

  it("propagates spawn errors", async () => {
    const error = new Error("spawn failed");
    const { spawn } = fakeSpawn([{ error }]);
    await expect(readOpenCodeExport({ threadId: "thread", session, spawn })).rejects.toBe(error);
    const result = await readTranscript({ error });
    expect(result.update).not.toHaveBeenCalled();
    expect(result.errors[0][1]).toBe(error);
  });
});
