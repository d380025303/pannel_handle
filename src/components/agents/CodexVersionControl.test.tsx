// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexVersionControl } from "./CodexVersionControl";

afterEach(cleanup);

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
