import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createProjectTools } = require("./project-tools.cjs");

function fixture() {
  const running = { id: "run-1", title: "开发", type: "windows", cwd: "C:\\work", secret: "hidden" };
  const saved = { id: "saved-1", title: "常用", type: "windows", cwd: "C:\\work", encryptedSecret: "hidden" };
  const terminalManager = { listSessions: vi.fn(() => [running]), getSession: vi.fn(() => running), renameSession: vi.fn(), closeSession: vi.fn() };
  const sessionStore = { getLibrary: vi.fn(() => [saved]), getTemplate: vi.fn(() => saved) };
  const launchTemplateStore = { getAll: vi.fn(() => []), get: vi.fn() };
  const agentSessionLauncher = { createSession: vi.fn(async () => running), launchSession: vi.fn(async () => running) };
  const codexSessionControl = { listSessions: vi.fn(() => [{ id: "codex-1", title: "Agent" }]), submit: vi.fn(async () => {}), switchMode: vi.fn() };
  const dependencies = { terminalManager, sessionStore, launchTemplateStore, agentSessionLauncher,
    launchTemplateService: { launch: vi.fn() }, tokenUsageModule: { getDashboard: vi.fn(() => ({ range: "30d", summary: { sessionCount: 1 }, providerBreakdown: [] })) }, codexSessionControl };
  return { tools: createProjectTools(dependencies), terminalManager, sessionStore, codexSessionControl, running, saved };
}

describe("project assistant tools", () => {
  it("returns only public session fields from local data", () => {
    const { tools } = fixture();
    const result = tools.listData("saved_sessions");
    expect(result).toMatchObject({ total: 1, items: [{ id: "saved-1", title: "常用" }] });
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it("revalidates a confirmed rename against current state", async () => {
    const { tools, terminalManager, running } = fixture();
    const prepared = tools.prepareAction("rename_session", { id: "run-1", title: "新版" });
    running.title = "其他修改";
    await expect(tools.executeAction(prepared)).rejects.toThrow("Target changed");
    expect(terminalManager.renameSession).not.toHaveBeenCalled();
  });

  it("does not launch a saved session after its configuration changes", async () => {
    const { tools, saved } = fixture();
    const prepared = tools.prepareAction("launch_saved_session", { id: "saved-1" });
    saved.cwd = "C:\\changed";
    await expect(tools.executeAction(prepared)).rejects.toThrow("Target changed");
  });

  it("rejects SSH sessions and invalid action parameters", () => {
    const { tools, running } = fixture();
    running.type = "ssh";
    expect(() => tools.prepareAction("close_session", { id: "run-1" })).toThrow("Only local Windows");
    expect(() => tools.prepareAction("create_session", { title: " " })).toThrow("1-80");
  });

  it("confirms Codex input and mode actions against the live target", async () => {
    const { tools, codexSessionControl } = fixture();
    const input = tools.prepareAction("send_codex_input", { id: "codex-1", title: "Continue" });
    await tools.executeAction(input);
    expect(codexSessionControl.submit).toHaveBeenCalledWith("codex-1", "Continue");
    const mode = tools.prepareAction("switch_codex_mode", { id: "codex-1" });
    codexSessionControl.listSessions.mockReturnValue([]);
    await expect(tools.executeAction(mode)).rejects.toThrow("not found");
    expect(codexSessionControl.switchMode).not.toHaveBeenCalled();
  });
});
