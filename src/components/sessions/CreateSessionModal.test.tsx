// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CreateSessionModal } from "./CreateSessionModal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
        <CreateSessionModal wslDistros={[]} tagSuggestions={[]} onCreate={onCreate} onCancel={() => undefined} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("本机 Agent 工作目录（可选）")).toBeTruthy();

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
      localAgentCwd: "C:\\local agent"
    })));
  });

  it("hides and omits the local directory when Codex runs remotely", () => {
    render(
      <I18nProvider locale="zh-CN">
        <CreateSessionModal wslDistros={[]} tagSuggestions={[]} onCreate={vi.fn()} onCancel={() => undefined} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "远端运行" }));

    expect(screen.queryByText("本机 Agent 工作目录（可选）")).toBeNull();
  });

  it("offers Qwen Code locally but not for SSH sessions", () => {
    render(
      <I18nProvider locale="zh-CN">
        <CreateSessionModal wslDistros={["Ubuntu"]} tagSuggestions={[]} onCreate={vi.fn()} onCancel={() => undefined} />
      </I18nProvider>
    );
    expect(screen.getByRole("button", { name: "Qwen Code" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    expect(screen.queryByRole("button", { name: "Qwen Code" })).toBeNull();
  });
});
