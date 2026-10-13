import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createCodexWorkspaceTrustService, setProjectTrust, removeAddedTrust } = require("./codex-workspace-trust-service.cjs");
const originalCodexHome = process.env.CODEX_HOME;
const directories = [];

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pannel-codex-trust-"));
  directories.push(root);
  const workspacePath = path.join(root, "run-7");
  const codexDir = path.join(workspacePath, ".codex");
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, "hooks.json"), '{"hooks":{}}');
  await fs.writeFile(path.join(codexDir, "pannel-handle-hook.ps1"), "Write-Output ready");
  return { root, workspacePath };
}

describe("Codex graphical workspace trust", () => {
  it.each(["finish", "cancel", "release"])("isolates late terminal events after %s and reopening the same session", async action => {
    const { workspacePath } = await fixture();
    const terminals = [];
    const pty = { spawn: vi.fn(() => {
      const terminal = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
        onData: vi.fn(callback => { terminal.data = callback; return { dispose: vi.fn() }; }),
        onExit: vi.fn(callback => { terminal.exit = callback; return { dispose: vi.fn() }; }) };
      terminals.push(terminal);
      return terminal;
    }) };
    const broadcast = vi.fn();
    const service = createCodexWorkspaceTrustService({ broadcast, pty, trustProject: async () => ({ added: false }),
      listHooks: async () => [{ source: "project", sourcePath: path.win32.join(workspacePath, ".codex", "hooks.json"), trustStatus: "trusted" }] });
    const waiting = service.request({ sessionId: "same", workspacePath });
    const settled = action === "finish" ? expect(waiting).resolves.toBeUndefined() : expect(waiting).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(service.listPending()).toHaveLength(1));
    const id = service.listPending()[0].id;
    await service.approveProject(id);
    service.openHooks(id);
    expect(pty.spawn.mock.calls[0][2].useConptyDll).toBe(true);
    if (action === "finish") await service.finishHooks(id);
    else if (action === "cancel") service.cancel(id);
    else await service.release("same");
    await settled;
    await service.release("same");
    expect(terminals[0].kill).toHaveBeenCalledOnce();
    expect(terminals[0].onData.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    expect(terminals[0].onExit.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    const reopened = service.request({ sessionId: "same", workspacePath });
    const canceled = expect(reopened).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(service.listPending()).toHaveLength(1));
    const nextId = service.listPending()[0].id;
    expect(nextId).not.toBe(id);
    await service.approveProject(nextId);
    service.openHooks(nextId);
    broadcast.mockClear();
    expect(() => service.writeTerminal(id, "late")).not.toThrow();
    expect(() => service.resizeTerminal(id, 80, 24)).not.toThrow();
    terminals[0].data("late output");
    terminals[0].exit();
    expect(broadcast).not.toHaveBeenCalled();
    expect(terminals[1].write).not.toHaveBeenCalled();
    expect(terminals[1].resize).not.toHaveBeenCalled();
    expect(service.listPending()[0].terminalOpen).toBe(true);
    expect(() => service.openHooks(id)).toThrow("已失效");
    service.writeTerminal(nextId, "live");
    expect(terminals[1].write).toHaveBeenCalledWith("live");
    service.cancel(nextId);
    await canceled;
  });

  it("detaches a naturally exited terminal and permits opening a replacement", async () => {
    const { workspacePath } = await fixture();
    const terminal = { write: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(callback => { terminal.exit = callback; return { dispose: vi.fn() }; }) };
    const pty = { spawn: vi.fn(() => terminal) };
    const service = createCodexWorkspaceTrustService({ broadcast: vi.fn(), pty, trustProject: async () => ({ added: false }) });
    const waiting = service.request({ sessionId: "natural", workspacePath });
    const canceled = expect(waiting).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(service.listPending()).toHaveLength(1));
    const id = service.listPending()[0].id;
    await service.approveProject(id);
    service.openHooks(id);
    terminal.exit();
    expect(service.listPending()[0].terminalOpen).toBe(false);
    expect(terminal.onData.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    service.openHooks(id);
    expect(pty.spawn).toHaveBeenCalledTimes(2);
    service.cancel(id);
    await canceled;
    expect(terminal.kill).toHaveBeenCalledOnce();
  });

  it("does not expose a reusable workspace while its Hook probe is pending", async () => {
    const { workspacePath } = await fixture();
    const script = await fs.readFile(path.join(workspacePath, ".codex", "pannel-handle-hook.ps1"), "utf8");
    const { createHash } = await import("node:crypto");
    await fs.writeFile(path.join(workspacePath, ".codex", "pannel-handle-trust.json"),
      JSON.stringify({ scriptHash: createHash("sha256").update(script).digest("hex") }));
    let completeProbe;
    const listHooks = vi.fn(() => new Promise(resolve => { completeProbe = resolve; }));
    const broadcast = vi.fn();
    const service = createCodexWorkspaceTrustService({ broadcast, listHooks, projectTrusted: async () => true });
    const waiting = service.request({ sessionId: "reuse", workspacePath, persistent: true });
    await vi.waitFor(() => expect(listHooks).toHaveBeenCalledOnce());
    expect(service.listPending()).toEqual([]);
    completeProbe([{ source: "project", sourcePath: path.win32.join(workspacePath, ".codex", "hooks.json"), trustStatus: "trusted" }]);
    await waiting;
    expect(broadcast).not.toHaveBeenCalledWith("codex-workspace-trust:changed", expect.anything());
  });

  it("retains reviewed trust and checks real Hook status on subsequent starts", async () => {
    const { root, workspacePath } = await fixture();
    process.env.CODEX_HOME = path.join(root, "codex-home");
    let trusted = true;
    const listHooks = vi.fn(async () => [{ source: "project", sourcePath: path.win32.join(workspacePath, ".codex", "hooks.json"),
      trustStatus: trusted ? "trusted" : "untrusted" }]);
    const service = createCodexWorkspaceTrustService({ broadcast: vi.fn(), listHooks });
    const waiting = service.request({ sessionId: "one", workspacePath, persistent: true });
    await vi.waitFor(() => expect(service.listPending()[0]?.ready).toBe(true));
    await service.approveProject(service.listPending().find(entry => entry.sessionId === "one").id);
    expect(await service.finishHooks(service.listPending().find(entry => entry.sessionId === "one").id)).toBe(true);
    await waiting;
    await service.release("one");
    expect(await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8")).toContain('trust_level = "trusted"');
    const next = createCodexWorkspaceTrustService({ broadcast: vi.fn(), listHooks });
    await next.request({ sessionId: "two", workspacePath, persistent: true });
    expect(next.listPending()).toEqual([]);
    trusted = false;
    const revoked = next.request({ sessionId: "three", workspacePath, persistent: true });
    const rejected = expect(revoked).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(next.listPending()[0]?.ready).toBe(true));
    expect(next.listPending()[0].phase).toBe("hooks");
    expect(await next.finishHooks(next.listPending().find(entry => entry.sessionId === "three").id)).toBe(false);
    next.cancel(next.listPending().find(entry => entry.sessionId === "three").id);
    await rejected;
    trusted = true;
    await fs.writeFile(path.join(workspacePath, ".codex", "pannel-handle-hook.ps1"), "changed script");
    const changed = next.request({ sessionId: "four", workspacePath, persistent: true });
    const canceled = expect(changed).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(next.listPending()[0]?.ready).toBe(true));
    expect(next.listPending()[0].phase).toBe("hooks");
    next.cancel(next.listPending().find(entry => entry.sessionId === "four").id);
    await canceled;
  });

  it("blocks startup on a failed probe and allows checking again", async () => {
    const { workspacePath } = await fixture();
    const listHooks = vi.fn().mockRejectedValueOnce(new Error("probe failed")).mockResolvedValue([
      { source: "project", sourcePath: path.win32.join(workspacePath, ".codex", "hooks.json"), trustStatus: "trusted" }
    ]);
    const service = createCodexWorkspaceTrustService({ broadcast: vi.fn(), listHooks, projectTrusted: async () => true });
    const waiting = service.request({ sessionId: "retry", workspacePath, persistent: true });
    await vi.waitFor(() => expect(service.listPending()[0]?.error).toBe("probe failed"));
    expect(service.listPending()[0].phase).toBe("hooks");
    expect(await service.finishHooks(service.listPending().find(entry => entry.sessionId === "retry").id)).toBe(true);
    await waiting;
  });

  it("rolls back a new project grant when persistent review is canceled", async () => {
    const { root, workspacePath } = await fixture();
    process.env.CODEX_HOME = path.join(root, "codex-home");
    const service = createCodexWorkspaceTrustService({ broadcast: vi.fn() });
    const waiting = service.request({ sessionId: "cancel", workspacePath, persistent: true });
    const rejected = expect(waiting).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(service.listPending()[0]?.ready).toBe(true));
    await service.approveProject(service.listPending().find(entry => entry.sessionId === "cancel").id);
    service.cancel(service.listPending().find(entry => entry.sessionId === "cancel").id);
    await rejected;
    await service.release("cancel");
    expect(await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8")).not.toContain('trust_level = "trusted"');
  });

  it("adds and removes only the current project while preserving unrelated config", async () => {
    const { root, workspacePath } = await fixture();
    process.env.CODEX_HOME = path.join(root, "codex-home");
    await fs.mkdir(process.env.CODEX_HOME);
    const file = path.join(process.env.CODEX_HOME, "config.toml");
    const original = '# keep this comment\nmodel = "gpt-6-sol"\n\n[projects."c:\\\\other"]\ntrust_level = "trusted"\n';
    await fs.writeFile(file, original);
    const grant = await setProjectTrust(workspacePath);
    expect(grant.added).toBe(true);
    expect(await fs.readFile(file, "utf8")).toContain(original.trimEnd());
    expect((await fs.readFile(file, "utf8")).toLowerCase()).toContain(workspacePath.toLowerCase().replaceAll("\\", "\\\\"));
    await removeAddedTrust(grant);
    expect((await fs.readFile(file, "utf8")).trimEnd()).toBe(original.trimEnd());
  });

  it("restores an explicit untrusted choice when the session closes", async () => {
    const { root, workspacePath } = await fixture();
    process.env.CODEX_HOME = path.join(root, "codex-home");
    await fs.mkdir(process.env.CODEX_HOME);
    const file = path.join(process.env.CODEX_HOME, "config.toml");
    const key = path.win32.resolve(workspacePath).toLowerCase();
    await fs.writeFile(file, `[projects.${JSON.stringify(key)}]\ntrust_level = "untrusted"\n`);
    const grant = await setProjectTrust(workspacePath);
    expect(grant.previous).toBe("untrusted");
    expect(await fs.readFile(file, "utf8")).toContain('trust_level = "trusted"');
    await removeAddedTrust(grant);
    expect(await fs.readFile(file, "utf8")).toContain('trust_level = "untrusted"');
  });

  it("waits for real project Hook trust and cancels a pending launch", async () => {
    const { workspacePath } = await fixture();
    const broadcast = vi.fn();
    const trustProject = vi.fn(async () => ({ added: false }));
    let trusted = false;
    const listHooks = vi.fn(async () => [{ source: "project", sourcePath: path.win32.join(workspacePath, ".codex", "hooks.json"),
      trustStatus: trusted ? "trusted" : "untrusted" }]);
    const service = createCodexWorkspaceTrustService({ broadcast, trustProject, listHooks });
    const waiting = service.request({ sessionId: "run-7", title: "SSH Codex", workspacePath });
    await vi.waitFor(() => expect(service.listPending()[0]?.ready).toBe(true));
    expect(service.listPending()[0].configPreview).toContain("hooks");
    await service.approveProject(service.listPending().find(entry => entry.sessionId === "run-7").id);
    expect(await service.finishHooks(service.listPending().find(entry => entry.sessionId === "run-7").id)).toBe(false);
    expect(service.listPending()[0].error).toContain("尚未全部受信任");
    trusted = true;
    expect(await service.finishHooks(service.listPending().find(entry => entry.sessionId === "run-7").id)).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
    expect(service.listPending()).toEqual([]);

    const canceled = service.request({ sessionId: "run-8", title: "SSH Codex", workspacePath });
    await vi.waitFor(() => expect(service.listPending()[0]?.ready).toBe(true));
    service.cancel(service.listPending().find(entry => entry.sessionId === "run-8").id);
    await expect(canceled).rejects.toThrow("已取消");
    expect(trustProject).toHaveBeenCalledTimes(1);
  });
});
