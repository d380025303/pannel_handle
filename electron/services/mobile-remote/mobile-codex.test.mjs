import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createMobileCodexHandlers } = require("./mobile-codex.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");

describe("mobile Codex skill settings", () => {
  function fixture() {
    const service = { setSkillEnabled: vi.fn(async () => {}) };
    const session = { id: "run", agentProvider: "codex" };
    const current = { provider: "codex", threadId: "thread", busy: false };
    const handler = createMobileCodexHandlers({ graphicalService: service });
    const call = (input, command = "skill-enable") => handler.handle({ type: `graphical.codex.${command}`, input }, session, current);
    return { service, session, current, call };
  }
  it("routes enabled and disabled values without converting remote paths", async () => {
    const f = fixture();
    for (const enabled of [true, false]) {
      await f.call({ path: "/remote/review/SKILL.md", enabled });
      expect(f.service.setSkillEnabled).toHaveBeenLastCalledWith("run", "/remote/review/SKILL.md", enabled);
    }
  });
  it("rejects invalid inputs, forbidden commands, unavailable states and other providers", async () => {
    const f = fixture();
    for (const input of [{ path: "", enabled: true }, { path: "/skill", enabled: "false" }, { path: "a\0b", enabled: true }])
      await expect(f.call(input)).rejects.toThrow("参数无效");
    await expect(f.call({}, "skills/config/write")).rejects.toThrow("不被允许");
    for (const key of ["busy", "archived", "compacting", "reviewing"]) {
      f.current[key] = true;
      await expect(f.call({ path: "/skill", enabled: true })).rejects.toThrow("不可执行");
      f.current[key] = false;
    }
    f.session.agentProvider = "opencode";
    await expect(f.call({ path: "/skill", enabled: true })).rejects.toThrow("仅 Codex");
    expect(f.service.setSkillEnabled).not.toHaveBeenCalled();
  });
  it("exposes the write only through the Codex graphical router", async () => {
    const f = fixture();
    const router = createGraphicalSessionRouter(f.service, {}, { getSession: () => f.session });
    await router.setSkillEnabled("run", "/skill", false);
    expect(f.service.setSkillEnabled).toHaveBeenCalledWith("run", "/skill", false);
    f.session.agentProvider = "opencode";
    expect(() => router.setSkillEnabled("run", "/skill", false)).toThrow("仅 Codex");
  });
});


it("routes configuration and permission choices only through controlled Codex commands", async () => {
  const service = { readConfiguration: vi.fn(async () => ({ cwd: "/remote" })), setPermissionProfile: vi.fn(async () => ({})), setExecutionPermission: vi.fn(async () => ({})) };
  const session = { id: "run", agentProvider: "codex" };
  const current = { provider: "codex", threadId: null };
  const handler = createMobileCodexHandlers({ graphicalService: service });
  const call = (command, input = {}) => handler.handle({ type: `graphical.codex.${command}`, input }, session, current);
  expect(await call("configuration")).toEqual({ cwd: "/remote" });
  await call("permission-profile", { profileId: "project" });
  expect(service.setPermissionProfile).toHaveBeenCalledWith("run", "project");
  await call("permission-legacy", { permission: "readOnly" });
  expect(service.setExecutionPermission).toHaveBeenCalledWith("run", "readOnly");
  await expect(call("permission-profile", { profileId: "a\0b" })).rejects.toThrow("参数无效");
  await expect(call("config/read")).rejects.toThrow("不被允许");
  session.agentProvider = "opencode";
  await expect(call("configuration")).rejects.toThrow("仅 Codex");
});
