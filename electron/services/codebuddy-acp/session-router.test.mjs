import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createGraphicalSessionRouter } = require("./session-router.cjs");

it("forwards Codex task turn events unchanged and preserves unsubscribe", () => {
  const listeners = new Set();
  const codex = { onTaskTurnEnded(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  } };
  const router = createGraphicalSessionRouter(codex, {}, { getSession: () => undefined });
  const listener = vi.fn();
  const unsubscribe = router.onTaskTurnEnded(listener);
  const event = { sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output: "最终回复", error: "" };
  for (const notify of listeners) notify(event);
  expect(listener).toHaveBeenCalledExactlyOnceWith(event);
  expect(listener.mock.calls[0][0]).toBe(event);
  unsubscribe();
  for (const notify of listeners) notify(event);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});
