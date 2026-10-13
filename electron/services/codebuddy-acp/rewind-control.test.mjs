import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { runRewindControl } = require("./rewind-control.cjs");
const sessionId = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const messageId = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

describe("CodeBuddy public rewind control", () => {
  it("sends the selected scope and parses partial success", async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); });
    child.stdin.on("data", chunk => {
      const request = JSON.parse(String(chunk));
      expect(request.request).toEqual({ subtype: "rewind", user_message_id: messageId, scope: "CodeAndConversation" });
      child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success",
        request_id: request.request_id, response: { canRewind: true, historyRewound: true,
          filesChanged: ["src/a.ts"], fileRewindError: "busy" } } }) + "\n");
    });
    const spawnProcess = vi.fn(() => child);
    await expect(runRewindControl({ sessionId, messageId, scope: "CodeAndConversation", cwd: "C:\\work",
      env: {}, spawnProcess })).resolves.toMatchObject({ historyRewound: true, fileRewindError: "busy" });
    expect(spawnProcess.mock.calls[0][1][3]).toContain(`--resume ${sessionId}`);
    expect(child.kill).toHaveBeenCalled();
  });

  it.each(["success", "spawn error", "spawn throw", "nonzero exit"])("waits for child exit after taskkill %s", async outcome => {
    const child = new EventEmitter();
    child.pid = 12345;
    child.exitCode = null;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn();
    const killer = new EventEmitter();
    const spawnKiller = vi.fn(() => {
      if (outcome === "spawn throw") throw new Error("taskkill unavailable");
      return killer;
    });
    let result;
    child.stdin.on("data", chunk => {
      const request = JSON.parse(String(chunk));
      result = { canRewind: true, historyRewound: true, filesChanged: ["src/a.ts"] };
      child.stdout.write(JSON.stringify({ type: "control_response", response: {
        subtype: "success", request_id: request.request_id, response: result
      } }) + "\n");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = runRewindControl({ sessionId, messageId, scope: "Code", cwd: "C:\\work",
        env: {}, spawnProcess: () => child, spawnKiller, platform: "win32" });
      let resolved = false;
      pending.then(() => { resolved = true; });
      expect(spawnKiller).toHaveBeenCalledWith("taskkill.exe", ["/pid", "12345", "/t", "/f"],
        { windowsHide: true, stdio: "ignore" });
      if (outcome === "spawn error") killer.emit("error", new Error("taskkill unavailable"));
      if (outcome === "success" || outcome === "nonzero exit") killer.emit("exit", outcome === "success" ? 0 : 1);
      expect(child.kill).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
      await Promise.resolve();
      expect(resolved).toBe(false);
      child.exitCode = 0;
      child.emit("exit", 0);
      await expect(pending).resolves.toEqual(result);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects invalid identifiers before starting a process", async () => {
    const spawnProcess = vi.fn();
    await expect(runRewindControl({ sessionId, messageId: "invalid", scope: "Code", cwd: "C:\\work",
      env: {}, spawnProcess })).rejects.toThrow("无效");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
