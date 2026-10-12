import { describe, expect, it, vi } from "vitest";
import liveModule from "./index.cjs";

describe("Codex live turn completion", () => {
  it.each(["", "\n"])("counts an MCP call once with trailing %j", async newline => {
    let content = Buffer.alloc(0);
    const emitSnapshot = vi.fn();
    const service = liveModule.createAgentTokenLiveModule({
      emitSnapshot,
      fsPromises: {
        stat: async () => ({ size: content.length }),
        open: async () => ({
          read: async (target, offset, length, position) => {
            const bytes = content.subarray(position, position + length);
            bytes.copy(target, offset);
            return { bytesRead: bytes.length };
          },
          close: async () => {}
        })
      },
      setIntervalFn: vi.fn(() => 1),
      clearIntervalFn: vi.fn()
    });
    const event = eventName => service.handleEvent({
      provider: "codex",
      eventName,
      session: { id: "panel", type: "windows" },
      input: { session_id: "agent", transcript_path: "C:\\codex.jsonl" }
    });
    try {
      const { tracker } = event("UserPromptSubmit");
      await tracker.pollPromise;
      await new Promise(resolve => setImmediate(resolve));
      expect(service.getSnapshot("panel").state).toBe("generating");
      content = Buffer.from(JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", call_id: "mcp-1", name: "mcp__jira__get_issue", arguments: "{}" }
      }) + newline);
      await event("Stop").completion;
      expect(service.getSnapshot("panel")).toMatchObject({
        state: "completed", capabilities: { mcp: { totalCalls: 1 } }
      });
      expect(emitSnapshot.mock.calls.at(-1)[0].capabilities.mcp.totalCalls).toBe(1);
      await event("Stop").completion;
      expect(service.getSnapshot("panel").capabilities.mcp.totalCalls).toBe(1);
    } finally {
      service.shutdown();
    }
  });
});
