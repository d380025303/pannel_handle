// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CreateSessionModal } from "./CreateSessionModal";

vi.mock("./CodexBackendFields", () => ({ CodexBackendFields: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CreateSessionModal structure", () => {
  it("defaults a new Qoder session to graphical ACP", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Qoder" }));
    expect(screen.getByRole("checkbox", { name: "使用图形会话" })).toHaveProperty("checked", true);
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "C:\\work" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agentProvider: "qoder", graphicalSessionEnabled: true })));
  });
  it("defaults new Claude sessions to graphical ACP", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByRole("checkbox", { name: "使用图形会话" })).toHaveProperty("checked", true);
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "C:\\work" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agentProvider: "claude", graphicalSessionEnabled: true })));
  });
  it("defaults a new OpenCode session to ACP and allows terminal mode", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
    const toggle = screen.getByRole("checkbox", { name: "使用图形会话" });
    expect(toggle).toHaveProperty("checked", true);
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "C:\\work" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ graphicalSessionEnabled: false })));
  });
  it("sets App Server per new local Codex template", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    const toggle = screen.getByRole("checkbox", { name: "使用图形会话" });
    expect(toggle).toHaveProperty("checked", true);
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "C:\\work" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ graphicalSessionEnabled: false })));
  });
  it("keeps one mode choice when switching providers", () => {
    render(<I18nProvider locale="zh-CN"><CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={vi.fn()} onCancel={() => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    const mode = () => screen.getByRole("checkbox", { name: "使用图形会话" });
    expect(screen.getByText(/Codex App Server/)).toBeTruthy();
    fireEvent.click(mode());
    fireEvent.click(screen.getByRole("button", { name: "CodeBuddy" }));
    expect(mode()).toHaveProperty("checked", false);
    expect(screen.getByText(/ACP/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
    expect(mode()).toHaveProperty("checked", false);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(mode()).toHaveProperty("checked", false);
    fireEvent.click(mode());
    fireEvent.click(screen.getByRole("button", { name: "CodeBuddy" }));
    expect(mode()).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
    expect(mode()).toHaveProperty("checked", true);
  });
  it("submits the terminal choice for a WSL CodeBuddy session", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><CreateSessionModal defaultWindowsShell="cmd" wslDistros={["Ubuntu"]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Ubuntu" }));
    fireEvent.click(screen.getByRole("button", { name: "CodeBuddy" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "使用图形会话" }));
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/home/user/work" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      selectedShellId: "wsl:Ubuntu", graphicalSessionEnabled: false
    })));
  });
  it("uses an accessible dialog and keeps optional groups collapsed", () => {
    render(
      <I18nProvider locale="zh-CN">
        <CreateSessionModal defaultWindowsShell="pwsh" wslDistros={[]} tagSuggestions={[]} onCreate={vi.fn()} onCancel={() => undefined} />
      </I18nProvider>
    );

    expect(screen.getByRole("dialog", { name: "新建会话" })).toBeTruthy();
    expect(screen.getByText("配置终端、工作目录与 Agent")).toBeTruthy();
    expect(screen.getByLabelText("会话名称")).toBeTruthy();
    expect(screen.getByText("启动命令").closest("details")?.open).toBe(false);
    expect(screen.getByText("环境变量", { selector: "summary span" }).closest("details")?.open).toBe(false);
  });
});

describe("CreateSessionModal local SSH bridge", () => {
  it("selects and submits an optional local Agent working directory", async () => {
    const onCreate = vi.fn(async () => undefined);
    Object.defineProperty(window, "hookConfigApi", {
      configurable: true,
      value: {
        selectProjectDirectory: vi.fn(async () => ({ canceled: false as const, path: "C:\\local agent" }))
      }
    });

    render(
      <I18nProvider locale="zh-CN">
        <CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("本机 Agent 工作目录（可选）")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "使用图形会话" })).toHaveProperty("checked", true);

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    await vi.waitFor(() => expect(screen.getByDisplayValue("C:\\local agent")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "example.com" } });
    fireEvent.change(screen.getByLabelText("远端工作目录"), { target: { value: "/srv/app" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      selectedShellId: "ssh",
      cwd: "/srv/app",
      agentProvider: "codex",
      agentLocation: "local",
      localAgentCwd: "C:\\local agent",
      graphicalSessionEnabled: true
    })));
  });

  it("offers App Server by default when Codex runs remotely", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(
      <I18nProvider locale="zh-CN">
        <CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "远端运行" }));

    expect(screen.queryByText("本机 Agent 工作目录（可选）")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "使用图形会话" })).toHaveProperty("checked", true);
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "example.com" } });
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/srv/app" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      agentLocation: "remote", graphicalSessionEnabled: true
    })));
  });

  it("defaults SSH OpenCode sessions to the local bridge and submits the local directory", async () => {
    const onCreate = vi.fn(async () => undefined);
    Object.defineProperty(window, "hookConfigApi", {
      configurable: true,
      value: {
        selectProjectDirectory: vi.fn(async () => ({ canceled: false as const, path: "C:\\open-code-local" }))
      }
    });
    render(
      <I18nProvider locale="zh-CN">
        <CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
    expect(screen.getByRole("button", { name: "本地桥接" }).className).toContain("selected");
    expect(screen.getByText("本机 Agent 工作目录（可选）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    await vi.waitFor(() => expect(screen.getByDisplayValue("C:\\open-code-local")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "example.com" } });
    fireEvent.change(screen.getByLabelText("远端工作目录"), { target: { value: "/srv/app" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      selectedShellId: "ssh",
      agentProvider: "opencode",
      agentLocation: "local",
      localAgentCwd: "C:\\open-code-local"
    })));
  });

  it("defaults SSH CodeBuddy sessions to the local bridge", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(
      <I18nProvider locale="zh-CN">
        <CreateSessionModal defaultWindowsShell="cmd" wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "CodeBuddy" }));
    expect(screen.getByRole("button", { name: "本地桥接" }).className).toContain("selected");
    expect(screen.getByText("本机 Agent 工作目录（可选）")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "example.com" } });
    fireEvent.change(screen.getByLabelText("远端工作目录"), { target: { value: "/srv/app" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      selectedShellId: "ssh",
      agentProvider: "codebuddy",
      agentLocation: "local",
      graphicalSessionEnabled: true
    })));
  });

});


describe("Windows shell selection", () => {
  it.each([
    ["cmd", "CMD", /set "HTTP_PROXY=/],
    ["powershell", "PowerShell 5.1", /\$env:HTTP_PROXY/],
    ["pwsh", "PowerShell 7", /\$env:HTTP_PROXY/]
  ] as const)("only offers the configured Windows default %s", async (shell, label, commandExample) => {
    const onCreate = vi.fn(async () => undefined);
    render(<I18nProvider locale="zh-CN"><CreateSessionModal defaultWindowsShell={shell} wslDistros={["Ubuntu"]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} /></I18nProvider>);
    const defaultButton = screen.getByRole("button", { name: `默认（${label}）` });
    expect(defaultButton.className).toContain("selected");
    for (const name of ["CMD", "PowerShell 5.1", "PowerShell 7"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByPlaceholderText(commandExample)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    expect(screen.getByLabelText("主机")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ubuntu" }));
    expect(screen.getByPlaceholderText("/home/user/project")).toBeTruthy();
    fireEvent.click(defaultButton);
    expect(screen.getByPlaceholderText(commandExample)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ selectedShellId: "default" })));
  });
});
