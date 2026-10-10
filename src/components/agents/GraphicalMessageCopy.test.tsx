// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalMessageCopy, graphicalMessageText } from "./GraphicalMessageCopy";
import { TeamMemberTimeline } from "./GraphicalTimeline";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function clipboard() {
  const writeText = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, "clipboardApi", { configurable: true, value: { writeText } });
  return writeText;
}

it("copies original Markdown and the latest streamed text", async () => {
  const writeText = clipboard();
  const view = render(<GraphicalMessageCopy text={"**hello**\n```ts\nconst a = 1;\n```"} />);
  fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy());
  expect(writeText).toHaveBeenLastCalledWith("**hello**\n```ts\nconst a = 1;\n```");
  view.rerender(<GraphicalMessageCopy text="updated reply" />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("updated reply"));
});

it("reports rejection and supports retry", async () => {
  const writeText = clipboard();
  writeText.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(false);
  render(<GraphicalMessageCopy text="message" />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("button", { name: "复制失败，请重试" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy());
});

it("copies user text parts without attachment paths and hides empty controls", () => {
  expect(graphicalMessageText({ id: "u", type: "userMessage", text: "fallback", parts: [
    { type: "text", text: "first\n" }, { type: "image", path: "secret.png", name: "image" }, { type: "text", text: "second" }
  ] })).toBe("first\nsecond");
  expect(graphicalMessageText({ id: "u", type: "userMessage", text: "fallback" })).toBe("fallback");
  render(<GraphicalMessageCopy text={" \n"} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("shares desktop member copying while leaving mobile member controls unchanged", async () => {
  const writeText = clipboard();
  const member = { name: "member", status: "running", items: [{ id: "a", type: "agentMessage", text: "answer" }] };
  const view = render(<TeamMemberTimeline member={member} messageCopy />);
  fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("answer"));
  view.rerender(<TeamMemberTimeline member={member} />);
  expect(screen.queryByRole("button", { name: "复制消息" })).toBeNull();
});
