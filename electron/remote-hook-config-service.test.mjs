import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  buildRemoteHookCommand,
  createRemoteHookConfigService,
  normalizeRemotePath
} = require("./remote-hook-config-service.cjs");

function createMemorySftp(files = {}) {
  const store = new Map(Object.entries(files));
  const failingWrites = new Set();
  const sftp = {
    connect: vi.fn(),
    end: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(async (remotePath) => {
      if (remotePath === "/srv/app") return { isDirectory: true };
      if (!store.has(remotePath)) {
        const err = new Error("No such file");
        err.code = 2;
        throw err;
      }
      return { isDirectory: false };
    }),
    get: vi.fn(async (remotePath) => {
      if (!store.has(remotePath)) {
        const err = new Error("No such file");
        err.code = 2;
        throw err;
      }
      return Buffer.from(store.get(remotePath), "utf-8");
    }),
    put: vi.fn(async (content, remotePath) => {
      if (failingWrites.has(remotePath)) {
        throw new Error("remote disk full");
      }
      store.set(remotePath, Buffer.isBuffer(content) ? content.toString("utf-8") : String(content));
    }),
    rename: vi.fn(async (from, to) => {
      store.set(to, store.get(from));
      store.delete(from);
    }),
    posixRename: vi.fn(async (from, to) => {
      store.set(to, store.get(from));
      store.delete(from);
    }),
    delete: vi.fn(async (remotePath) => {
      store.delete(remotePath);
    }),
    read(remotePath) {
      return store.get(remotePath);
    },
    failWrite(remotePath) {
      failingWrites.add(remotePath);
    }
  };
  return sftp;
}

function createService(sftp, tunnel = { hookUrl: "http://127.0.0.1:31847/claude-hook" }) {
  return createRemoteHookConfigService({
    terminalManager: {
      getSession: () => ({
        id: "run-1",
        type: "ssh",
        sshConfig: {
          host: "example.com",
          username: "deploy",
          encryptedSecret: "ciphertext"
        }
      })
    },
    sessionStore: {
      decryptSecret: vi.fn(() => "plain-secret")
    },
    sshHookTunnelService: {
      ensureTunnel: vi.fn(async () => tunnel)
    },
    sftpFactory: () => sftp
  });
}

describe("remote-hook-config-service", () => {
  it("normalizes absolute Linux paths and rejects relative paths", () => {
    expect(normalizeRemotePath("/srv/app/")).toBe("/srv/app");
    expect(() => normalizeRemotePath("srv/app")).toThrow("absolute Linux path");
  });

  it("builds SSH hook commands with inline tunnel environment", () => {
    expect(buildRemoteHookCommand("claude", "http://127.0.0.1:31847/claude-hook", "run-1")).toBe(
      "PANNEL_HANDLE_HOOK_URL='http://127.0.0.1:31847/claude-hook' PANNEL_HANDLE_SESSION_ID='run-1' bash .claude/pannel-handle-hook.sh"
    );
  });

  it("installs Claude and Codex hooks into a remote Linux project", async () => {
    const sftp = createMemorySftp({
      "/srv/app/.claude/settings.local.json": JSON.stringify({
        permissions: { allow: ["Bash(git status)"] }
      })
    });
    const service = createService(sftp);

    const result = await service.install(
      { type: "ssh", sessionId: "run-1", path: "/srv/app" },
      ["claude", "codex"]
    );

    expect(result.ok).toBe(true);
    expect(result.providers.claude.status).toBe("installed");
    expect(result.providers.codex.status).toBe("installed");
    expect(sftp.read("/srv/app/.claude/settings.local.json.pannel-handle.bak")).toContain("permissions");
    expect(sftp.read("/srv/app/.claude/pannel-handle-hook.sh")).toContain("PANNEL_HANDLE_HOOK_INPUT");
    expect(sftp.read("/srv/app/.codex/pannel-handle-hook.sh")).toContain("codex_hook_url");
    expect(sftp.posixRename).toHaveBeenCalled();

    const claudeConfig = JSON.parse(sftp.read("/srv/app/.claude/settings.local.json"));
    expect(claudeConfig.permissions.allow).toEqual(["Bash(git status)"]);
    expect(claudeConfig.hooks.Stop[0].hooks[0].command).toContain("PANNEL_HANDLE_SESSION_ID='run-1'");
    expect(claudeConfig.hooks.Stop[0].hooks[0].command).toContain("127.0.0.1:31847");

    const codexConfig = JSON.parse(sftp.read("/srv/app/.codex/hooks.json"));
    expect(codexConfig.hooks.SessionStart[0].hooks[0].command).toContain(".codex/pannel-handle-hook.sh");
  });

  it("rolls back earlier remote writes when a later write fails", async () => {
    const sftp = createMemorySftp({
      "/srv/app/.claude/settings.local.json": "{}"
    });
    sftp.failWrite("/srv/app/.claude/pannel-handle-hook.sh.pannel-handle.tmp");
    const service = createService(sftp);

    const result = await service.install(
      { type: "ssh", sessionId: "run-1", path: "/srv/app" },
      ["claude"]
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("remote disk full");
    expect(sftp.read("/srv/app/.claude/settings.local.json")).toBe("{}");
  });
});
