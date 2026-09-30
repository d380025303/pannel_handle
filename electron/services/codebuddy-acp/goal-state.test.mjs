import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { emptyGoalState, applyGoalUpdate } = require("./goal-state.cjs");

describe("CodeBuddy goal state", () => {
  it("reads recap, progress, and the final result without treating missing values as usage", () => {
    const state = emptyGoalState();
    expect(applyGoalUpdate(state, { "codebuddy.ai/goalRecap": { at: 10, active: {
      condition: "测试通过", durationMs: 12500, turnCount: 2, tokenDelta: 300, reason: "还需检查构建" } } })).toBe(true);
    expect(state.active).toMatchObject({ condition: "测试通过", durationMs: 12500, turnCount: 2,
      tokenDelta: 300, reason: "还需检查构建" });
    expect(applyGoalUpdate(state, { "codebuddy.ai/goalProgress": {
      condition: "测试通过", reason: "构建仍失败", turnCount: 3 } })).toBe(true);
    expect(state.active).toMatchObject({ turnCount: 3, reason: "构建仍失败" });
    expect(applyGoalUpdate(state, { "codebuddy.ai/goalResult": {
      condition: "测试通过", ok: false, reason: "依赖缺失", durationMs: 25000, turnCount: 3, tokenDelta: 600 } })).toBe(true);
    expect(state.active).toBeNull();
    expect(state.latest).toMatchObject({ ok: false, reason: "依赖缺失", tokenDelta: 600 });
  });

  it("ignores unknown metadata and clears an old goal on an empty recap", () => {
    const state = emptyGoalState();
    expect(applyGoalUpdate(state, { "codebuddy.ai/teamUpdate": { type: "team_created" } })).toBe(false);
    applyGoalUpdate(state, { "codebuddy.ai/goalRecap": { active: { condition: "旧目标" } } });
    applyGoalUpdate(state, { "codebuddy.ai/goalRecap": { at: 12 } });
    expect(state).toMatchObject({ available: true, active: null, latest: null });
  });
});
