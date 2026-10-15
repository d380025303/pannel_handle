import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createSessionInstanceService } = require("./session-instance-service.cjs");

function fixture(templates = [{ id: "saved", title: "Work", type: "windows", agentProvider: "codex", graphicalSessionEnabled: true, modelSource: "native", codexAppServerModel: "old" }]) {
  const events = [];
  const sessions = new Map();
  let nextId = 0;
  const sessionStore = { getLibrary: () => templates, getTemplate: id => templates.find(t => t.id === id) };
  const terminalManager = { closeSession: vi.fn(id => sessions.delete(id)) };
  const agentSessionLauncher = { launchSession: vi.fn(async (template, options) => {
    events.push("launch");
    const session = { ...template, id: `run-${++nextId}`, templateId: options.templateId, runtimeMode: "app-server" };
    sessions.set(session.id, { session, threadId: "thread", mode: "default", model: template.codexAppServerModel || "native-default", capabilities: { plan: true } });
    return session;
  }) };
  const graphicalService = {
    snapshot: id => sessions.get(id),
    setModel: vi.fn(async (id, model) => { events.push("model"); sessions.get(id).model = model; }),
    setMode: vi.fn(async (id, mode) => { events.push("mode"); sessions.get(id).mode = mode; }),
    submitStarted: vi.fn(async () => { events.push("submit"); })
  };
  return { service: createSessionInstanceService({ sessionStore, terminalManager, agentSessionLauncher, graphicalService }), templates, events, sessions,
    terminalManager, agentSessionLauncher, graphicalService };
}
const args = { templateId: "saved", mode: "plan", prompt: "Do work" };
const injection = { tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
  toolCallback: { url: "http://localhost/tools", bearerToken: "private-token" } };

