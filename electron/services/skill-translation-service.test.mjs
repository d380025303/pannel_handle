import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildInvocation, createSkillTranslationService, findTranslatedContent } = require("./skill-translation-service.cjs");

describe("Skill translation service", () => {
  it("builds provider-specific non-interactive invocations", () => {
    const codex = buildInvocation("codex", "C:\\temp\\translation");
    expect(codex.command).toBe("codex");
    expect(codex.args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--output-schema", "-"]));

    const codebuddy = buildInvocation("codebuddy", "C:\\temp\\translation");
    expect(codebuddy.command).toBe("codebuddy");
    expect(codebuddy.args).toEqual(expect.arrayContaining(["--print", "--output-format=json", "--tools=", "--permission-mode=dontAsk", "--no-session-persistence"]));
  });

  it("parses structured results and caches by provider, Skill, and source content", async () => {
    const runner = vi.fn(async ({ provider, prompt }) => JSON.stringify({ translatedContent: `${provider}:${prompt.includes("Instructions") ? "中文" : ""}` }));
    const service = createSkillTranslationService({ workspaceDirectory: "C:\\data", runner });

    const first = await service.translate({ requestId: "one", provider: "codex", skillId: "skill", content: "Instructions" });
    const second = await service.translate({ requestId: "two", provider: "codex", skillId: "skill", content: "Instructions" });

    expect(first).toMatchObject({ status: "translated", translatedContent: "codex:中文", cached: false });
    expect(second).toMatchObject({ status: "translated", translatedContent: "codex:中文", cached: true });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("cancels an active provider request", async () => {
    const runner = vi.fn(({ registerCancel }) => new Promise((_resolve, reject) => {
      registerCancel(() => reject(Object.assign(new Error("canceled"), { reason: "cancelled" })));
    }));
    const service = createSkillTranslationService({ workspaceDirectory: "C:\\data", runner });

    const pending = service.translate({ requestId: "cancel-me", provider: "codebuddy", skillId: "skill", content: "Instructions" });
    expect(service.cancel("cancel-me")).toBe(true);
    await expect(pending).resolves.toEqual({ status: "error", reason: "cancelled" });
  });

  it("rejects oversized input without starting a provider", async () => {
    const runner = vi.fn();
    const service = createSkillTranslationService({ workspaceDirectory: "C:\\data", runner });
    const result = await service.translate({ requestId: "large", provider: "codex", skillId: "skill", content: "x".repeat(513 * 1024) });
    expect(result).toEqual({ status: "error", reason: "too_large" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts nested provider JSON envelopes", () => {
    expect(findTranslatedContent({ result: JSON.stringify({ translatedContent: "译文" }) })).toBe("译文");
    expect(findTranslatedContent([{ type: "message" }, { type: "result", result: "完整译文" }])).toBe("完整译文");
  });
});
