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
    await service.approveProject("run-7");
    expect(await service.finishHooks("run-7")).toBe(false);
    expect(service.listPending()[0].error).toContain("尚未全部受信任");
    trusted = true;
    expect(await service.finishHooks("run-7")).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
    expect(service.listPending()).toEqual([]);

    const canceled = service.request({ sessionId: "run-8", title: "SSH Codex", workspacePath });
    await vi.waitFor(() => expect(service.listPending()).toHaveLength(1));
    service.cancel("run-8");
    await expect(canceled).rejects.toThrow("已取消");
    expect(trustProject).toHaveBeenCalledTimes(1);
  });
});
