import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  buildRemoteCommand,
  createRemoteAgentBridgeService,
  createRuntimeInstructions,
  normalizeRoot,
  normalizeToolPath
} = require("./remote-agent-bridge-service.cjs");

const tempDirs = [];

function createHarness(sessionOverrides = {}, serviceOverrides = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "pannel-handle-remote-agent-"));
  tempDirs.push(tempDir);
  const session = {
    id: "run-1",
    type: "ssh",
    cwd: "/srv/app",
    sshConfig: { host: "example.com", username: "deploy" },
    ...sessionOverrides
  };
  const sftp = {
    realPath: vi.fn(async (value) => value),
    exists: vi.fn(async () => "-"),
    stat: vi.fn(async () => ({ isDirectory: true })),
    end: vi.fn(async () => {})
  };
  const sshSessionRuntime = {
    getSecret: vi.fn(() => "ssh-secret"),
    createSftpClient: vi.fn(async () => sftp),
    exec: vi.fn(async () => ""),
    execStreaming: vi.fn(async (_sessionId, _command, options) => {
      options.onStdout?.("ssh-secret\n");
      return { promise: Promise.resolve({ exitCode: 0 }), cancel: vi.fn() };
    })
  };
  const remoteFileService = {
    list: vi.fn(async () => [{ name: "src", path: "/srv/app/src", type: "directory" }]),
    readText: vi.fn(async () => ({ kind: "text", content: "old", version: "v1", bom: false, eol: "lf", size: 3 })),
    writeText: vi.fn(async () => ({ status: "saved", version: "v2", size: 3 })),
    deleteEntry: vi.fn(async () => ({ mode: "permanent" }))
  };
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) };
  const broadcast = vi.fn();
  const service = createRemoteAgentBridgeService({
    terminalManager: { getSession: vi.fn(() => session) },
    sshSessionRuntime,
    remoteFileService,
    dialog,
    windowManager: { focusWindow: vi.fn(() => undefined) },
    workspacesRoot: path.join(tempDir, "workspaces"),
    broadcast,
    ...serviceOverrides
  });
  return { session, service, sshSessionRuntime, remoteFileService, sftp, dialog, broadcast, tempDir };
}

