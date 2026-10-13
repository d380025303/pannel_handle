import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { parse } = require("smol-toml");
const { createCodexWorkspaceTrustService, setProjectTrust } = require("./codex-workspace-trust-service.cjs");
const originalHome = process.env.CODEX_HOME;
const roots = [];
const hostKey = "a".repeat(64);
const hash = `sha256:${"b".repeat(64)}`;
const digest = text => createHash("sha256").update(text).digest("hex");
const keyFor = workspace => `${path.win32.join(workspace, ".codex", "hooks.json")}:stop:0:0`;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function harness({ reviewed = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pannel-host-trust-"));
  roots.push(root);
  process.env.CODEX_HOME = path.join(root, "codex-home");
  await fs.mkdir(process.env.CODEX_HOME);
  const configFile = path.join(process.env.CODEX_HOME, "config.toml");
  await fs.writeFile(configFile, '# preserve unrelated config\nmodel = "test"\n');
  const workspacesRoot = path.join(root, "workspaces");
  async function workspace(name) {
    const cwd = path.join(workspacesRoot, name);
    await fs.mkdir(path.join(cwd, ".codex"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".codex", "hooks.json"), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/pannel-handle-hook.ps1"}]}]}}');
    await fs.writeFile(path.join(cwd, ".codex", "pannel-handle-hook.ps1"), "Write-Output ready");
    return cwd;
  }
  const source = await workspace("project-one/slot-1");
  async function nativeReview(cwd) {
    await setProjectTrust(cwd);
    await fs.appendFile(configFile, `\n[hooks.state.${JSON.stringify(keyFor(cwd))}]\ntrusted_hash = ${JSON.stringify(hash)}\n`);
  }
  if (reviewed) {
    await nativeReview(source);
    // Represents a previously completed directory-scoped review.
    await fs.writeFile(path.join(source, ".codex", "pannel-handle-trust.json"), JSON.stringify({ scriptHash: digest("Write-Output ready") }));
  }
  const listHooks = vi.fn(async cwd => {
    const config = parse(await fs.readFile(configFile, "utf8"));
    return [{ source: "project", sourcePath: path.win32.join(cwd, ".codex", "hooks.json"), key: keyFor(cwd),
      currentHash: hash, enabled: true, handlerType: "command",
      command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/pannel-handle-hook.ps1",
      trustStatus: config.hooks?.state?.[keyFor(cwd)]?.trusted_hash === hash ? "trusted" : "untrusted" }];
  });
  const broadcast = vi.fn();
  const options = { broadcast, listHooks, hostTrustRoot: path.join(root, "host-trust"), workspacesRoot };
  const service = createCodexWorkspaceTrustService(options);
  const request = (cwd, sessionId, key = hostKey, targetService = service) => targetService.request({ workspacePath: cwd,
    sessionId, persistent: true, hostTrustKey: key, hostTrustLabel: "deploy@example.com:22" });
  if (reviewed) await request(source, "legacy");
  return { root, source, workspace, configFile, options, service, request, nativeReview, listHooks, broadcast };
}

async function cancelReview(h, waiting, sessionId) {
  const rejection = expect(waiting).rejects.toThrow("已取消");
  await vi.waitFor(() => expect(h.service.listPending().find(entry => entry.sessionId === sessionId)?.ready).toBe(true));
  h.service.cancel(h.service.listPending().find(entry => entry.sessionId === sessionId).id);
  await rejection;
  await h.service.release(sessionId);
}

describe("SSH host-scoped Codex bridge trust", () => {
  it("upgrades a verified legacy review and reuses native trust across concurrent slots and projects after restart", async () => {
    const h = await harness();
    const slots = await Promise.all([h.workspace("project-one/slot-2"), h.workspace("project-two/slot-1")]);
    const next = createCodexWorkspaceTrustService(h.options);
    h.broadcast.mockClear();
    await Promise.all(slots.map((cwd, index) => h.request(cwd, `next-${index}`, hostKey, next)));
    expect(next.listPending()).toEqual([]);
    expect(h.broadcast).not.toHaveBeenCalledWith("codex-workspace-trust:changed", expect.anything());
    const config = parse(await fs.readFile(h.configFile, "utf8"));
    for (const cwd of slots) {
      expect(config.projects[path.win32.resolve(cwd).toLowerCase()].trust_level).toBe("trusted");
      expect(config.hooks.state[keyFor(cwd)].trusted_hash).toBe(hash);
      expect(await fs.readFile(path.join(cwd, ".codex", "pannel-handle-trust.json"), "utf8")).toContain("configHash");
    }
    expect(await fs.readFile(h.configFile, "utf8")).toContain('# preserve unrelated config\nmodel = "test"');
    await Promise.all(slots.map((_, index) => next.release(`next-${index}`)));
    expect(parse(await fs.readFile(h.configFile, "utf8")).hooks.state[keyFor(slots[0])].trusted_hash).toBe(hash);
  });

  it.each([undefined, "c".repeat(64)])("does not adopt authorization without a matching host identity (%s)", async key => {
    const h = await harness();
    const cwd = await h.workspace("other/slot-1");
    const waiting = h.service.request({ workspacePath: cwd, sessionId: "other", persistent: true, hostTrustKey: key });
    await cancelReview(h, waiting, "other");
    expect(parse(await fs.readFile(h.configFile, "utf8")).hooks.state[keyFor(cwd)]).toBeUndefined();
  });

  it.each(["script", "config", "source-script", "source-revoked", "target-project-revoked", "target-hook-revoked", "target-hook-disabled"])("requires review for %s", async reason => {
    const h = await harness();
    const cwd = await h.workspace("other/slot-1");
    if (reason === "script") await fs.appendFile(path.join(cwd, ".codex", "pannel-handle-hook.ps1"), " changed");
    if (reason === "config") await fs.appendFile(path.join(cwd, ".codex", "hooks.json"), "\n");
    if (reason === "source-script") await fs.appendFile(path.join(h.source, ".codex", "pannel-handle-hook.ps1"), " changed");
    if (reason === "source-revoked") {
      const text = await fs.readFile(h.configFile, "utf8");
      await fs.writeFile(h.configFile, text.replace(hash, `sha256:${"c".repeat(64)}`));
    }
    if (reason === "target-project-revoked") await fs.appendFile(h.configFile, `\n[projects.${JSON.stringify(path.win32.resolve(cwd).toLowerCase())}]\ntrust_level = "untrusted"\n`);
    if (reason === "target-hook-revoked") await fs.appendFile(h.configFile, `\n[hooks.state.${JSON.stringify(keyFor(cwd))}]\nenabled = true\n`);
    if (reason === "target-hook-disabled") await fs.appendFile(h.configFile, `\n[hooks.state.${JSON.stringify(keyFor(cwd))}]\ntrusted_hash = ${JSON.stringify(hash)}\nenabled = false\n`);
    const original = await fs.readFile(h.configFile, "utf8");
    await cancelReview(h, h.request(cwd, "changed"), "changed");
    expect((await fs.readFile(h.configFile, "utf8")).trimEnd()).toBe(original.trimEnd());
  });

  it("rolls back automatic native grants when the target probe fails", async () => {
    const h = await harness();
    const cwd = await h.workspace("other/slot-1");
    const original = await fs.readFile(h.configFile, "utf8");
    const query = h.listHooks.getMockImplementation();
    h.listHooks.mockImplementation(async target => {
      if (target === cwd) throw new Error("target probe failed");
      return query(target);
    });
    const waiting = h.request(cwd, "failed");
    const rejection = expect(waiting).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(h.service.listPending()[0]?.error).toBe("target probe failed"));
    h.service.cancel(h.service.listPending()[0].id);
    await rejection;
    expect((await fs.readFile(h.configFile, "utf8")).trimEnd()).toBe(original.trimEnd());
  });

  it("preserves a completed slot's native revocation even when its trust state was deleted", async () => {
    const h = await harness();
    const cwd = await h.workspace("other/slot-1");
    await h.request(cwd, "trusted");
    const { removeCopiedHookTrust, withTrustLock } = require("./codex-bridge-trust.cjs");
    await withTrustLock(() => removeCopiedHookTrust({ configFile: h.configFile, added: [{ key: keyFor(cwd), hash }] }));
    const original = await fs.readFile(h.configFile, "utf8");
    await cancelReview(h, h.request(cwd, "revoked"), "revoked");
    expect(await fs.readFile(h.configFile, "utf8")).toBe(original);
  });

  it("also rechecks configuration changes in an upgraded legacy workspace", async () => {
    const h = await harness();
    await fs.appendFile(path.join(h.source, ".codex", "hooks.json"), "\n");
    await cancelReview(h, h.request(h.source, "legacy-changed"), "legacy-changed");
  });

  it("resolves matching waiting dialogs when the first manual review completes", async () => {
    const h = await harness({ reviewed: false });
    const cwd = await h.workspace("other/slot-1");
    const first = h.request(h.source, "first");
    const second = h.request(cwd, "second");
    await vi.waitFor(() => expect(h.service.listPending()).toHaveLength(2));
    const id = h.service.listPending().find(entry => entry.sessionId === "first").id;
    await h.service.approveProject(id);
    await fs.appendFile(h.configFile, `\n[hooks.state.${JSON.stringify(keyFor(h.source))}]\ntrusted_hash = ${JSON.stringify(hash)}\n`);
    expect(await h.service.finishHooks(id)).toBe(true);
    await Promise.all([first, second]);
    expect(h.service.listPending()).toEqual([]);
    expect(parse(await fs.readFile(h.configFile, "utf8")).hooks.state[keyFor(cwd)].trusted_hash).toBe(hash);
  });

  it("ignores a canceled request while the source probe is still running", async () => {
    const h = await harness();
    const cwd = await h.workspace("other/slot-1");
    const original = await fs.readFile(h.configFile, "utf8");
    let finish;
    const query = h.listHooks.getMockImplementation();
    h.listHooks.mockImplementation(target => new Promise(resolve => { finish = async () => resolve(await query(target)); }));
    const waiting = h.request(cwd, "cancel");
    const rejected = expect(waiting).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await h.service.release("cancel");
    await rejected;
    await finish();
    // Flush the automatic operation's queue before inspecting its writes.
    const { withTrustLock } = require("./codex-bridge-trust.cjs");
    await withTrustLock(() => {});
    expect(await fs.readFile(h.configFile, "utf8")).toBe(original);
    expect(h.service.listPending()).toEqual([]);
  });
});
