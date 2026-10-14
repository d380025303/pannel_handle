import { describe, expect, it, vi } from "vitest";
import openCodeModule from "./opencode-tracker.cjs";
import transcriptModule from "../agent-token-transcript.cjs";

const { createOpenCodeTrackerManager } = openCodeModule;
const { TOKEN_FIELDS, emptyTokens } = transcriptModule;

describe("OpenCode live token tracker", () => {
  it("matches full totals and model sets through inserts, repeats and corrections", () => {
    const manager = createOpenCodeTrackerManager({ now: () => 1000, emitSnapshot: vi.fn(), onUsage: vi.fn() });
    const session = { id: "panel" };
    const messages = new Map();
    const update = (id, modelID, value) => {
      const input = { session_id: "agent", event_name: "message.updated", info: {
        id, role: "assistant", modelID,
        tokens: { input: value, output: value * 2, reasoning: value * 3, cache: { read: value * 4, write: value * 5 } }
      } };
      messages.set(id, openCodeModule.normalizeOpenCodeMessage(input));
      manager.handleEvent(input, session);
      const totals = emptyTokens();
      for (const message of messages.values()) {
        for (const field of TOKEN_FIELDS) totals[field] += message.tokens[field];
      }
      const tracker = manager.get(session.id);
      expect(tracker.rawTokens).toEqual(totals);
      expect(new Set(tracker.models)).toEqual(new Set([...messages.values()].map(message => message.model).filter(Boolean)));
    };
    update("a", "shared", 10);
    update("b", "shared", 20);
    update("c", "other", 30);
    update("b", "shared", 20);
    update("a", "replacement", 2);
    update("b", "replacement", 5);
    update("c", "", 1);
    update("a", "shared", 7);
    update("zero", "zero-model", 0);
    update("zero", "", 0);

    manager.handleEvent({ session_id: "new-agent", event_name: "message.updated", info: {
      id: "a", role: "assistant", modelID: "fresh", tokens: { input: 1 }
    } }, session);
    expect(manager.get(session.id).rawTokens.totalTokens).toBe(1);
    expect(manager.get(session.id).models).toEqual(["fresh"]);
  });

  it("does not traverse message history when updating usage", () => {
    const manager = createOpenCodeTrackerManager({ now: () => 1000, emitSnapshot: () => {}, onUsage: () => {} });
    const session = { id: "panel" };
    const input = { session_id: "agent", event_name: "message.updated", info: {
      id: "first", role: "assistant", modelID: "model", tokens: { input: 1 }
    } };
    manager.handleEvent(input, session);
    const tracker = manager.get(session.id);
    tracker.messages.values = () => { throw new Error("History traversal"); };
    tracker.messages[Symbol.iterator] = tracker.messages.values;
    tracker.messages.forEach = tracker.messages.values;
    for (let index = 0; index < 1000; index += 1) {
      manager.handleEvent({ ...input, info: { ...input.info, id: String(index) } }, session);
    }
    manager.handleEvent({ ...input, info: { ...input.info, tokens: { input: 2 } } }, session);
    expect(tracker.rawTokens.totalTokens).toBe(1002);
    expect(tracker.models).toEqual(["model"]);
  });

  it("replaces message updates instead of double counting and ignores a trailing zero update", () => {
    let time = 1000;
    const emitSnapshot = vi.fn();
    const onUsage = vi.fn();
    const manager = createOpenCodeTrackerManager({ now: () => time, emitSnapshot, onUsage });
    const session = { id: "panel-open", type: "windows", title: "OpenCode", cwd: "C:\\repo" };

    manager.handleEvent({ session_id: "agent-open", event_name: "session.status", status: { type: "busy" } }, session);
    time = 2000;
    manager.handleEvent({
      session_id: "agent-open",
      event_name: "message.updated",
      info: { id: "message-1", role: "assistant", modelID: "model-a", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } }
    }, session);
    manager.handleEvent({
      session_id: "agent-open",
      event_name: "message.updated",
      info: { id: "message-1", role: "assistant", modelID: "model-a", tokens: { input: 10, output: 9, reasoning: 2, cache: { read: 3, write: 1 } } }
    }, session);
    manager.handleEvent({
      session_id: "agent-open",
      event_name: "message.updated",
      info: { id: "message-1", role: "assistant", modelID: "model-a", tokens: { input: 0, output: 0 } }
    }, session);

    const tracker = manager.get(session.id);
    expect(tracker.rawTokens).toMatchObject({ inputTokens: 14, outputTokens: 9, reasoningOutputTokens: 2, totalTokens: 25 });
    expect(tracker.models).toEqual(["model-a"]);
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(emitSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ state: "generating" }));
  });
});
