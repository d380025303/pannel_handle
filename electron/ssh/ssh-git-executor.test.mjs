import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSshGitExecutor } = require("./ssh-git-executor.cjs");

describe("ssh-git-executor", () => {
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
