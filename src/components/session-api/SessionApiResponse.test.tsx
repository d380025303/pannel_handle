// @vitest-environment jsdom
import "./response-test-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { findResponseMatches, SessionApiResponse } from "./SessionApiResponse";

afterEach(cleanup);

it("searches literal field names, values, Chinese and Unicode without changing offsets", () => {
  const text = '{"Name":"NAME 中文 [a.*] 😀", "İ":"中文"}';
  expect(findResponseMatches(text, "name")).toHaveLength(2);
  expect(findResponseMatches(text, "中文")).toHaveLength(2);
  const special = findResponseMatches(text, "[a.*]")[0];
  expect(text.slice(special.from, special.to)).toBe("[a.*]");
  const unicode = findResponseMatches(text, "中文")[1];
  expect(text.slice(unicode.from, unicode.to)).toBe("中文");
  expect(findResponseMatches(text, "")).toEqual([]);
  expect(findResponseMatches(text, "missing")).toEqual([]);
});

it("highlights, cycles, clears and recomputes matches for new responses", async () => {
  const props = { visible: true, onCopy: vi.fn() };
  const { container, rerender } = render(<SessionApiResponse text={'{"name":"NAME"}'} {...props} />);
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "name" } });
  expect(screen.getByRole("status").textContent).toBe("1 / 2");
  expect(container.querySelectorAll(".session-api-match-current")).toHaveLength(1);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("status").textContent).toBe("2 / 2");
  fireEvent.click(screen.getByRole("button", { name: "下一处匹配" }));
  expect(screen.getByRole("status").textContent).toBe("1 / 2");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(screen.getByRole("status").textContent).toBe("2 / 2");
  rerender(<SessionApiResponse text={'{"name":1}'} {...props} />);
  expect((input as HTMLInputElement).value).toBe("name");
  expect(screen.getByRole("status").textContent).toBe("1 / 1");
  fireEvent.change(input, { target: { value: "none" } });
  expect(screen.getByRole("status").textContent).toBe("未找到匹配内容");
  fireEvent.keyDown(input, { key: "Escape" });
  expect((input as HTMLInputElement).value).toBe("");
  expect(container.querySelectorAll(".session-api-match-current")).toHaveLength(0);
  await waitFor(() => expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false"));
});

it("scopes Ctrl+F to the visible workspace and disables actions without a response", () => {
  const copy = vi.fn();
  const { rerender } = render(<main className="session-api-workspace"><SessionApiResponse text="{}" visible onCopy={copy} /></main>);
  const input = screen.getByRole("searchbox");
  const editor = screen.getByLabelText("响应结果");
  fireEvent.keyDown(editor, { key: "f", ctrlKey: true });
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole("button", { name: "复制响应" }));
  expect(copy).toHaveBeenCalledOnce();
  rerender(<main className="session-api-workspace"><SessionApiResponse text="{}" visible={false} onCopy={copy} /></main>);
  editor.focus();
  fireEvent.keyDown(editor, { key: "f", ctrlKey: true });
  expect(document.activeElement).toBe(editor);
  rerender(<main className="session-api-workspace"><SessionApiResponse text={null} visible onCopy={copy} /></main>);
  expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "复制响应" }) as HTMLButtonElement).disabled).toBe(true);
});
