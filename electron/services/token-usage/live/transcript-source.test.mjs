import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import liveModule from "./index.cjs";
import transcriptModule from "../agent-token-transcript.cjs";

function harness() {
  const mainPath = path.resolve("transcript.jsonl");
  const subPath = path.join(transcriptModule.getCodeBuddySubagentsDir(mainPath), "agent.jsonl");
  const files = new Map([[mainPath, Buffer.alloc(0)], [subPath, Buffer.alloc(0)]]);
  let poll;
  const onMainLine = vi.fn();
  const service = liveModule.createAgentTokenLiveModule({
    onMainLine,
    fsPromises: {
      stat: async file => ({ size: files.get(file).length }),
      readdir: async () => ["agent.jsonl"],
      open: async file => ({
        read: async (target, offset, length, position) => {
          const bytes = files.get(file).subarray(position, position + length);
          bytes.copy(target, offset);
          return { bytesRead: bytes.length };
        },
        close: async () => {}
      })
    },
    setIntervalFn: callback => { poll = callback; return 1; },
    clearIntervalFn: vi.fn()
  });
  const event = eventName => service.handleEvent({
    provider: "codebuddy", eventName,
    session: { id: "panel", type: "windows" },
    input: { session_id: "agent", transcript_path: mainPath }
  });
  return { service, event, files, mainPath, subPath, onMainLine, poll: () => poll() };
}

function usageLine(id) {
  return JSON.stringify({ text: "中文🙂", providerData: {
    messageId: id, model: "glm-5.2", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
  } });
}

describe("live transcript pending buffers", () => {
  it("releases 20 MiB buffers after newline, idle polling and actual Stop", async () => {
    const h = harness();
    const large = Buffer.alloc(20 * 1024 * 1024, 0x20);
    const line = Buffer.from(usageLine("main") + "\n");
    line.copy(large, large.length - line.length);
    h.files.set(h.mainPath, large);
    h.files.set(h.subPath, large);
    try {
      const { tracker } = h.event("UserPromptSubmit");
      await tracker.pollPromise;
      await new Promise(resolve => setImmediate(resolve));
      const check = () => {
        for (const reader of [tracker, ...tracker.subagentReaders.values()]) {
          expect(reader.pendingBytes.length).toBe(0);
          expect(reader.pendingBytes.buffer.byteLength).toBe(0);
        }
        expect(tracker.parser.getResult().tokens.totalTokens).toBe(15);
      };
      check();
      h.poll();
      await tracker.pollPromise;
      check();
      await h.event("Stop").completion;
      check();
      expect(h.service.getSnapshot("panel").state).toBe("completed");
    } finally { h.service.shutdown(); }
  });

  it("copies only unfinished tails and preserves split UTF-8 and token totals", async () => {
    const h = harness();
    const main = Buffer.from(usageLine("main") + "\r\n");
    const sub = Buffer.from(usageLine("sub") + "\n");
    const split = main.indexOf(Buffer.from("中")) + 1;
    const padding = Buffer.alloc(20 * 1024 * 1024, 0x0a);
    h.files.set(h.mainPath, Buffer.concat([padding, main.subarray(0, split)]));
    h.files.set(h.subPath, Buffer.concat([padding, sub.subarray(0, split)]));
    try {
      const { tracker } = h.event("UserPromptSubmit");
      await tracker.pollPromise;
      await new Promise(resolve => setImmediate(resolve));
      for (const reader of [tracker, ...tracker.subagentReaders.values()]) {
        expect(reader.pendingBytes.length).toBe(split);
        expect(reader.pendingBytes.buffer.byteLength).toBeLessThan(20 * 1024 * 1024);
      }
      h.files.set(h.mainPath, Buffer.concat([padding, main]));
      h.files.set(h.subPath, Buffer.concat([padding, sub]));
      await h.event("Stop").completion;
      const expected = transcriptModule.parseTranscriptText("codebuddy", usageLine("main") + "\n" + usageLine("sub"));
      expect(tracker.parser.getResult().tokens).toEqual(expected.tokens);
      expect(expected.tokens.totalTokens).toBe(30);
      expect(h.onMainLine).toHaveBeenCalledWith(tracker, usageLine("main"));
      for (const reader of [tracker, ...tracker.subagentReaders.values()]) {
        expect(reader.pendingBytes.buffer.byteLength).toBe(0);
      }
    } finally { h.service.shutdown(); }
  });
});
