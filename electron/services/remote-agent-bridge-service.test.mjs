import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createRemoteAgentBridgeService,
  createRuntimeInstructions,
  normalizeToolPath
} = require("./remote-agent-bridge-service.cjs");

const tempDirs = [];

function createHarness() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "pannel-handle-remote-agent-"));
  tempDirs.push(tempDir);
  const session = {
    id: "run-1",
    type: "ssh",
    cwd: "/srv/app",
    sshConfig: { host: "example.com", username: "deploy" }
  };
  const sftp = {
    realPath: vi.fn(async (value) => value),
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
    broadcast
  });
  return { service, sshSessionRuntime, remoteFileService, dialog, broadcast, tempDir };
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
  it("keeps tool paths inside the configured workspace", () => {
    expect(normalizeToolPath("/srv/app", "src/main.ts")).toBe("/srv/app/src/main.ts");
    expect(() => normalizeToolPath("/srv/app", "../secret")).toThrow("工作目录内");
    expect(() => normalizeToolPath("/srv/app", "/etc/passwd")).toThrow("工作目录内");
  });

  it("writes focused runtime instructions for the remote source of truth", () => {
    const content = createRuntimeInstructions({ remoteRoot: "/srv/app", hostLabel: "deploy@example.com" });
    expect(content).toContain("The source of truth is the SSH workspace `/srv/app`");
    expect(content).toContain("remote_apply_patch");
    expect(content).toContain("Finish only after the relevant remote checks pass");
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
      const response = await post(binding, {
        id,
        method: "tools/call",
        params: {
          name: "remote_apply_patch",
          arguments: { changes: [{ path: "src/a.ts", expectedVersion: "v1", content: "new" }] }
        }
      });
      const payload = await response.json();
      expect(payload.result.isError).not.toBe(true);
    }

    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1);
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
});
