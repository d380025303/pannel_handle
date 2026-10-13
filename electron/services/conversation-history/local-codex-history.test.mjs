import { expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import historyModule from "./agent-conversation-history-service.cjs";
import transcript from "./agent-conversation-transcript.cjs";

it("preserves cold-cache Codex pages while yielding during large transcript parsing", async () => {
  const text = Array.from({ length: 20000 }, (_, index) => JSON.stringify({
    type: "response_item", timestamp: 1000 + index,
    payload: { id: `m${index}`, type: "message", role: index % 2 ? "assistant" : "user", phase: "final",
      content: [{ type: "input_text", text: "中" + "x".repeat(3102) }] }
  })).join("\r\n");
  const expected = transcript.parseAgentConversationText("codex", text, { includeUser: true }).reverse();
  const stat = { size: Buffer.byteLength(text), mtimeMs: 1, ctimeMs: 1 };
  const readFile = vi.fn(async () => text);
  class Database {
    close() {}
    prepare() { return { get: () => ({ rollout_path: "fixture.jsonl" }) }; }
  }
  for (let run = 0; run < 3; run++) {
    const history = historyModule.createAgentConversationHistoryService({ homeDir: "fixture", Database,
      fsApi: { existsSync: () => true, promises: { stat: async () => stat, readFile } } });
    const read = cursor => history.getHistoryMessagesForSession({ id: "panel", type: "windows" },
      { conversationRef: "codex:fixture", limit: 20, cursor });
    let last = performance.now();
    let maxGap = 0;
    let beats = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      beats++;
    }, 1);
    let page;
    try { page = await read(); }
    finally { clearInterval(timer); maxGap = Math.max(maxGap, performance.now() - last); }
    expect(page.messages).toEqual(expected.slice(0, 20));
    expect(page.nextCursor).toBe("20");
    expect((await read("20")).messages).toEqual(expected.slice(20, 40));
    expect((await read("19980")).nextCursor).toBeNull();
    expect((await read()).messages).toEqual(page.messages);
    expect(beats).toBeGreaterThan(5);
    expect(maxGap).toBeLessThan(150);
    console.log(`Codex ${ (stat.size / 1024 / 1024).toFixed(1) } MiB run ${run + 1}: ${beats} heartbeats, max gap ${maxGap.toFixed(1)} ms`);
  }
  expect(readFile).toHaveBeenCalledTimes(3);
});

it("preserves blank lines, malformed records, CRLF, duplicate IDs and an unterminated final line", async () => {
  const line = id => JSON.stringify({ type: "response_item", timestamp: 1000,
    payload: { ...(id ? { id } : {}), type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } });
  const text = `\r\n${line("one")}\r\ninvalid\n \n${line("one")}\n${line()}\n${line("last")}`;
  const { getLocalCodexMessages } = await import("./local-codex-history.cjs");
  class Database { close() {} prepare() { return { get: () => ({ rollout_path: "fixture" }) }; } }
  const messages = await getLocalCodexMessages({ homeDir: "fixture", id: "one", Database,
    fsApi: { existsSync: () => true, promises: { stat: async () => ({}), readFile: async () => text } } });
  expect(messages).toEqual(transcript.parseAgentConversationText("codex", text, { includeUser: true }));
});
