// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexVersionControl } from "./CodexVersionControl";
import type { CodexVersionState } from "../../vite-env";

afterEach(cleanup);

function deferredCheck() {
  let resolve!: (value: CodexVersionState) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CodexVersionState>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(["codex", "codebuddy", "opencode"] as const)("shows only spinners in version values while checking for %s", async provider => {
  const initial = deferredCheck();
  const refresh = deferredCheck();
  const check = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise);
  const api = { check, update: vi.fn() };
  const { container } = render(<CodexVersionControl sessionId="one" provider={provider} api={api} />);
  expect(screen.getByText("当前版本：")).toBeTruthy();
  expect(screen.getByText("最新版本：")).toBeTruthy();
  expect(container.querySelectorAll('.codex-version-row[aria-busy="true"]')).toHaveLength(2);
  expect(container.querySelectorAll(".codex-version-spinner")).toHaveLength(2);
  await act(async () => initial.resolve({ status: "available", currentVersion: "2.0.0", latestVersion: "2.1.0", method: "npm", environment: "windows" }));
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  expect(check).toHaveBeenLastCalledWith("one", true);
  expect(screen.queryByText("2.0.0")).toBeNull();
  expect(screen.queryByText("2.1.0")).toBeNull();
  expect(screen.queryByText("正在检测版本…")).toBeNull();
  expect(container.querySelectorAll(".codex-version-spinner")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "检查更新" }).textContent).toBe("");
  expect(screen.getByRole("button", { name: "检查更新" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: /^更新 / }).hasAttribute("disabled")).toBe(true);
  await act(async () => refresh.resolve({ status: "current", currentVersion: "2.1.0", latestVersion: "2.1.0", environment: "windows" }));
  expect(screen.getAllByText("2.1.0")).toHaveLength(2);
  expect(container.querySelectorAll(".codex-version-spinner")).toHaveLength(0);
});

it.each(["codex", "codebuddy", "opencode"] as const)("stops both indicators after a failed check for %s", async provider => {
  const pending = deferredCheck();
  const api = { check: vi.fn(() => pending.promise), update: vi.fn() };
  const { container } = render(<CodexVersionControl sessionId="one" provider={provider} api={api} />);
  await act(async () => pending.reject(new Error("查询失败")));
  expect(screen.getByRole("alert").textContent).toBe("查询失败");
  expect(screen.getAllByText("不可用")).toHaveLength(2);
  expect(container.querySelectorAll(".codex-version-spinner")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "检查更新" }).hasAttribute("disabled")).toBe(false);
});

it("ignores a manual check result after switching sessions", async () => {
  const previous = deferredCheck();
  const next = deferredCheck();
  const api = { check: vi.fn().mockResolvedValueOnce({ status: "current", currentVersion: "1.0.0", latestVersion: "1.0.0" })
    .mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise), update: vi.fn() };
  const { rerender, container } = render(<CodexVersionControl sessionId="one" api={api} />);
  await screen.findAllByText("1.0.0");
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  rerender(<CodexVersionControl sessionId="two" api={api} />);
  await act(async () => previous.resolve({ status: "current", currentVersion: "1.1.0", latestVersion: "1.1.0", environment: "windows" }));
  expect(screen.queryByText("1.1.0")).toBeNull();
  expect(container.querySelectorAll(".codex-version-spinner")).toHaveLength(2);
  await act(async () => next.resolve({ status: "current", currentVersion: "2.0.0", latestVersion: "2.0.0", environment: "wsl:Ubuntu" }));
  expect(screen.getAllByText("2.0.0")).toHaveLength(2);
  expect(container.querySelectorAll(".codex-version-spinner")).toHaveLength(0);
});

it("restores an in-progress update after changing sessions and follows its result", async () => {
  let first = true;
  const check = vi.fn(async (id: string) => id === "other"
    ? { status: "current", currentVersion: "1.0.0", environment: "wsl:Other" }
    : first
      ? { status: "updating", currentVersion: "1.0.0", environment: "windows", progress: { stage: "installing", output: "added 1 package" } }
      : { status: "current", currentVersion: "1.1.0", environment: "windows", restartRequired: true,
        progress: { stage: "verifying", output: "added 1 package" } });
  Object.defineProperty(window, "codexVersionApi", { configurable: true, value: { check, update: vi.fn() } });
  const { rerender } = render(<CodexVersionControl sessionId="one" />);
  expect((await screen.findByRole("status")).textContent).toContain("正在更新 Codex");
  expect(screen.getByLabelText("安装输出").textContent).toContain("added 1 package");
  rerender(<CodexVersionControl sessionId="other" />);
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  rerender(<CodexVersionControl sessionId="one" />);
  expect((await screen.findByRole("status")).textContent).toContain("正在更新 Codex");
  first = false;
  expect(await screen.findByText("更新已安装，手动重启会话后生效", {}, { timeout: 2500 })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("keeps a failed CodeBuddy update visible after returning and allows a new check", async () => {
  const check = vi.fn().mockResolvedValue({ status: "error", environment: "windows", error: "安装失败",
    progress: { stage: "installing", output: "npm error" } });
  Object.defineProperty(window, "codeBuddyVersionApi", { configurable: true, value: { check, update: vi.fn() } });
  render(<CodexVersionControl sessionId="one" provider="codebuddy" />);
  expect((await screen.findByRole("alert")).textContent).toContain("安装失败");
  expect(screen.getByLabelText("安装输出").textContent).toContain("npm error");
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  await waitFor(() => expect(check).toHaveBeenCalledWith("one", true));
});

it.each(["codex", "codebuddy", "opencode"] as const)("hides versions during a confirmed update for %s", async provider => {
  const pending = deferredCheck();
  const api = { check: vi.fn().mockResolvedValue({ status: "available", currentVersion: "3.0.0", latestVersion: "3.1.0", method: "npm", environment: "windows" }), update: vi.fn(() => pending.promise) };
  const { container } = render(<CodexVersionControl sessionId="one" provider={provider} api={api} />);
  await screen.findByText("3.0.0");
  const button = screen.getByRole("button", { name: /^更新 / });
  expect(button.textContent).toBe("");
  expect(button.getAttribute("title")).toBe(button.getAttribute("aria-label"));
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
  expect(api.update).toHaveBeenCalledWith("one");
  expect(screen.queryByText("3.0.0")).toBeNull();
  expect(screen.queryByText("3.1.0")).toBeNull();
  expect(container.querySelectorAll('.codex-version-row[aria-busy="true"]')).toHaveLength(2);
  expect(container.querySelectorAll(".codex-version-spinner")).toHaveLength(2);
  await act(async () => pending.resolve({ status: "current", currentVersion: "3.1.0", latestVersion: "3.1.0", environment: "windows", restartRequired: true }));
  expect(screen.getAllByText("3.1.0")).toHaveLength(2);
  expect(container.querySelectorAll(".codex-version-spinner")).toHaveLength(0);
});
