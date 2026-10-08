// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionCard } from "./GraphicalInteractionCards";
import type { CodexQuestionRequest } from "../../vite-env";

afterEach(cleanup);
const request = (multiple = false): CodexQuestionRequest => ({ requestId: 42, submitting: false,
  params: { threadId: "thread", turnId: "turn", questions: [{ id: "pm", header: "工具", question: "选择工具",
    required: true, multiSelect: multiple, isOther: true, options: [{ label: "pnpm", description: "" }, { label: "npm", description: "" }] }] } });

it.each([false, true])("submits OpenCode custom answers distinctly from choices (multiple=%s)", async multiple => {
  const answerQuestion = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, { codexAppServerApi: { answerQuestion } });
  render(<QuestionCard sessionId="one" provider="opencode" request={request(multiple)} />);
  fireEvent.click(screen.getByRole(multiple ? "checkbox" : "radio", { name: "pnpm" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "npm" } });
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("one", 42, {
    pm: { answers: multiple ? ["pnpm", "npm"] : ["npm"], customAnswer: "npm" } }));
});

it("validates required questions, permits optional blanks, and cancels native questions", async () => {
  const answerQuestion = vi.fn().mockResolvedValue(undefined);
  const cancelQuestion = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, { codexAppServerApi: { answerQuestion, cancelQuestion } });
  const value = request();
  value.params.questions.push({ id: "note", header: "备注", question: "备注", required: false, isOther: true });
  render(<QuestionCard sessionId="one" provider="opencode" request={value} />);
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(screen.getByRole("alert").textContent).toContain("请回答");
  expect(answerQuestion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "pnpm" }));
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("one", 42, { pm: { answers: ["pnpm"] }, note: { answers: [] } }));
  await waitFor(() => expect((screen.getByRole("button", { name: "取消提问" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "取消提问" }));
  await waitFor(() => expect(cancelQuestion).toHaveBeenCalledWith("one", 42));
});

it("disables fields and prevents repeated answers while submitting", () => {
  const answerQuestion = vi.fn(() => new Promise(() => {}));
  Object.assign(window, { codexAppServerApi: { answerQuestion } });
  render(<QuestionCard sessionId="one" provider="opencode" request={request()} />);
  fireEvent.click(screen.getByRole("radio", { name: "pnpm" }));
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByRole("radio", { name: "pnpm" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "正在提交…" }));
  expect(answerQuestion).toHaveBeenCalledTimes(1);
});
