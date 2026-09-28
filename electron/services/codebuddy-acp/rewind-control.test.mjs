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

  it("rejects invalid identifiers before starting a process", async () => {
    const spawnProcess = vi.fn();
    await expect(runRewindControl({ sessionId, messageId: "invalid", scope: "Code", cwd: "C:\\work",
      env: {}, spawnProcess })).rejects.toThrow("无效");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