describe("MCP session instances", () => {
  it("retains automatic instances when submission fails before a turn starts", async () => {
    const f = fixture(); const created = vi.fn();
    f.graphicalService.submitStarted.mockRejectedValue(new Error("submission failure"));
    await expect(f.service.create(args, { creationSource: { kind: "work-item", trigger: "automation" }, onSessionCreated: created })).rejects.toThrow("submission failure");
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1" }));
    expect(f.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(f.sessions.has("run-1")).toBe(true);
  });
  it.each([
    ["codex", "cx-model"], ["codebuddy", "cb-model"], ["opencode", "oc-model"],
    ["claude", null], ["qoder", null], ["gemini", null], ["grok", null]
  ])("lists only the native model configured for %s", (agentProvider, modelId) => {
    const f = fixture([{ id: "saved", agentProvider, modelSource: "native",
      codexAppServerModel: "cx-model", codeBuddyGraphicalOptions: { model: "cb-model" },
      openCodeGraphicalOptions: { model: "oc-model" } }]);
    expect(f.service.listTemplates().templates[0]).toMatchObject({ agentProvider, modelSource: "native", modelId });
  });
  it.each([
    { agentProvider: "opencode", codeBuddyGraphicalOptions: { model: "cb-model" } },
    { agentProvider: "codebuddy", openCodeGraphicalOptions: { model: "oc-model" } },
    { agentProvider: "codex", codeBuddyGraphicalOptions: { model: "cb-model" } }
  ])("returns null when the native model for $agentProvider is missing", template => {
    const f = fixture([{ id: "saved", ...template }]);
    expect(f.service.listTemplates().templates[0].modelId).toBeNull();
  });
  it.each(["codex", "codebuddy", "opencode"])("preserves external model selection for %s", agentProvider => {
    const templates = [
      { modelSource: "minimax", modelId: "external-model", codexModel: "legacy-model" },
      { codexBackend: "openrouter", codexModel: "legacy-model" }
    ].map((selection, index) => ({ id: `saved-${index}`, agentProvider,
      codexAppServerModel: "cx-model", codeBuddyGraphicalOptions: { model: "cb-model" },
      openCodeGraphicalOptions: { model: "oc-model" }, ...selection }));
    expect(fixture(templates).service.listTemplates().templates).toMatchObject([
      { modelSource: "minimax", modelId: "external-model" },
      { modelSource: "openrouter", modelId: "legacy-model" }
    ]);
  });
  it("passes tools only as runtime options and keeps templates unchanged", async () => {
    const f = fixture(); const before = structuredClone(f.templates);
    await f.service.create({ ...args, ...injection });
    const [template, options] = f.agentSessionLauncher.launchSession.mock.calls[0];
    expect(options.injectedTools).toEqual({ ...injection, toolCallback: { ...injection.toolCallback, timeoutMs: 60000 } });
    expect(JSON.stringify(template)).not.toContain("private-token");
    expect(f.templates).toEqual(before);
  });
  it.each([{ type: "wsl" }, { type: "ssh" }, { agentProvider: "opencode" }])("rejects injected tools for %j before launch", async override => {
    const f = fixture([{ id: "saved", type: "windows", agentProvider: "codex", ...override }]);
    await expect(f.service.create({ ...args, ...injection })).rejects.toThrow("工具注入");
    expect(f.agentSessionLauncher.launchSession).not.toHaveBeenCalled();
  });
  it.each([{ toolCallback: undefined }, { tools: undefined }, { tools: [...injection.tools, ...injection.tools] },
    { toolCallback: { url: "file:///tmp" } }, { toolCallback: { url: "http://user:pass@localhost" } },
    { tools: [{ ...injection.tools[0], inputSchema: { type: "string" } }] }])("rejects invalid tool parameters %j", async override => {
    const f = fixture(); await expect(f.service.create({ ...args, ...injection, ...override })).rejects.toThrow();
    expect(f.agentSessionLauncher.launchSession).not.toHaveBeenCalled();
  });
  it("shares the Agent schema with HTTP and rejects removed source parameters", () => {
    const { sessionInstanceSchema } = require("./session-instance-schema.cjs");
    expect(sessionInstanceSchema.safeParse({ ...args, agentProvider: "codebuddy" }).success).toBe(true);
    expect(sessionInstanceSchema.safeParse({ ...args, modelSource: "native" }).success).toBe(false);
  });
  it.each(["codex", "codebuddy", "opencode"])("switches from %s without leaking provider configuration", async originalProvider => {
    const target = originalProvider === "codex" ? "opencode" : "codex";
    const f = fixture([{ id: "saved", agentProvider: originalProvider, graphicalSessionEnabled: true,
      type: "windows", initialCommand: "prepare", environmentOverrides: { CUSTOM: "value" },
      codexAppServerEffort: "high", codeBuddyGraphicalOptions: { permissionMode: "old" }, openCodeAdditionalDirectories: ["old"] }]);
    const before = structuredClone(f.templates);
    await f.service.create({ ...args, agentProvider: target, modelId: "selected" });
    const launched = f.agentSessionLauncher.launchSession.mock.calls[0][0];
    expect(launched.codexAppServerEffort).toBeUndefined();
    expect(launched.codeBuddyGraphicalOptions).toBeUndefined();
    expect(launched.openCodeAdditionalDirectories).toBeUndefined();
    expect(launched).toMatchObject({ agentProvider: target, initialCommand: "prepare", environmentOverrides: { CUSTOM: "value" } });
    expect(f.graphicalService.setModel).toHaveBeenCalledWith("run-1", "selected");
    expect(f.templates).toEqual(before);
  });
  it("lists only Agent templates with whitelisted fields, including terminal Agents", () => {
    const f = fixture([{ id: "shell", type: "windows" }, { id: "saved", title: "Work", agentProvider: "codex", type: "ssh", graphicalSessionEnabled: false,
      sshConfig: { password: "secret" }, initialCommand: "secret", environmentOverrides: { TOKEN: "secret" } }]);
    expect(f.service.listTemplates()).toEqual({ templates: [{ templateId: "saved", title: "Work", agentProvider: "codex", type: "ssh",
      graphicalSessionEnabled: false, modelSource: "native", modelId: null }] });
  });
  it("inherits configuration, submits after mode selection, and creates independent instances", async () => {
    const f = fixture(); const before = structuredClone(f.templates);
    expect(await f.service.create(args)).toMatchObject({ sessionId: "run-1", templateId: "saved", mode: "plan", modelId: "old", status: "started" });
    expect(await f.service.create({ ...args, mode: "default" })).toMatchObject({ sessionId: "run-2", mode: "default" });
    expect(f.events).toEqual(["launch", "mode", "submit", "launch", "mode", "submit"]);
    expect(f.agentSessionLauncher.launchSession.mock.calls[0][1]).toEqual({ useProvidedTemplate: true, templateId: undefined });
    expect(f.templates).toEqual(before);
  });
  it("selects a native model before mode and prompt", async () => {
    const f = fixture();
    expect(await f.service.create({ ...args, modelId: "new" })).toMatchObject({ modelSource: "native", modelId: "new" });
    expect(f.events).toEqual(["launch", "model", "mode", "submit"]);
    expect(f.templates[0].codexAppServerModel).toBe("old");
  });
  it.each(["codex", "codebuddy", "opencode"])("overrides the template Agent with %s and clears old settings", async agentProvider => {
    const f = fixture([{ id: "saved", type: "windows", agentProvider: "opencode", graphicalSessionEnabled: true,
      modelSource: "minimax", modelId: "old", cwd: "workspace", openCodeGraphicalOptions: { model: "old", effort: "high" } }]);
    const before = structuredClone(f.templates);
    expect(await f.service.create({ ...args, agentProvider })).toMatchObject({ agentProvider, modelSource: "native" });
    const launched = f.agentSessionLauncher.launchSession.mock.calls[0][0];
    expect(launched.cwd).toBe("workspace");
    expect(launched.modelId).toBeUndefined();
    if (agentProvider !== "opencode") expect(launched.openCodeGraphicalOptions).toBeUndefined();
    expect(f.templates).toEqual(before);
  });
  it("uses native model overrides and otherwise inherits external models", async () => {
    const f = fixture([{ id: "saved", type: "windows", agentProvider: "opencode", modelSource: "minimax", modelId: "old" }]);
    expect(await f.service.create(args)).toMatchObject({ modelSource: "minimax", modelId: "old" });
    expect(await f.service.create({ ...args, modelId: "new" })).toMatchObject({ modelSource: "native", modelId: "new" });
  });
  it.each([{ templateId: "missing" }, { prompt: " " }, { mode: "execute" }, { modelId: " " }, { agentProvider: "invalid" }, { modelSource: "minimax" }])("rejects invalid creation %j before launch", async override => {
    const f = fixture(); await expect(f.service.create({ ...args, ...override })).rejects.toThrow();
    expect(f.agentSessionLauncher.launchSession).not.toHaveBeenCalled();
  });
  it.each([{ agentProvider: undefined }, { graphicalSessionEnabled: false }, { agentProvider: "copilot" }, { type: "ssh", modelSource: "minimax", modelId: "x" }])("rejects unsupported template %j", async override => {
    const f = fixture([{ id: "saved", agentProvider: "codex", type: "windows", ...override }]);
    await expect(f.service.create(args)).rejects.toThrow(); expect(f.agentSessionLauncher.launchSession).not.toHaveBeenCalled();
  });
  it.each(["model", "mode", "submit"])("closes only the new instance when %s fails before submission", async stage => {
    const f = fixture();
    f.graphicalService[stage === "model" ? "setModel" : stage === "mode" ? "setMode" : "submitStarted"].mockRejectedValue(new Error("failure"));
    await expect(f.service.create({ ...args, modelId: "new" })).rejects.toThrow(stage === "model" ? "当前 Agent 不支持指定的原生模型。" : "failure");
    expect(f.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
    if (stage !== "submit") expect(f.graphicalService.submitStarted).not.toHaveBeenCalled();
  });
  it("does not submit when Plan is unavailable", async () => {
    const f = fixture(); const snapshot = f.graphicalService.snapshot;
    f.graphicalService.snapshot = id => ({ ...snapshot(id), capabilities: { plan: false } });
    await expect(f.service.create(args)).rejects.toThrow("Plan");
    expect(f.graphicalService.submitStarted).not.toHaveBeenCalled();
    expect(f.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
  });
});
