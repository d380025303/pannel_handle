import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createListenerAgentStore, normalizeListenerAgent, normalizeTrigger, renderPrompt, truncateOutput } = require("./listener-agent-store.cjs");
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function agentInput() {
  return { name: "Review", provider: "codex", triggers: [{ name: "Files", type: "file", prompt: "Review {{changedFiles}}" }] };
}

describe("listener Agent store", () => {
  it("normalizes safe defaults and rejects unknown variables", () => {
    const agent = normalizeListenerAgent(agentInput());
    expect(agent).toMatchObject({ permission: "read-only", timeoutMinutes: 30, ignoreOwnChanges: true });
    expect(agent.triggers[0]).toMatchObject({ include: ["**/*"], events: ["add", "change", "unlink"], debounceMs: 1000 });
    expect(() => normalizeTrigger({ type: "file", prompt: "{{secret}}" })).toThrow(/secret/);
  });

  it("validates interval and five-field cron triggers", () => {
    expect(normalizeTrigger({ type: "interval", prompt: "ok", intervalMinutes: 5 }).intervalMinutes).toBe(5);
    expect(normalizeTrigger({ type: "cron", prompt: "ok", cron: "0 * * * *" }).cron).toBe("0 * * * *");
    expect(() => normalizeTrigger({ type: "cron", prompt: "ok", cron: "* * *" })).toThrow(/5/);
  });

  it("renders trigger metadata and truncates UTF-8 output", () => {
    const agent = normalizeListenerAgent(agentInput());
    const prompt = renderPrompt({ prompt: agent.triggers[0].prompt, cwd: "C:\\work", agent, trigger: agent.triggers[0], changedFiles: ["a.ts"] });
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("C:\\work");
    expect(truncateOutput("abcdef", 3)).toEqual({ value: "abc", truncated: true });
  });

  it("keeps only the newest history entries and removes a template", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listener-history-")); dirs.push(dir);
    const store = createListenerAgentStore({ historyFile: path.join(dir, "history.json"), maxEntries: 2 });
    store.load();
    store.append("1", "a", { id: "1", stdout: "one" });
    store.append("1", "a", { id: "2", stdout: "two" });
    store.append("1", "a", { id: "3", stdout: "three" });
    expect(store.list("1", "a").map(item => item.id)).toEqual(["3", "2"]);
    store.removeTemplate("1");
    expect(store.list("1", "a")).toEqual([]);
  });

  it("passes through cliTemplateId and skips provider validation", () => {
    const agent = normalizeListenerAgent({
      name: "Template Ref", provider: "", cliTemplateId: "tpl-1",
      triggers: [{ name: "T", type: "file", prompt: "Review {{changedFiles}}" }]
    });
    expect(agent.cliTemplateId).toBe("tpl-1");
    expect(agent.provider).toBe("codex");
  });

  it("still validates provider when cliTemplateId is not set", () => {
    expect(() => normalizeListenerAgent({
      name: "Bad", provider: "",
      triggers: [{ name: "T", type: "file", prompt: "Review {{changedFiles}}" }]
    })).toThrow(/有效的 Agent CLI/);
  });
});
