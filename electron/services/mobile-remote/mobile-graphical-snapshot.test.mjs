import { createRequire } from "node:module";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { toMobileGraphicalSnapshot } = require("./mobile-graphical-snapshot.cjs");
it("preserves new activities and multiple collaboration targets in root and child snapshots", () => {
  const items = [{ id: "activity", type: "subAgentActivity", agentThreadId: "child", agentPath: "/root/child", kind: "started" },
    { id: "wait", type: "collabAgentToolCall", receiverThreadIds: ["a", "b"], agentsStates: { a: { status: "completed", message: "done" } }, newThreadId: "a" }];
  const value = toMobileGraphicalSnapshot({ items, subAgents: { members: [{ threadId: "child", items }] } });
  for (const projected of [value.items, value.subAgents.members[0].items]) {
    expect(projected[0]).toMatchObject(items[0]);
    expect(projected[1]).toMatchObject(items[1]);
  }
});
it("passes model image capabilities to the phone without guessing missing fields", () => {
  const value = toMobileGraphicalSnapshot({ models: [{ id: "text", inputModalities: ["text"] }, { id: "old" }] });
  expect(value.models[0].inputModalities).toEqual(["text"]);
  expect(value.models[1].inputModalities).toBeUndefined();
});

it("projects OpenCode exported token totals and ACP context usage separately", () => {
  const tokens = { inputTokens: 80, cachedInputTokens: 10, cacheWriteInputTokens: 0,
    outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 100 };
  const tokenUsage = { total: tokens, last: { ...tokens, totalTokens: 0 }, modelContextWindow: null };
  const value = toMobileGraphicalSnapshot({ provider: "opencode", tokenUsage, outputRateAvailable: false,
    contextUsage: { used: 50, size: 1000, categories: { tools: 25 }, updatedAt: 1234 } });
  expect(value.tokenUsage).toEqual(tokenUsage);
  expect(value.contextUsage).toEqual({ used: 50, size: 1000 });
  expect(value.outputRateAvailable).toBe(false);
});
