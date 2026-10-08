import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalQuestionCard } from "./GraphicalQuestionCard";
import type { GraphicalQuestion } from "./types";

afterEach(cleanup);
const request = (multiple = false): GraphicalQuestion => ({ requestId: "q", submitting: false,
  params: { threadId: "thread", turnId: "turn", questions: [{ id: "pm", header: "工具", question: "选择工具",
    required: true, multiSelect: multiple, isOther: true, options: [{ label: "pnpm", description: "" }, { label: "npm", description: "" }] }] } });

it.each([false, true])("keeps OpenCode selections and custom text separate (multiple=%s)", multiple => {
  const onAnswer = vi.fn();
  render(<GraphicalQuestionCard provider="opencode" question={request(multiple)} onAnswer={onAnswer} onCancel={vi.fn()} />);
  if (multiple) fireEvent.click(screen.getByRole("checkbox", { name: "pnpm" }));
  else fireEvent.change(screen.getByRole("combobox"), { target: { value: "pnpm" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "npm" } });
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(onAnswer).toHaveBeenCalledWith("q", { pm: { answers: multiple ? ["pnpm", "npm"] : ["npm"], customAnswer: "npm" } });
});

it("requires answers, allows optional blanks and sends cancellation", () => {
  const onAnswer = vi.fn(); const onCancel = vi.fn();
  const question = request();
  question.params.questions.push({ id: "note", header: "备注", question: "备注", required: false, isOther: true });
  render(<GraphicalQuestionCard provider="opencode" question={question} onAnswer={onAnswer} onCancel={onCancel} />);
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(screen.getByRole("alert").textContent).toContain("请回答");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "pnpm" } });
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(onAnswer).toHaveBeenCalledWith("q", { pm: { answers: ["pnpm"] }, note: { answers: [] } });
  fireEvent.click(screen.getByRole("button", { name: "取消提问" }));
  expect(onCancel).toHaveBeenCalledWith("q");
});

it("disables all form controls while submitting", () => {
  const question = { ...request(true), submitting: true };
  const onAnswer = vi.fn();
  render(<GraphicalQuestionCard provider="opencode" question={question} onAnswer={onAnswer} onCancel={vi.fn()} />);
  for (const control of screen.getAllByRole("checkbox")) expect((control as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(onAnswer).not.toHaveBeenCalled();
});
