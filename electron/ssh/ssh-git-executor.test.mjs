import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSshGitExecutor } = require("./ssh-git-executor.cjs");

function streamingExecutor(emit) {
  return createSshGitExecutor({ sshSessionRuntime: {
    async execStreaming(_sessionId, _command, callbacks) {
      emit(callbacks);
      return { promise: Promise.resolve({ exitCode: 0 }), cancel() {} };
    }
  } });
}

describe("ssh-git-executor", () => {
  it.each([
    [["中文", "好"], 9, "中文好", false],
    [["中文", "好"], 6, "中文", true],
    [["中", "文"], 4, "中�", true],
    [[Buffer.from("abc"), "de"], 4, "abcd", true],
    [["abcd"], 4, "abcd", false]
  ])("preserves output limits for %j at %i bytes", async (chunks, limit, stdout, truncated) => {
    const executor = streamingExecutor(({ onStdout }) => chunks.forEach(onStdout));
    await expect(executor.runGit("ssh-1", "/repo", ["status"], { maxOutputBytes: limit }))
      .resolves.toEqual({ stdout, stderr: "", truncated });
  });

  it("keeps independent stream limits and decodes UTF-8 split across transport chunks", async () => {
    const executor = streamingExecutor(({ onStdout, onStderr }) => {
      const decoder = new StringDecoder("utf8");
      for (const byte of Buffer.from("中文")) onStdout(decoder.write(Buffer.from([byte])));
      onStdout(decoder.end());
      onStderr("错误");
      onStderr("更多");
      onStdout("更多");
    });
    await expect(executor.runGit("ssh-1", "/repo", ["status"], { maxOutputBytes: 6 }))
      .resolves.toEqual({ stdout: "中文", stderr: "错误", truncated: true });
  });

  it("counts only incoming bytes and skips chunks after each stream reaches its limit", async () => {
    const chunk = "x".repeat(1024);
    const limit = 4 * 1024 * 1024;
    const byteLength = Buffer.byteLength;
    let scannedBytes = 0;
    const spy = vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
      const bytes = byteLength(value, encoding);
      scannedBytes += bytes;
      return bytes;
    });
    try {
      const executor = streamingExecutor(({ onStdout, onStderr }) => {
        for (let i = 0; i < 4096; i++) onStdout(chunk);
        for (let i = 0; i < 4096; i++) onStderr(chunk);
        for (let i = 0; i < 4096; i++) { onStdout(chunk); onStderr(chunk); }
      });
      const result = await executor.runGit("ssh-1", "/repo", ["status"]);
      expect(scannedBytes).toBe(2 * limit);
      expect(result.stdout).toHaveLength(limit);
      expect(result.stderr).toHaveLength(limit);
      expect(result.truncated).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("quotes remote directories and Git arguments through the SSH runtime", async () => {
    const runtime = { exec: vi.fn(async () => "status") };
    const executor = createSshGitExecutor({ sshSessionRuntime: runtime });

    await expect(executor.runGit("ssh-1", "/srv/app's repo", ["status", "--short"]))
      .resolves.toEqual({ stdout: "status", stderr: "", truncated: false });
    expect(runtime.exec).toHaveBeenCalledWith(
      "ssh-1",
      "cd '/srv/app'\\''s repo' && GIT_TERMINAL_PROMPT=0 git 'status' '--short'",
      expect.objectContaining({ allowExitCodes: undefined })
    );
  });
});
