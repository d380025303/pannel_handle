// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { LaunchTemplate, TerminalSession } from "../../vite-env";
import { LaunchTemplatePanel, moveLaunchTemplateMember } from "./LaunchTemplatePanel";

function createSession(id: string, title: string): TerminalSession {
  return {
    id,
    title,
    shell: "powershell.exe",
    cwd: "C:\\work",
    createdAt: 1,
    type: "windows"
  };
}

function createLaunchTemplate(sessionTemplateIds: string[]): LaunchTemplate {
  return {
    id: "launch-1",
    name: "Daily",
    sessionTemplateIds,
    createdAt: 1,
    updatedAt: 1
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof LaunchTemplatePanel>> = {}) {
  const props: React.ComponentProps<typeof LaunchTemplatePanel> = {
    launchTemplates: [],
    sessionTemplates: [createSession("one", "One"), createSession("two", "Two")],
    onCreate: vi.fn().mockResolvedValue(createLaunchTemplate([])),
    onUpdate: vi.fn().mockResolvedValue(createLaunchTemplate([])),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onLaunch: vi.fn().mockResolvedValue({ launchedSessionIds: [], failures: [] }),
    ...overrides
  };
  render(
    <I18nProvider locale="en-US">
      <LaunchTemplatePanel {...props} />
    </I18nProvider>
  );
  return props;
}

describe("LaunchTemplatePanel", () => {
  afterEach(cleanup);

  it("reorders selected member ids without changing the remaining order", () => {
    expect(moveLaunchTemplateMember(["one", "two", "three"], "three", "one"))
      .toEqual(["three", "one", "two"]);
  });

  it("creates a named launch template with members in selection order", async () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "New launch template" }));
    fireEvent.change(screen.getByPlaceholderText("For example: Daily development"), { target: { value: "Morning" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /One/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith({
      name: "Morning",
      sessionTemplateIds: ["two", "one"]
    }));
  });

  it("disables empty profiles and reports partial launch failures", async () => {
    const onLaunch = vi.fn().mockResolvedValue({
      launchedSessionIds: ["running-one"],
      failures: [{ templateId: "two", title: "Two", error: "spawn failed" }]
    });
    const { rerender } = render(
      <I18nProvider locale="en-US">
        <LaunchTemplatePanel
          launchTemplates={[createLaunchTemplate([])]}
          sessionTemplates={[createSession("one", "One"), createSession("two", "Two")]}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          onLaunch={onLaunch}
        />
      </I18nProvider>
    );
    expect((screen.getByRole("button", { name: "Launch all sessions: Daily" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <I18nProvider locale="en-US">
        <LaunchTemplatePanel
          launchTemplates={[createLaunchTemplate(["one", "two"])]}
          sessionTemplates={[createSession("one", "One"), createSession("two", "Two")]}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          onLaunch={onLaunch}
        />
      </I18nProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch all sessions: Daily" }));

    expect(await screen.findByText("1 session templates failed to launch")).toBeTruthy();
    expect(screen.getByText("Two: spawn failed")).toBeTruthy();
  });
});
