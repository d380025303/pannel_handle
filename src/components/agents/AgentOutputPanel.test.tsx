// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { AgentOutputRun } from "../../vite-env";
import { AgentOutputPanel } from "./AgentOutputPanel";

const currentRun: AgentOutputRun = {
  id: "run-1",
  templateId: "template-1",
  provider: "codex",
  title: "Codex project",
  cwd: "C:\\work",
  startedAt: 100,
  finishedAt: null,
  exitCode: null,
  responsesTruncated: false,
  responses: [
    { id: "plan-1", createdAt: 150, content: "## Plan\n\nInspect the call chain.", phase: "commentary", truncated: false },
    { id: "turn-1", createdAt: 200, content: "# First answer\n\nReadable content", phase: "final", truncated: false }
  ]
};

const closedRun: AgentOutputRun = {
  ...currentRun,
  id: "run-closed",
  templateId: undefined,
  title: "Closed quick Agent",
  finishedAt: 400,
  responses: [{ id: "turn-2", createdAt: 300, content: "Persisted answer", phase: "final", truncated: false }]
};

const list = vi.fn(async (options?: { scope?: "current" | "all" }) => (
  options?.scope === "all"
    ? { runs: [closedRun, currentRun], total: 2 }
    : { runs: [currentRun], total: 1 }
));
const writeText = vi.fn(async () => true);
let historyListener: ((payload: { sessionId: string; templateId?: string; timestamp: number }) => void) | undefined;

describe("AgentOutputPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    list.mockClear();
    writeText.mockClear();
    historyListener = undefined;
    Object.defineProperty(window, "agentOutputApi", {
      configurable: true,
      value: {
        list,
        hasAny: vi.fn(async () => true),
        onChanged: vi.fn((callback) => {
          historyListener = callback;
          return () => undefined;
        })
      }
    });
    Object.defineProperty(window, "clipboardApi", {
      configurable: true,
      value: { writeText }
    });
    Object.defineProperty(window, "externalLinkApi", {
      configurable: true,
      value: { open: vi.fn(async () => undefined) }
    });
  });

  it("renders progress and final content as readable Markdown and copies it", async () => {
    render(<I18nProvider locale="en-US"><AgentOutputPanel activeSessionId="run-1" activeTemplateId="template-1" /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByText("Inspect the call chain.")).toBeTruthy();
    expect(screen.getByText("Progress")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "First answer" })).toBeTruthy();
    expect(screen.getByText("Readable content")).toBeTruthy();
    expect(screen.getByText("Final response")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Copy content" })[1]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(currentRun.responses[1].content));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "run-1", templateId: "template-1" }));
  });

  it("switches to all history and shows closed one-off sessions", async () => {
    render(<I18nProvider locale="en-US"><AgentOutputPanel activeSessionId="run-1" /></I18nProvider>);
    await screen.findByText("Readable content");

    fireEvent.click(screen.getByRole("tab", { name: "All history" }));

    expect(await screen.findByText("Closed quick Agent")).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "all", offset: 0, limit: 50 }));
  });

  it("reloads the active template when another instance writes content", async () => {
    render(<I18nProvider locale="en-US"><AgentOutputPanel activeSessionId="run-1" activeTemplateId="template-1" /></I18nProvider>);
    await screen.findByText("Readable content");
    const callsBefore = list.mock.calls.length;

    historyListener?.({ sessionId: "run-2", templateId: "template-1", timestamp: 500 });

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});
