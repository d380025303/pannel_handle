import { createRequire } from "node:module";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { toMobileGraphicalSnapshot } = require("./mobile-graphical-snapshot.cjs");
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
