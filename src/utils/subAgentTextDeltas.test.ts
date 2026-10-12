import { expect, it } from "vitest";
import type { CodexSubAgents } from "../vite-env";
import { applySubAgentTextDeltas } from "./subAgentTextDeltas";

it("applies ordered text, output and indexed reasoning deltas without mutating history", () => {
  const state: CodexSubAgents = { expanded: true, selectedThreadId: "a", loading: false, error: null, warning: null,
    members: [{ threadId: "a", parentThreadId: "root", name: "A", role: "", task: "", status: "running",
      createdAt: 0, loading: false, error: null, items: [{ id: "msg", type: "agentMessage", text: "old",
        output: "out", summary: ["first", "second"] }] }] };
  const next = applySubAgentTextDeltas(state, [
    { threadId: "a", itemId: "msg", field: "text", delta: "1" },
    { threadId: "a", itemId: "msg", field: "text", delta: "2" },
    { threadId: "a", itemId: "msg", field: "output", delta: "!" },
    { threadId: "a", itemId: "msg", field: "summary", summaryIndex: 1, delta: "!" },
    { threadId: "other", itemId: "msg", field: "text", delta: "wrong" }
  ]);
  expect(next?.members[0].items[0]).toMatchObject({ text: "old12", output: "out!", summary: ["first", "second!"] });
  expect(state.members[0].items[0]).toMatchObject({ text: "old", output: "out", summary: ["first", "second"] });
  const large = applySubAgentTextDeltas(state, [
    { threadId: "a", itemId: "msg", field: "output", delta: "x".repeat(65536) },
    { threadId: "a", itemId: "msg", field: "output", delta: "latest" }
  ]);
  expect(large?.members[0].items[0].output).toBe("x".repeat(15994) + "latest");
});
