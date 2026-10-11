import { createRequire } from "node:module";
import { describe, it, expect, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createProjectInspectorService } = require("./index.cjs");
const { assertStage, summarize } = require("./template-config.cjs");
const { createEnvironmentProfiler, quote } = require("./environment-profiler.cjs");
function fixture() {
  const tables = new Map();
  const store = { get: (table, id) => tables.get(table)?.get(id), list: table => [...(tables.get(table)?.values() || [])], put: (table, value) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table).set(value.id, structuredClone(value)); return value; }, transaction: fn => fn(), close() {} };
  const templates = [{ id: "one", title: "First", cwd: "C:/repo", type: "windows", agentProvider: "codex", codexModel: "model-one" }, { id: "two", title: "Other", cwd: "/repo", type: "ssh", sshConfig: { host: "host", encryptedSecret: "protected" }, agentProvider: "claude" }];
  const sessionStore = { getTemplate: id => templates.find(t => t.id === id), getLibrary: () => templates };
  const getProfiler = vi.fn(() => ({ resolveProject: async rootPath => ({ rootPath, name: "Repo", headCommit: "a".repeat(40), dirty: false }) }));
  const service = createProjectInspectorService({ store, sessionStore, getProfiler, reviewer: {} });
  return { service, store, templates, getProfiler };
}
describe("Inspector template snapshots", () => {
  it("requires templates, persists a snapshot and never exposes secrets", async () => {
    const { service, templates } = fixture();
    await expect(service.addProject({ rootPath: "C:/repo" })).rejects.toThrow("会话模板");
    const project = await service.addProject({ templateId: "two" });
    templates[1].agentProvider = "codex";
    expect(project.templateSnapshot.agentProvider).toBe("claude");
    expect(JSON.stringify(service.listProjects())).not.toContain("protected");
    expect(service.listProjects()[0].stageAgents.planning.unsupportedReason).toBeTruthy();
    await service.close();
  });
  it("retains saved stage settings after a template is changed or deleted", async () => {
    const { service, templates, store } = fixture();
    const project = await service.addProject({ templateId: "one" });
    service.updateSettings(project.id, { stageTemplateIds: { planning: "two" } });
    templates.pop();
    service.updateSettings(project.id, service.getSettings(project.id));
    expect(store.get("projects", project.id).stageAgents.planning.config.agentProvider).toBe("claude");
    expect(() => assertStage(store.get("projects", project.id), "planning")).toThrow("权限隔离");
    service.updateSettings(project.id, { stageTemplateIds: { planning: "" } });
    expect(assertStage(store.get("projects", project.id), "planning").codexModel).toBe("model-one");
    templates[0].codexModel = "model-new";
    expect(assertStage(store.get("projects", project.id), "inspection").codexModel).toBe("model-one");
    await service.relinkProject({ projectId: project.id, templateId: "one" });
    expect(assertStage(store.get("projects", project.id), "inspection").codexModel).toBe("model-new");
    await service.close();
  });
  it("requires explicit relinking when another template targets an existing repository", async () => {
    const { service, templates } = fixture();
    const first = await service.addProject({ templateId: "one" });
    templates.push({ ...templates[0], id: "same-repo", agentProvider: "claude" });
    await expect(service.addProject({ templateId: "same-repo" })).rejects.toThrow("重新关联");
    const updated = await service.relinkProject({ projectId: first.id, templateId: "same-repo" });
    expect(updated.id).toBe(first.id); expect(updated.agent).toBe("claude");
    await service.close();
  });
  it("distinguishes remote identities and case-sensitive paths", async () => {
    const { service, templates } = fixture();
    const first = await service.addProject({ templateId: "two" });
    templates.push({ ...templates[1], id: "three", cwd: "/Repo" });
    const second = await service.addProject({ templateId: "three" });
    expect(first.id).not.toBe(second.id);
    expect(summarize(first).workspaceType).toBe("ssh");
    await expect(service.startInspection({ projectId: first.id })).rejects.toThrow("隔离执行器");
    await service.close();
  });
});
describe("remote Git execution", () => {
  it("quotes paths and arguments and disables Git hooks and filters", async () => {
    expect(quote("a'b")).toBe("'a'\\''b'");
    const executeProcess = vi.fn(async (_file, args) => ({ stdout: args.at(-1).includes("--get-regexp") ? "filter.evil.process\nfilter.evil.required\n" : "ok" }));
    const profiler = createEnvironmentProfiler({ executeProcess })({ templateSnapshot: { type: "wsl", wslDistro: "Ubuntu" } });
    await expect(profiler.git("/project ' $(unsafe)", ["status", "--porcelain"])).resolves.toBe("ok");
    const args = executeProcess.mock.calls[1][1];
    expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu", "--exec", "sh", "-c"]);
    expect(args.at(-1)).toContain("'core.hooksPath='");
    expect(args.at(-1)).toContain("'filter.evil.process='");
    expect(args.at(-1)).toContain("'filter.evil.required=false'");
  });
  it("uses SSH snapshots without launching an interactive session", async () => {
    const exec = vi.fn(async (_id, command) => command.includes("--get-regexp") ? "" : "ok");
    const runtimeFactory = vi.fn(() => ({ exec }));
    const config = { type: "ssh", sshConfig: { host: "example", encryptedSecret: "cipher" } };
    const profiler = createEnvironmentProfiler({ runtimeFactory })({ templateSnapshot: config });
    await expect(profiler.git("/repo", ["rev-parse", "HEAD"])).resolves.toBe("ok");
    expect(runtimeFactory.mock.calls[0][0].terminalManager.getSession()).toBe(config);
    expect(exec.mock.calls[0][2].allowExitCodes).toEqual([0, 1]);
  });
});
