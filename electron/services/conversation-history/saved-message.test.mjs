import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
const { savedMessage } = createRequire(import.meta.url)("./saved-message.cjs");
describe("persistent conversation policy", () => {
  it("keeps user and final or unclassified replies, stripping protocol data", () => {
    for (const kind of ["user", "final", "reply", "summary"]) {
      expect(savedMessage({ id: "m", kind, text: "hello", timestamp: 1, raw: "secret",
        item: { type: kind === "user" ? "userMessage" : kind === "summary" ? "contextCompaction" : "agentMessage", output: "secret" } }))
        .toEqual({ id: "m", provider: undefined, kind, text: "hello", timestamp: 1 });
    }
  });
  it("rejects progress, tools, thoughts, events and disguised tool messages", () => {
    for (const kind of ["commentary", "reasoning", "tool", "event", undefined])
      expect(savedMessage({ id: "m", kind, text: "secret" })).toBeNull();
    expect(savedMessage({ id: "m", kind: "reply", text: "progress", phase: "commentary" })).toBeNull();
    expect(savedMessage({ id: "m", kind: "user", text: "output", itemType: "commandExecution" })).toBeNull();
    expect(savedMessage({ id: "m", kind: "summary", text: "output", itemType: "commandExecution" })).toBeNull();
    expect(savedMessage({ id: "m", kind: "summary", text: "  " })).toBeNull();
  });
});
