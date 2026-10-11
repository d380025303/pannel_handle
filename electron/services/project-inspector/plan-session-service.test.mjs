import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createFindingStore } = require("./finding-store.cjs");
const { createPlanSessionService } = require("./plan-session-service.cjs");
const fixtures = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-plan-store-"));
  const store = createFindingStore({ userData: root }); fixtures.push({ root, store });
  store.put("findings", { id: "finding", projectId: "project", status: "planning", revision: 2, planSessionId: "old-runtime" });
  store.put("sessions", { id: "link", projectId: "project", findingId: "finding", stage: "planning", status: "active", sessionId: "old-runtime", templateId: "owned-template" });
  const terminalManager = { getSession: vi.fn(() => null), listSessions: vi.fn(() => []), closeSession: vi.fn(), deleteSavedSession: vi.fn() };
  const router = { snapshot: vi.fn(() => ({ threadId: "thread", busy: false, turnStatus: "completed", items: [{ type: "plan", text: "# Complete plan\n\n1. Review\n2. Test\n\nWait for implementation approval." }] })), close: vi.fn() };
  const launcher = { launchSession: vi.fn(async () => ({ id: "restored-runtime" })) };
  const sessionStore = { getTemplate: vi.fn(() => ({ id: "owned-template", inspectorStage: "planning", inspectorLinkId: "link", inspectorThreadId: "thread" })) };
  const onEvent = vi.fn();
  const service = createPlanSessionService({ store, launcher, router, terminalManager, sessionStore, onEvent });
  return { root, store, terminalManager, router, launcher, sessionStore, onEvent, service };
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }); } });
it("persists the full completed plan and remaps runtime IDs after restoring the owned template", () => {
  const f = fixture();
  f.terminalManager.listSessions.mockReturnValue([{ id: "new-runtime", inspectorLinkId: "link" }]);
  f.service.sync(); f.service.sync();
  expect(f.store.get("findings", "finding")).toMatchObject({ status: "awaiting_implementation", planSessionId: "new-runtime", revision: 3 });
  const link = f.store.get("sessions", "link");
  expect(link).toMatchObject({ status: "completed", threadId: "thread", sessionId: "new-runtime" });
  expect(link.planOutput).toContain("Wait for implementation approval.");
  expect(f.onEvent).toHaveBeenCalledTimes(1);
  const reopened = createFindingStore({ userData: f.root });
  try { expect(reopened.get("sessions", "link").planOutput).toBe(link.planOutput); }
  finally { reopened.close(); }
});
it("reopens only the associated protected template and deduplicates concurrent open actions", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.openPlan("finding"), f.service.openPlan("finding")]);
  expect(a.sessionId).toBe("restored-runtime"); expect(b.sessionId).toBe(a.sessionId);
  expect(f.launcher.launchSession).toHaveBeenCalledTimes(1);
  expect(f.store.get("findings", "finding").planSessionId).toBe("restored-runtime");
});
it("refuses a replaced template instead of creating an unrelated new conversation", async () => {
  const f = fixture();
  f.sessionStore.getTemplate.mockReturnValue({ inspectorStage: "planning", inspectorLinkId: "other", inspectorThreadId: "thread" });
  await expect(f.service.openPlan("finding")).rejects.toThrow("关联模板不可用");
  expect(f.launcher.launchSession).not.toHaveBeenCalled();
});

it("refreshes completed output on lookup without waiting for the periodic timer", () => {
  const f = fixture();
  f.terminalManager.getSession.mockReturnValue({ id: "old-runtime", inspectorLinkId: "link" });
  expect(f.service.getPlan("finding")).toMatchObject({ status: "completed", planOutput: expect.stringContaining("Complete plan") });
});
it("preserves a newer user decision when a background Plan finishes", () => {
  const f = fixture();
  f.store.put("findings", { ...f.store.get("findings", "finding"), status: "ignored", revision: 3 });
  f.terminalManager.getSession.mockReturnValue({ id: "old-runtime", inspectorLinkId: "link" });
  f.service.sync();
  expect(f.store.get("findings", "finding")).toMatchObject({ status: "ignored", revision: 3 });
  expect(f.service.getPlan("finding").status).toBe("completed");
});
