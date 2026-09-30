// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerSnapshot } from "../vite-env";
import { useCodexAppServerFooter } from "./useCodexAppServerFooter";

afterEach(cleanup);

it("shows App Server token updates and isolates the next session", async () => {
  let changed: (payload: { id: string; snapshot: CodexAppServerSnapshot }) => void = () => {};
  const base = { threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
    items: [], approvals: [] } satisfies CodexAppServerSnapshot;
  Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: {
    snapshot: vi.fn().mockResolvedValue(base),
    onChanged: (callback: typeof changed) => { changed = callback; return () => {}; }
  } });
  const { result, rerender } = renderHook(({ id }) => useCodexAppServerFooter(id), { initialProps: { id: "run-1" } });
  await waitFor(() => expect(result.current.canSubmit).toBe(true));
  expect(result.current.tokenState.status).toBe("waiting");
  act(() => changed({ id: "run-1", snapshot: { ...base, busy: true, model: "test-model", tokenUpdatedAt: 1234,
    tokenUsage: { total: { inputTokens: 30, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 10,
      reasoningOutputTokens: 2, totalTokens: 40 }, last: { inputTokens: 30, cachedInputTokens: 5,
      cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 40 }, modelContextWindow: null },
    turnOutputTokens: 10, outputTokensPerSecond: 0, outputRateAvailable: false } }));
  expect(result.current.canSubmit).toBe(false);
  expect(result.current.tokenState).toMatchObject({ status: "ready", snapshot: {
    state: "generating", tokens: { inputTokens: 30, outputTokens: 10 }, outputRateAvailable: false,
    models: ["test-model"] } });
  rerender({ id: "run-2" });
  await waitFor(() => expect(result.current.tokenState.status).toBe("waiting"));
});

it("exposes ACP context usage for CodeBuddy and OpenCode only in the active graphical session", async () => {
  let changed: (payload: { id: string; snapshot: CodexAppServerSnapshot }) => void = () => {};
  const base = { threadId: "buddy-thread", provider: "codebuddy" as const, mode: "default" as const,
    executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
  Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: {
    snapshot: vi.fn().mockResolvedValue(base), onChanged: (callback: typeof changed) => { changed = callback; return () => {}; }
  } });
  const { result, rerender } = renderHook(({ id }) => useCodexAppServerFooter(id), { initialProps: { id: "run-1" } });
  await waitFor(() => expect(result.current.contextUsage).toBeNull());
  const contextUsage = { used: 250, size: 1000, categories: { tools: 50 }, updatedAt: 1234 };
  act(() => changed({ id: "run-1", snapshot: { ...base, contextUsage } }));
  expect(result.current.contextUsage).toEqual(contextUsage);
  act(() => changed({ id: "run-1", snapshot: { ...base, provider: "opencode", contextUsage } }));
  expect(result.current.contextUsage).toEqual(contextUsage);
  rerender({ id: "run-2" });
  expect(result.current.contextUsage).toBeUndefined();
});
