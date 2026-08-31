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

  it("searches session templates while creating without changing hidden selections", async () => {
    const onCreate = vi.fn().mockResolvedValue(createLaunchTemplate([]));
    renderPanel({
      onCreate,
      sessionTemplates: [
        { ...createSession("one", "Frontend"), tags: ["Work"] },
        {
          ...createSession("two", "Production"),
          type: "ssh",
          shell: "ssh",
          cwd: "/srv/app",
          sshConfig: { host: "server.example.com", username: "deploy" }
        }
      ]
    });

    fireEvent.click(screen.getByRole("button", { name: "New launch template" }));
    fireEvent.change(screen.getByPlaceholderText("For example: Daily development"), { target: { value: "Deploy" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Frontend/ }));

    const search = screen.getByPlaceholderText("Search sessions or tags...");
    fireEvent.change(search, { target: { value: "server.example.com" } });
    expect(screen.queryByRole("checkbox", { name: /Frontend/ })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Production/ }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      name: "Deploy",
      sessionTemplateIds: ["one", "two"]
    }));
  });

  it("searches and clears session templates while editing", () => {
    renderPanel({
      launchTemplates: [createLaunchTemplate(["one"])],
      sessionTemplates: [createSession("one", "Frontend"), createSession("two", "Backend")]
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit session: Daily" }));
    const search = screen.getByPlaceholderText("Search sessions or tags...");
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("No matching sessions")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("checkbox", { name: /Frontend/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Backend/ })).toBeTruthy();
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