async function post(binding, message, token = binding.token) {
  return fetch(binding.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message })
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("remote-agent-bridge-service", () => {
  it("accumulates 4096 streaming chunks without scanning historical output", async () => {
    const harness = createHarness({}, { broadcast: () => {} });
    await harness.service.createBinding("run-1");
    const chunk = "x".repeat(1024);
    let scannedCharacters = 0;
    harness.sshSessionRuntime.execStreaming.mockImplementation(async (_sessionId, _command, options) => {
      const byteLength = Buffer.byteLength;
      const spy = vi.spyOn(Buffer, "byteLength").mockImplementation((value, ...args) => {
        if (typeof value === "string") scannedCharacters += value.length;
        return byteLength(value, ...args);
      });
      try {
        for (let index = 0; index < 4096; index += 1) options.onStdout(chunk);
      } finally {
        spy.mockRestore();
      }
      return { promise: Promise.resolve({ exitCode: 0 }), cancel: vi.fn() };
    });
    try {
      const result = await harness.service.runConfiguredCommand("run-1", "build");
      expect(result.stdout).toBe(chunk.repeat(4096));
      expect(result.stderr).toBe("");
      expect(result.truncated).toBe(false);
      expect(scannedCharacters).toBeLessThanOrEqual(4 * 1024 * 1024);
    } finally {
      await harness.service.shutdown();
    }
  });

  it("shares the byte limit across streams and ignores chunks after truncation", async () => {
    const harness = createHarness({}, { broadcast: () => {} });
    await harness.service.createBinding("run-1");
    const prefix = "x".repeat(4 * 1024 * 1024 - 4);
    const ignored = { toString: vi.fn(() => "ignored") };
    harness.sshSessionRuntime.execStreaming.mockImplementation(async (_sessionId, _command, options) => {
      options.onStdout(prefix);
      options.onStderr("中ab");
      for (let index = 0; index < 4096; index += 1) options.onStdout(ignored);
      return { promise: Promise.resolve({ exitCode: 0 }), cancel: vi.fn() };
    });
    try {
      const result = await harness.service.runConfiguredCommand("run-1", "build");
      expect(result.stdout).toBe(prefix);
      expect(result.stderr).toBe("中a");
      expect(result.truncated).toBe(true);
      expect(ignored.toString).not.toHaveBeenCalled();
    } finally {
      await harness.service.shutdown();
    }
  });

  it("reuses persistent Codex slots while isolating concurrent sessions and projects", async () => {
    const harness = createHarness({ agentProvider: "codex" });
    const first = await harness.service.createBinding("run-1");
    expect(first.persistentWorkspace).toBe(true);
    expect(first.hostTrustKey).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hostTrustLabel).toBe("deploy@example.com:22");
    harness.session.id = "run-2";
    const second = await harness.service.createBinding("run-2");
    expect(second.workspacePath).not.toBe(first.workspacePath);
    expect(second.hostTrustKey).toBe(first.hostTrustKey);
    await harness.service.closeBinding("run-1");
    expect(existsSync(first.workspacePath)).toBe(true);
    harness.session.id = "run-3";
    const reused = await harness.service.createBinding("run-3");
    expect(reused.workspacePath).toBe(first.workspacePath);
    expect(reused.token).not.toBe(first.token);
    expect((await post(first, { id: 1, method: "tools/list" })).status).toBe(401);
    harness.session.cwd = "/srv/other";
    const other = await harness.service.createBinding("run-4");
    expect(other.workspacePath).not.toBe(first.workspacePath);
    expect(other.hostTrustKey).toBe(first.hostTrustKey);
    harness.session.sshConfig.host = "EXAMPLE.COM";
    expect((await harness.service.createBinding("same-host")).hostTrustKey).toBe(first.hostTrustKey);
    harness.session.sshConfig.port = 2222;
    expect((await harness.service.createBinding("other-port")).hostTrustKey).not.toBe(first.hostTrustKey);
    harness.session.sshConfig.port = 22;
    harness.session.sshConfig.username = "other-user";
    expect((await harness.service.createBinding("other-user")).hostTrustKey).not.toBe(first.hostTrustKey);
    harness.session.sshConfig.username = "deploy";
    harness.session.sshConfig.host = "other.example.com";
    expect((await harness.service.createBinding("other-host")).hostTrustKey).not.toBe(first.hostTrustKey);
    await harness.service.shutdown();
    const fresh = createHarness({ agentProvider: "codex" }, { workspacesRoot: path.join(harness.tempDir, "workspaces") });
    const restarted = await fresh.service.createBinding("run-5");
    expect(restarted.workspacePath).toBe(first.workspacePath);
    await fresh.service.shutdown();
  });

  it("keeps tool paths inside the configured workspace", () => {
    expect(normalizeToolPath("/srv/app", "src/main.ts")).toBe("/srv/app/src/main.ts");
    expect(() => normalizeToolPath("/srv/app", "../secret")).toThrow("工作目录内");
    expect(() => normalizeToolPath("/srv/app", "/etc/passwd")).toThrow("工作目录内");
  });

  it("normalizes Windows drive paths and enforces a case-insensitive workspace boundary", () => {
    expect(normalizeRoot("c:\\Work Space\\repo\\", "windows")).toBe("c:/Work Space/repo");
    expect(normalizeToolPath("C:/Work Space/repo", "src\\main.ts", "windows")).toBe("C:/Work Space/repo/src/main.ts");
    expect(normalizeToolPath("C:/Work Space/repo", "c:/work space/REPO/docs/readme.md", "windows")).toBe("c:/work space/REPO/docs/readme.md");
    expect(() => normalizeToolPath("C:/Work Space/repo", "..\\secret.txt", "windows")).toThrow("工作目录内");
    expect(() => normalizeToolPath("C:/Work Space/repo", "D:\\other", "windows")).toThrow("工作目录内");
    expect(() => normalizeRoot("\\\\server\\share", "windows")).toThrow("盘符绝对路径");
  });

  it("wraps Windows commands in explicit encoded PowerShell with the requested working directory", () => {
    const command = buildRemoteCommand("windows", "C:/Work Space/O'Brien", "git status --short");
    expect(command).toMatch(/^powershell\.exe .* -EncodedCommand /);
    const encoded = command.split(" ").at(-1);
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\Work Space\\O''Brien'");
    expect(script).toContain("git status --short");
    expect(script).toContain("exit $pannelHandleExitCode");
  });

  it("writes focused runtime instructions for the remote source of truth", () => {
    const content = createRuntimeInstructions({ remoteRoot: "/srv/app", hostLabel: "deploy@example.com" });
    expect(content).toContain("The source of truth is the SSH workspace `/srv/app`");
    expect(content).toContain("remote_apply_patch");
    expect(content).toContain("Finish only after the relevant remote checks pass");
  });

  it("binds a local Codex session to a Windows SSH workspace", async () => {
    const harness = createHarness({
      cwd: "C:\\Work Space\\repo",
      sshConfig: { host: "windows.example.com", username: "builder", remotePlatform: "auto" }
    });

    const binding = await harness.service.createBinding("run-1");

    expect(binding.developerInstructions || readFileSync(path.join(binding.workspacePath, "AGENTS.md"), "utf-8")).toContain("remote platform is windows");

    const context = await post(binding, { id: 1, method: "tools/call", params: { name: "remote_context", arguments: {} } });
    expect((await context.json()).result.content[0].text).toContain('"platform": "windows"');

    const search = await post(binding, {
      id: 2,
      method: "tools/call",
      params: { name: "remote_search", arguments: { query: "needle", path: "src", mode: "text" } }
    });
    expect((await search.json()).result.isError).not.toBe(true);
    const remoteCommand = harness.sshSessionRuntime.exec.mock.calls.at(-1)[1];
    const script = Buffer.from(remoteCommand.split(" ").at(-1), "base64").toString("utf16le");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\Work Space\\repo\\src'");
    expect(script).toContain("Select-String -SimpleMatch");
    expect(harness.sshSessionRuntime.exec).toHaveBeenCalledTimes(1);

    await harness.service.shutdown();
  });

  it("uses a selected local Agent directory without writing or deleting bridge files there", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pannel-handle-local-agent-"));
    tempDirs.push(base);
    const localAgentCwd = path.join(base, "local workspace");
    mkdirSync(localAgentCwd);
    const sentinel = path.join(localAgentCwd, "keep.txt");
    writeFileSync(sentinel, "keep", "utf-8");
    const harness = createHarness({ localAgentCwd });

    const binding = await harness.service.createBinding("run-1");

    expect(binding.workspacePath).toBe(localAgentCwd);
    expect(binding.developerInstructions).toContain("SSH workspace `/srv/app`");
    expect(binding.runtimeInstructions).toBe(binding.developerInstructions);
    expect(existsSync(path.join(localAgentCwd, "AGENTS.md"))).toBe(false);

    await harness.service.closeBinding("run-1");
    expect(readFileSync(sentinel, "utf-8")).toBe("keep");
    await harness.service.shutdown();
  });

  it("rejects an invalid selected local Agent directory instead of falling back", async () => {
    const harness = createHarness({ localAgentCwd: "relative\\workspace" });

    await expect(harness.service.createBinding("run-1")).rejects.toThrow("Windows 绝对路径");
    await harness.service.shutdown();
  });

  it.each([
    { platform: "linux", root: "/srv/app", file: "/srv/app/AGENTS.md" },
    { platform: "windows", root: "C:/Work Space/repo", file: "C:/Work Space/repo/AGENTS.md" }
  ])("creates a missing text file through the $platform bridge", async ({ platform, root, file }) => {
    const harness = createHarness({ cwd: root, sshConfig: { host: "example.com", remotePlatform: platform } });
    const existingPaths = new Set([root]);
    harness.sftp.exists.mockImplementation(async (value) => existingPaths.has(value) ? "-" : false);
    harness.sftp.realPath.mockImplementation(async (value) => platform === "windows" || existingPaths.has(value) ? value : "");
    const binding = await harness.service.createBinding("run-1");
    const create = () => post(binding, {
      id: 1,
      method: "tools/call",
      params: { name: "remote_apply_patch", arguments: { changes: [{ path: "./AGENTS.md", content: "# Repository Guidelines\n" }] } }
    });

    const responsePromise = create();
    await vi.waitFor(() => expect(harness.service.listPendingApprovals()).toHaveLength(1));
    expect(harness.service.resolveApproval(harness.service.listPendingApprovals()[0].id, "session")).toBe(true);
    const payload = await (await responsePromise).json();
    expect(payload.result.isError).not.toBe(true);
    expect(harness.sftp.realPath).not.toHaveBeenCalledWith(file);
    expect(harness.remoteFileService.writeText).toHaveBeenCalledWith(
      "run-1", file, "# Repository Guidelines\n", "",
      { force: true, format: { bom: false, eol: "lf" } }
    );

    existingPaths.add(file);
    const collision = await (await create()).json();
    expect(collision.result.isError).toBe(true);
    expect(collision.result.content[0].text).toContain("新建文件已经存在");
    expect(harness.remoteFileService.writeText).toHaveBeenCalledTimes(1);
    await harness.service.shutdown();
  });

  it("rejects creation when its parent is missing or resolves outside the workspace", async () => {
    const harness = createHarness();
    const binding = await harness.service.createBinding("run-1");
    const create = () => post(binding, {
      id: 1,
      method: "tools/call",
      params: { name: "remote_apply_patch", arguments: { changes: [{ path: "docs/AGENTS.md", content: "guide" }] } }
    });
    harness.sftp.exists.mockImplementation(async (value) => value === "/srv/app" ? "d" : false);
    const responsePromise = create();
    await vi.waitFor(() => expect(harness.service.listPendingApprovals()).toHaveLength(1));
    expect(harness.service.resolveApproval(harness.service.listPendingApprovals()[0].id, "session")).toBe(true);

    const missingParent = await (await responsePromise).json();
    expect(missingParent.result.isError).toBe(true);
    expect(missingParent.result.content[0].text).toContain("远程父目录不存在");

    harness.sftp.exists.mockImplementation(async (value) => value === "/srv/app/docs" ? "d" : false);
    harness.sftp.realPath.mockImplementation(async (value) => value === "/srv/app/docs" ? "/tmp/outside" : value);
    const outsideParent = await (await create()).json();
    expect(outsideParent.result.isError).toBe(true);
    expect(outsideParent.result.content[0].text).toContain("符号链接越出了工作目录");
    expect(harness.remoteFileService.writeText).not.toHaveBeenCalled();
    await harness.service.shutdown();
  });

  it("serves authenticated MCP tools and scopes a session mutation approval", async () => {
    const harness = createHarness();
    const binding = await harness.service.createBinding("run-1");

    const unauthorized = await post(binding, { id: 1, method: "tools/list" }, "wrong-token");
    expect(unauthorized.status).toBe(401);

    const initialized = await post(binding, {
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    });
    expect((await initialized.json()).result.serverInfo.name).toBe("pannel-handle-remote");

    const listed = await post(binding, { id: 3, method: "tools/list" });
    const toolNames = (await listed.json()).result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(["remote_context", "remote_read_text", "remote_apply_patch", "remote_exec"]));

    for (const id of [4, 5]) {
      const responsePromise = post(binding, {
        id,
        method: "tools/call",
        params: {
          name: "remote_apply_patch",
          arguments: { changes: [{ path: "src/a.ts", expectedVersion: "v1", content: "new" }] }
        }
      });
      if (id === 4) {
        await vi.waitFor(() => expect(harness.service.listPendingApprovals()).toHaveLength(1));
        const [approval] = harness.service.listPendingApprovals();
        expect(approval).toEqual(expect.objectContaining({ sessionId: "run-1", tool: "remote_apply_patch" }));
        expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
        expect(harness.service.resolveApproval(approval.id, "session")).toBe(true);
      }
      const response = await responsePromise;
      const payload = await response.json();
      expect(payload.result.isError).not.toBe(true);
    }

    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.remoteFileService.writeText).toHaveBeenCalledTimes(2);
    expect(readFileSync(path.join(binding.workspacePath, "AGENTS.md"), "utf-8")).toContain("/srv/app");
    expect(harness.broadcast).toHaveBeenCalledWith("remote-agent:audit", expect.objectContaining({ sessionId: "run-1" }));

    const collision = await post(binding, {
      id: 6,
      method: "tools/call",
      params: {
        name: "remote_apply_patch",
        arguments: { changes: [{ path: "src/a.ts", content: "overwrite" }] }
      }
    });
    expect((await collision.json()).result.isError).toBe(true);
    expect(harness.remoteFileService.writeText).toHaveBeenCalledTimes(2);

    await harness.service.runConfiguredCommand("run-1", "printf ssh-secret");
    const serializedAudit = JSON.stringify(harness.broadcast.mock.calls.map((call) => call[1]));
    expect(serializedAudit).not.toContain("ssh-secret");
    expect(serializedAudit).toContain("[REDACTED]");

    await harness.service.shutdown();
  });

  it("queues one-time approvals and denies only the selected request", async () => {
    const harness = createHarness();
    const binding = await harness.service.createBinding("run-1");
    const call = (id, command) => post(binding, {
      id,
      method: "tools/call",
      params: { name: "remote_exec", arguments: { command } }
    });

    const firstResponse = call(1, "git status --short");
    const secondResponse = call(2, "git diff --stat");
    await vi.waitFor(() => expect(harness.service.listPendingApprovals()).toHaveLength(1));
    const [firstApproval] = harness.service.listPendingApprovals();
    expect(harness.service.resolveApproval(firstApproval.id, "once")).toBe(true);
    expect((await (await firstResponse).json()).result.isError).not.toBe(true);

    await vi.waitFor(() => expect(harness.service.listPendingApprovals()).toHaveLength(1));
    const [secondApproval] = harness.service.listPendingApprovals();
    expect(secondApproval.summary).toBe("git diff --stat");
    expect(harness.service.resolveApproval(secondApproval.id, "deny")).toBe(true);
    expect(harness.service.resolveApproval(secondApproval.id, "once")).toBe(false);
    expect((await (await secondResponse).json()).result.isError).toBe(true);
    expect(harness.sshSessionRuntime.execStreaming).toHaveBeenCalledTimes(1);

    await harness.service.shutdown();
  });

  it("rejects a pending approval when its SSH binding closes", async () => {
    const harness = createHarness();
    const binding = await harness.service.createBinding("run-1");
    const responsePromise = post(binding, {
      id: 1,
      method: "tools/call",
      params: { name: "remote_exec", arguments: { command: "git status" } }
    });

    await vi.waitFor(() => expect(harness.service.listPendingApprovals()).toHaveLength(1));
    await harness.service.closeBinding("run-1");
    expect(harness.service.listPendingApprovals()).toEqual([]);
    expect((await (await responsePromise).json()).result.isError).toBe(true);
    expect(harness.sshSessionRuntime.execStreaming).not.toHaveBeenCalled();

    await harness.service.shutdown();
  });
});
