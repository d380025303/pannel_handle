import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const {
  DEFAULT_TIMEOUT_MS,
  buildInvocation,
  createSkillTranslationService,
  findTranslatedContent,
  runCli,
  terminateProcess
} = require("./skill-translation-service.cjs");

describe("Skill translation service", () => {
  it("allows enough time for complete Skill documents", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(300 * 1000);
  });

  it("builds provider-specific non-interactive invocations", () => {
    const codex = buildInvocation("codex", "C:\\temp\\translation");
    expect(codex.command).toBe("codex");
    expect(codex.args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "--disable", "plugins", "--sandbox", "read-only", "--output-schema", "-"]));

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

  it("returns a completed Codex output without waiting for the CLI process to close", async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const terminate = vi.fn();
    const spawn = vi.fn((_command, args) => {
      const outputFile = args[args.indexOf("--output-last-message") + 1];
      setTimeout(() => fs.writeFileSync(outputFile, JSON.stringify({ translatedContent: "译文" })), 10);
      return child;
    });

    await expect(runCli({
      provider: "codex",
      prompt: "Translate this.",
      workspaceDirectory: "C:\\data",
      timeoutMs: 1000,
      spawn,
      terminate
    })).resolves.toBe(JSON.stringify({ translatedContent: "译文" }));
    expect(terminate).toHaveBeenCalledWith(child);
  });

  it("returns structured stdout even when the Codex process would later exit non-zero", async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const terminate = vi.fn();
    const spawn = vi.fn(() => {
      setTimeout(() => child.stdout.write(JSON.stringify({ translatedContent: "标准输出译文" })), 10);
      setTimeout(() => child.emit("close", 1), 50);
      return child;
    });

    await expect(runCli({
      provider: "codex",
      prompt: "Translate this.",
      workspaceDirectory: "C:\\data",
      timeoutMs: 1000,
      spawn,
      terminate
    })).resolves.toBe(JSON.stringify({ translatedContent: "标准输出译文" }));
    expect(terminate).toHaveBeenCalledWith(child);
  });

  it("does not treat an intermediate provider message as the translated document", async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const spawn = vi.fn(() => {
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "message", message: "Working" })}\n`), 5);
      setTimeout(() => child.stdout.write(JSON.stringify({ type: "result", result: "完整译文" })), 15);
      return child;
    });

    await expect(runCli({
      provider: "codebuddy",
      prompt: "Translate this.",
      workspaceDirectory: "C:\\data",
      timeoutMs: 1000,
      spawn,
      terminate: vi.fn()
    })).resolves.toBe(JSON.stringify({ type: "result", result: "完整译文" }));
  });

  it("bounds Windows process-tree termination and falls back to the direct child", async () => {
    vi.useFakeTimers();
    try {
      const killer = new EventEmitter();
      killer.kill = vi.fn();
      const child = { pid: 1234, kill: vi.fn() };
      const spawn = vi.fn(() => killer);

      const pending = terminateProcess(child, spawn, "win32");
      await vi.advanceTimersByTimeAsync(3000);
      await pending;

      expect(spawn).toHaveBeenCalledWith("taskkill.exe", ["/pid", "1234", "/t", "/f"], expect.objectContaining({ windowsHide: true }));
      expect(killer.kill).toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
