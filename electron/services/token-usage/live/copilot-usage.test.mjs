import { describe, expect, it, vi } from "vitest";
import liveModule from "./index.cjs";

function usageLine(id, model = "gpt-5", input = 120, output = 30) {
  const attributes = {
    "gen_ai.operation.name": "chat",
    "gen_ai.conversation.id": "conversation",
    "gen_ai.response.model": model,
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.output_tokens": output
  };
  return JSON.stringify({ span: { traceId: "trace", spanId: id,
    attributes: Object.entries(attributes).map(([key, value]) => ({ key,
      value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value }
    }))
  } });
}

function harness(onUsage = vi.fn()) {
  let content = Buffer.from(usageLine("initial") + "\n");
  let timer;
  const read = vi.fn(async (target, offset, length, position) => {
    const bytes = content.subarray(position, position + length);
    bytes.copy(target, offset);
    return { bytesRead: bytes.length };
  });
  const emitSnapshot = vi.fn();
  const service = liveModule.createAgentTokenLiveModule({
    onUsage, emitSnapshot,
    fsPromises: {
      stat: async () => ({ size: content.length }),
      open: async () => ({ read, close: async () => {} })
    },
    setIntervalFn: callback => { timer = callback; return 1; },
    clearIntervalFn: vi.fn()
  });
  const event = eventName => service.handleEvent({ provider: "copilot", eventName,
    session: { id: "panel", type: "windows" }, input: { session_id: "agent" }
  });
  return { service, event, read, onUsage, emitSnapshot,
    append: text => { content = Buffer.concat([content, Buffer.from(text)]); },
    poll: async tracker => { timer(); await tracker.pollPromise; }
  };
}

describe("Copilot live usage persistence", () => {
  it("skips 60 unchanged polls, persists appended usage and flushes the final line", async () => {
    const h = harness();
    try {
      const { tracker } = h.event("UserPromptSubmit");
      await tracker.pollPromise;
      await new Promise(resolve => setImmediate(resolve));
      expect(h.onUsage).toHaveBeenCalledTimes(1);
      expect(tracker.rawTokens.totalTokens).toBe(150);
      const emitted = h.emitSnapshot.mock.calls.length;
      for (let i = 0; i < 60; i++) await h.poll(tracker);
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.onUsage).toHaveBeenCalledTimes(1);
      expect(h.emitSnapshot).toHaveBeenCalledTimes(emitted + 60);
      h.append(usageLine("next") + "\n");
      await h.poll(tracker);
      expect(h.onUsage).toHaveBeenCalledTimes(2);
      expect(tracker.rawTokens.totalTokens).toBe(300);
      // A model-only change must also be saved.
      h.append(usageLine("model", "other-model", 0, 0) + "\n");
      await h.poll(tracker);
      expect(h.onUsage).toHaveBeenCalledTimes(3);
      h.append(usageLine("tail"));
      await h.event("Stop").completion;
      expect(h.onUsage).toHaveBeenCalledTimes(4);
      expect(tracker.rawTokens.totalTokens).toBe(450);
      await h.event("Stop").completion;
      expect(h.onUsage).toHaveBeenCalledTimes(4);
    } finally { h.service.shutdown(); }
  });

  it("retries a failed save on the next unchanged poll", async () => {
    const onUsage = vi.fn().mockImplementationOnce(() => { throw new Error("save failed"); });
    const h = harness(onUsage);
    try {
      const { tracker } = h.event("UserPromptSubmit");
      await tracker.pollPromise;
      await new Promise(resolve => setImmediate(resolve));
      expect(onUsage).toHaveBeenCalledTimes(1);
      await h.poll(tracker);
      expect(onUsage).toHaveBeenCalledTimes(2);
      await h.poll(tracker);
      expect(onUsage).toHaveBeenCalledTimes(2);
    } finally { h.service.shutdown(); }
  });
});
