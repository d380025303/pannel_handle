// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerSnapshot } from "../../vite-env";
import { CodeBuddyJobsDialog } from "./CodeBuddyJobsDialog";

const snapshot = { provider: "codebuddy", acpOptions: [] } as unknown as CodexAppServerSnapshot;
afterEach(cleanup);

describe("CodeBuddyJobsDialog", () => {
  it("dispatches a project task and replies to a waiting instance", async () => {
    const job = { id: "job-1", cwd: "C:\\work", name: "Review", status: "waiting", alive: true };
    const listJobs = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([job]);
    const dispatchJob = vi.fn().mockResolvedValue({ id: "job-1" });
    const jobAction = vi.fn().mockResolvedValue({ ok: true });
    const unwatchJob = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: {
      listJobs, dispatchJob, jobAction, unwatchJob,
      jobDispatchContext: vi.fn().mockResolvedValue({ defaultAgentName: "cli", agents: [{ name: "cli" }] }),
      listResumableJobs: vi.fn().mockResolvedValue([]), watchJob: vi.fn().mockResolvedValue(undefined),
      onJobsEvent: vi.fn(() => () => {}), onJobTranscript: vi.fn(() => () => {})
    } });
    render(<CodeBuddyJobsDialog sessionId="run" cwd="C:\\work" snapshot={snapshot} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "任务内容" }), { target: { value: "Review tests" } });
    fireEvent.click(screen.getByRole("button", { name: /^派发$/ }));
    await waitFor(() => expect(dispatchJob).toHaveBeenCalledWith("run", expect.objectContaining({ prompt: "Review tests" })));
    fireEvent.click(await screen.findByRole("button", { name: /Review.*等待回复/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "回复后台智能体" }), { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "回复" }));
    await waitFor(() => expect(jobAction).toHaveBeenCalledWith("run", "job-1", "reply", { text: "Continue" }));
  });
});
