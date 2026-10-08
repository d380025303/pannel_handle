// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { TerminalSession } from "../../vite-env";
import { EditSessionModal } from "./EditSessionModal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const session: TerminalSession = {
  id: "session-1",
  title: "Local project",
  shell: "pwsh.exe",
  cwd: "C:\\work",
  createdAt: 1,
  type: "windows",
  initialCommand: "pnpm dev",
  environmentOverrides: [{ name: "NODE_ENV", value: "development" }],
  quickCommands: [{ id: "command-1", command: "pnpm test", mode: "auto-enter" }]
};

describe("EditSessionModal", () => {
  it("saves the unified graphical mode for OpenCode", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, agentProvider: "opencode", graphicalSessionEnabled: false }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
    const toggle = screen.getByRole("checkbox", { name: "使用图形会话" });
    expect(toggle).toHaveProperty("checked", false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[14]).toBe(true);
  });
  it("saves the edited App Server setting", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, agentProvider: "codex", graphicalSessionEnabled: false }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
    const toggle = screen.getByRole("checkbox", { name: "使用图形会话" });
    expect(toggle).toHaveProperty("checked", false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[14]).toBe(true);
  });
  it("preserves an existing Codex backend and model when editing other fields", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, agentProvider: "codex", codexBackend: "openrouter", codexModel: "vendor/model", codexExperimentalAcknowledged: true }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
    expect(screen.queryByText("Codex 模型后端")).toBeNull();
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "Updated project" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const args = onSave.mock.calls[0] as unknown[];
    expect(args[1]).toBe("Updated project");
    expect(args[7]).toBe("openrouter");
    expect(args[8]).toBe("vendor/model");
    expect(args[12]).toBe(true);
  });
  it("uses the OpenAI backend when changing a session to Codex", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={session} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.queryByText("Codex 模型后端")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const args = onSave.mock.calls[0] as unknown[];
    expect(args[4]).toBe("codex");
    expect(args[7]).toBe("openai");
    expect(args[8]).toBeUndefined();
    expect(args[12]).toBeUndefined();
  });
  it("clears Codex backend values when changing to another provider", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, agentProvider: "codex", codexBackend: "openrouter", codexModel: "vendor/model", codexExperimentalAcknowledged: true }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const args = onSave.mock.calls[0] as unknown[];
    expect(args[4]).toBe("claude");
    expect(args[7]).toBeUndefined();
    expect(args[8]).toBeUndefined();
    expect(args[12]).toBeUndefined();
  });
  it("saves the App Server setting for an SSH remote Codex template", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, type: "ssh", cwd: "/srv/app",
      agentProvider: "codex", agentLocation: "remote", graphicalSessionEnabled: true,
      sshConfig: { host: "example.com" } }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
    const toggle = screen.getByRole("checkbox", { name: "使用图形会话" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[14]).toBe(false);
  });
  it("saves the unified graphical mode for CodeBuddy", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, agentProvider: "codebuddy", graphicalSessionEnabled: false }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
    const toggle = screen.getByRole("checkbox", { name: "使用图形会话" });
    expect(toggle).toHaveProperty("checked", false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[14]).toBe(true);
  });
  it("preserves the edited mode while changing providers", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, agentProvider: "codex", graphicalSessionEnabled: false }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
    const mode = () => screen.getByRole("checkbox", { name: "使用图形会话" });
    fireEvent.click(screen.getByRole("button", { name: "CodeBuddy" }));
    expect(mode()).toHaveProperty("checked", false);
    fireEvent.click(mode());
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
    expect(mode()).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[14]).toBe(true);
  });
  it("summarizes configured optional groups and preserves edited values", async () => {
    const onSave = vi.fn(async () => undefined);
    Object.defineProperty(window, "environmentApi", {
      configurable: true,
      value: { list: vi.fn(async () => []), preview: vi.fn(async () => []) }
    });

    render(<I18nProvider locale="zh-CN"><EditSessionModal session={session} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);

    expect(screen.getByRole("dialog", { name: "编辑会话" })).toBeTruthy();
    const startupDetails = screen.getByText("启动命令").closest("details");
    const environmentDetails = screen.getByText("环境变量", { selector: "summary span" }).closest("details");
    const commandDetails = screen.getByText("快捷命令").closest("details");
    expect(startupDetails?.open).toBe(false);
    expect(environmentDetails?.textContent).toContain("已配置");
    expect(commandDetails?.textContent).toContain("已配置 1 项");

    startupDetails!.open = true;
    fireEvent.change(startupDetails!.querySelector("textarea")!, { target: { value: "pnpm build" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const args = onSave.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe("session-1");
    expect(args[3]).toBe("pnpm build");
    expect(args[9]).toEqual([{ id: "command-1", command: "pnpm test", mode: "auto-enter" }]);
    expect(args[13]).toEqual({ environmentOverrides: [{ name: "NODE_ENV", value: "development" }] });
  });

  it("shows SSH essentials and keeps advanced connection values collapsed", () => {
    const sshSession: TerminalSession = {
      ...session,
      id: "ssh-1",
      type: "ssh",
      shell: "ssh",
      cwd: "/srv/app",
      sshConfig: { host: "example.com", port: 22, identityFile: "C:\\keys\\id_ed25519", remotePlatform: "linux" }
    };
    render(<I18nProvider locale="zh-CN"><EditSessionModal session={sshSession} tagSuggestions={[]} onSave={vi.fn()} onCancel={() => undefined} /></I18nProvider>);

    expect(screen.getByLabelText("主机")).toHaveProperty("value", "example.com");
    const advancedDetails = screen.getByText("高级选项").closest("details");
    expect(advancedDetails?.open).toBe(false);
    expect(advancedDetails?.textContent).toContain("已配置");
  });
});


it("shows saved OpenCode directories and submits an explicit empty list when cleared", async () => {
  const onSave = vi.fn(async () => undefined);
  render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, agentProvider: "opencode", openCodeAdditionalDirectories: ["C:\\shared"] }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
  const field = screen.getByRole("textbox", { name: /额外授权目录/ });
  expect(field).toHaveProperty("value", "C:\\shared");
  fireEvent.change(field, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
  expect((onSave.mock.calls[0] as unknown[])[17]).toEqual([]);
});

it("uses local Windows paths for an SSH local OpenCode Agent", async () => {
  const onSave = vi.fn(async () => undefined);
  render(<I18nProvider locale="zh-CN"><EditSessionModal session={{ ...session, type: "ssh", cwd: "/srv/work", agentProvider: "opencode", agentLocation: "local", sshConfig: { host: "example.com" } }} tagSuggestions={[]} onSave={onSave} onCancel={() => undefined} /></I18nProvider>);
  fireEvent.change(screen.getByRole("textbox", { name: /额外授权目录/ }), { target: { value: "C:\\local-shared" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
  expect((onSave.mock.calls[0] as unknown[])[17]).toEqual(["C:\\local-shared"]);
});
