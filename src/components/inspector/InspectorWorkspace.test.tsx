// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InspectorWorkspace } from "./InspectorWorkspace";
import type { ProjectInspectorApi, InspectorFinding } from "./types";

afterEach(() => { cleanup(); delete window.projectInspectorApi; });
it("requires explicit Plan confirmation and opens the returned independent session", async () => {
  const api = apiFixture();
  const onOpenSession = vi.fn();
  render(<InspectorWorkspace onOpenSession={onOpenSession} />);
  fireEvent.click(await screen.findByRole("button", { name: /TLS review/ }));
  fireEvent.click(await screen.findByRole("button", { name: "同意进入 Plan" }));
  expect(api.approvePlanning).not.toHaveBeenCalled();
  expect(screen.getByText("Codex · Plan · readOnly")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认创建只读 Plan" }));
  await waitFor(() => expect(api.approvePlanning).toHaveBeenCalledWith({ findingId: "f", expectedRevision: 7, title: "Plan · TLS review" }));
  await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("plan-session"));
});
function apiFixture() {
  const finding: InspectorFinding = { id: "f", projectId: "p", roleId: "r", title: "TLS review", severity: "P1", status: "awaiting_review", type: "suspected", verification: "evidence_supported", confidence: 0.65, revision: 7, headCommit: "abc", createdAt: 1, location: { path: "src/connection.js", startLine: 4, endLine: 4 }, evidence: { excerpt: "rejectUnauthorized: false", observations: ["Connection configuration"], counterEvidence: [] }, recommendation: "Review certificates", impact: "Trust boundary" };
  const api: ProjectInspectorApi = {
    listProjectTemplates: vi.fn(async () => []), relinkProject: vi.fn(),
    verifyImplementation: vi.fn(), approveMerge: vi.fn(), openImplementation: vi.fn(), approveImplementation: vi.fn(), getImplementation: vi.fn(async () => null), reviewImplementation: vi.fn(),
    openPlan: vi.fn(),
    approvePlanning: vi.fn(async () => ({ id: "link", findingId: "f", sessionId: "plan-session", status: "active", mode: "plan", executionPermission: "readOnly", approvedHeadCommit: "abc" })), getPlan: vi.fn(async () => null),
    listProjects: vi.fn(async () => [{ id: "p", name: "project", rootPath: "C:/project", headCommit: "abc", dirty: false }]),
    addProject: vi.fn(), chooseProject: vi.fn(), profileProject: vi.fn(),
    listRoles: vi.fn(async () => [{ id: "r", projectId: "p", name: "Security", paths: ["src/**"], focus: ["security"], enabled: true, confirmed: true, intervalMinutes: 60, incrementalOnChange: true, maxFilesPerRun: 100, maxTokensPerRun: 90000 }]),
    mergeRoles: vi.fn(), updateRole: vi.fn(), startInspection: vi.fn(async () => []), cancelInspection: vi.fn(), listInspectionRuns: vi.fn(async () => []),
    listFindings: vi.fn(async () => ({ items: [finding], total: 1 })), getFinding: vi.fn(async () => finding),
    decideFinding: vi.fn(async input => ({ ...finding, revision: 8, status: input.action })),
    getUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, unknownRuns: 0, roles: [] })), getSettings: vi.fn(async () => ({ schedulerEnabled: false, gitEnabled: false, incremental: true, concurrency: 2, timeoutSeconds: 300, maxTokensPerRun: 90000, model: "", notifications: true, missedRunPolicy: "skip", engine: "static" as const })),
    updateSettings: vi.fn(), onEvent: vi.fn(() => () => {})
  };
  window.projectInspectorApi = api;
  return api;
}
it("runs an explicit full inspection of the selected project", async () => {
  const api = apiFixture();
  render(<InspectorWorkspace cwd="C:/current" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "立即巡检" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "立即巡检" }));
  await waitFor(() => expect(api.startInspection).toHaveBeenCalledWith({ projectId: "p", incremental: false }));
});
it("shows Git evidence and uses the finding revision for audited decisions", async () => {
  const api = apiFixture();
  render(<InspectorWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: /TLS review/ }));
  expect(screen.getByText("rejectUnauthorized: false")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("处理备注"), { target: { value: "Review next week" } });
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  await waitFor(() => expect(api.decideFinding).toHaveBeenCalledWith({ id: "f", expectedRevision: 7, action: "deferred", reason: "Review next week" }));
});
it("clearly reports when the controlled Electron API is unavailable", () => {
  render(<InspectorWorkspace />);
  expect(screen.getByText("项目巡检需要在 Electron 主窗口中使用。")).toBeTruthy();
});

