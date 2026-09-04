import { describe, expect, it, vi } from "vitest";
import openCodeModule from "./opencode-tracker.cjs";

const { createOpenCodeTrackerManager } = openCodeModule;

describe("OpenCode live token tracker", () => {
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
