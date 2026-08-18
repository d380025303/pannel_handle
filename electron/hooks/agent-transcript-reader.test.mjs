import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readAgentTranscriptItems } = require("./agent-transcript-reader.cjs");
const tempDirs = [];

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-transcript-"));
  tempDirs.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n"), "utf-8");
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent-transcript-reader", () => {
  it("extracts human-visible Codex commentary and final messages only", () => {
    const file = writeTranscript([
      { type: "response_item", payload: { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "private prompt" }] } },
      { type: "response_item", payload: { type: "message", id: "plan-1", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "## Plan\n\nInspect first." }] } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "tool-1", name: "exec" } },
      { type: "response_item", payload: { type: "message", id: "final-1", role: "assistant", phase: "final", content: [{ type: "output_text", text: "Done." }] } }
    ]);

    expect(readAgentTranscriptItems("codex", file)).toEqual([
      { id: "plan-1", phase: "commentary", content: "## Plan\n\nInspect first." },
      { id: "final-1", phase: "final", content: "Done." }
    ]);
  });

  it("extracts Claude assistant text using the caller phase", () => {
    const file = writeTranscript([
      { type: "assistant", uuid: "message-1", message: { role: "assistant", content: [{ type: "text", text: "Working note" }] } }
    ]);

    expect(readAgentTranscriptItems("claude", file, { defaultPhase: "final" })).toEqual([
      { id: "message-1", phase: "final", content: "Working note" }
    ]);
  });

  it("returns no items for missing or non-jsonl paths", () => {
    expect(readAgentTranscriptItems("codex", "C:\\missing.txt")).toEqual([]);
    expect(readAgentTranscriptItems("codex", "C:\\missing.jsonl")).toEqual([]);
  });
});