it("keeps an approval failure visible in its confirmation dialog and allows Escape recovery", async () => {
  const api = apiFixture();
  vi.mocked(api.approvePlanning).mockRejectedValue(new Error("Git 版本已变化"));
  render(<InspectorWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: /TLS review/ }));
  fireEvent.click(await screen.findByRole("button", { name: "同意进入 Plan" }));
  const dialog = screen.getByRole("dialog", { name: "批准创建 Plan" });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认创建只读 Plan" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Git 版本已变化");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "批准创建 Plan" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "TLS review" })).toBeTruthy();
});
it("traps keyboard focus in the active confirmation dialog", async () => {
  apiFixture();
  render(<InspectorWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: /TLS review/ }));
  fireEvent.click(await screen.findByRole("button", { name: "同意进入 Plan" }));
  const dialog = screen.getByRole("dialog", { name: "批准创建 Plan" });
  const confirm = within(dialog).getByRole("button", { name: "确认创建只读 Plan" });
  const cancel = within(dialog).getByRole("button", { name: "取消" });
  confirm.focus(); fireEvent.keyDown(confirm, { key: "Tab" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(confirm);
});

it("requires a second explicit approval bound to the completed Plan", async () => {
  const api = apiFixture();
  const finding = await api.getFinding("f");
  vi.mocked(api.getFinding).mockResolvedValue({ ...finding, status: "awaiting_implementation" });
  vi.mocked(api.getPlan).mockResolvedValue({ id: "approved-plan", findingId: "f", status: "completed", mode: "plan", executionPermission: "readOnly", approvedHeadCommit: "abc", planOutput: "Review this implementation plan" });
  vi.mocked(api.approveImplementation).mockResolvedValue({ id: "implementation-link", findingId: "f", sessionId: "implementation-session", status: "active", mode: "default", executionPermission: "askApproval", approvedHeadCommit: "abc" });
  const onOpenSession = vi.fn();
  render(<InspectorWorkspace onOpenSession={onOpenSession} />);
  fireEvent.click(await screen.findByRole("button", { name: /TLS review/ }));
  fireEvent.click(await screen.findByRole("button", { name: "批准实施" }));
  expect(api.approveImplementation).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "批准隔离实施" });
  expect(within(dialog).getByText("Review this implementation plan")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "确认实施此方案" }));
  await waitFor(() => expect(api.approveImplementation).toHaveBeenCalledWith({ findingId: "f", expectedRevision: 7, planId: "approved-plan" }));
  await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("implementation-session"));
});

it("shows actual verification logs and requires a separate merge confirmation", async () => {
  const api = apiFixture(); const finding = await api.getFinding("f");
  vi.mocked(api.getFinding).mockResolvedValue({ ...finding, status: "awaiting_merge" });
  const implementation = { id: "i", findingId: "f", status: "verified", mode: "default", executionPermission: "askApproval", approvedHeadCommit: "abc", sealed: true, review: { headCommit: "new-head", dirty: false, status: "", diff: "Reviewed implementation diff", digest: "d".repeat(64), files: ["source.js"], reviewedAt: 1 }, verification: { status: "passed", passed: true, results: [{ script: "test", exitCode: 0, passed: true, output: "Actual tests passed", timedOut: false, truncated: false, durationMs: 100 }] } };
  vi.mocked(api.getImplementation).mockResolvedValue(implementation);
  vi.mocked(api.approveMerge).mockResolvedValue({ ...implementation, status: "merged", merge: { headCommit: "new-head", mergedAt: 1 } });
  render(<InspectorWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: /TLS review/ }));
  fireEvent.click(await screen.findByRole("button", { name: "单独批准合并" }));
  expect(api.approveMerge).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "确认合并审批" });
  expect(within(dialog).getByText("Actual tests passed")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "确认合并此版本" }));
  await waitFor(() => expect(api.approveMerge).toHaveBeenCalledWith({ findingId: "f", expectedRevision: 7, digest: "d".repeat(64) }));
});

it("adds projects from a chosen session template without a directory picker", async () => {
  const api = apiFixture();
  vi.mocked(api.listProjectTemplates).mockResolvedValue([{ id: "t", title: "Repository agent", cwd: "C:/repo", type: "windows", agent: "codex" }]);
  vi.mocked(api.addProject).mockResolvedValue({ id: "p", name: "Repo", rootPath: "C:/repo", headCommit: "abc", dirty: false });
  render(<InspectorWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "添加项目" }));
  const dialog = await screen.findByRole("dialog", { name: "选择会话模板" });
  fireEvent.change(within(dialog).getByLabelText("会话模板"), { target: { value: "t" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));
  await waitFor(() => expect(api.addProject).toHaveBeenCalledWith({ templateId: "t" }));
  expect(api.chooseProject).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("shows missing template guidance and cancels without adding", async () => {
  const api = apiFixture(); render(<InspectorWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "添加项目" }));
  const dialog = await screen.findByRole("dialog", { name: "选择会话模板" });
  expect(within(dialog).getByText(/没有可用模板/)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "确认" }).hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(api.addProject).not.toHaveBeenCalled();
});
