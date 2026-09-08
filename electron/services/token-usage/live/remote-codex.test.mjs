import { describe, expect, it, vi } from "vitest";
import liveModule from "./index.cjs";

const line = (input, output) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } } }) + "\n";
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let content = line(100, 20);
  let offset = 0;
  let failure = false;
  let pending;
  const callbacks = [];
  const emitSnapshot = vi.fn();
  const client = {
    close: vi.fn(),
    exec: vi.fn(async () => {
      if (pending) await pending;
      if (failure) throw new Error("SSH interrupted");
      const bytes = Buffer.from(content);
      const start = bytes.length < offset ? 0 : offset;
      offset = bytes.length;
      return JSON.stringify({ main: { path: "/remote/codex.jsonl", identity: "1:1", start, offset, data: bytes.subarray(start).toString("base64") }, subagents: [] });
    })
  };
  const transport = { createReusableCommandClient: vi.fn(() => client) };
  const service = liveModule.createAgentTokenLiveModule({ sshAgentTransport: transport, emitSnapshot,
    setIntervalFn: callback => { callbacks.push(callback); return callback; }, clearIntervalFn: vi.fn() });
  const event = eventName => service.handleEvent({ provider: "codex", eventName,
    session: { id: "panel", type: "ssh", agentLocation: "remote" },
    input: { session_id: "agent", transcript_path: "/remote/codex.jsonl" } });
  return { service, event, client, transport, emitSnapshot,
    append: value => { content += value; }, truncate: value => { content = value; },
    fail: value => { failure = value; }, block: value => { pending = value; },
    tick: async () => { callbacks.at(-1)(); await settle(); }, callbacks,
    snapshot: () => service.getSnapshot("panel") };
}

describe("remote Codex live tokens", () => {
  it("streams deltas before Stop, preserves baselines across turns and ignores completion fallback", async () => {
    const h = harness();
    h.event("SessionStart"); await settle();
    h.event("UserPromptSubmit"); await settle();
    h.append(line(130, 25)); await h.tick();
    expect(h.snapshot()).toMatchObject({ state: "generating", tokens: { totalTokens: 35 }, turnOutputTokens: 5 });
    await h.tick();
    expect(h.snapshot().tokens.totalTokens).toBe(35);
    const next = line(150, 40);
    h.append(next.slice(0, -5)); await h.tick();
    expect(h.snapshot().tokens.totalTokens).toBe(35);
    h.append(next.slice(-5)); await h.tick();
    expect(h.snapshot().tokens.totalTokens).toBe(70);
    expect(h.transport.createReusableCommandClient).toHaveBeenCalledTimes(1);
    expect(h.client.exec.mock.calls[0][0]).toMatch(/'codex'$/);
    await h.event("Stop").completion;
    const final = h.snapshot();
    h.service.setCompletedSnapshot("panel", { provider: "codex", tokens: { totalTokens: 999 }, models: [] });
    expect(h.snapshot()).toEqual(final);
    expect(h.emitSnapshot.mock.calls.at(-1)[0]).toEqual(final);
    h.event("UserPromptSubmit"); await settle();
    h.append(line(160, 45)); await h.tick();
    expect(h.snapshot()).toMatchObject({ tokens: { totalTokens: 85 }, turnOutputTokens: 5 });
    h.service.shutdown();
  });

  it("recovers after SSH failure and transcript truncation", async () => {
    const h = harness();
    h.event("UserPromptSubmit"); await settle();
    h.fail(true); await h.tick();
    expect(h.snapshot().state).toBe("unavailable");
    h.fail(false); h.append(line(130, 30)); await h.tick();
    expect(h.snapshot()).toMatchObject({ state: "generating", tokens: { totalTokens: 40 } });
    expect(h.transport.createReusableCommandClient).toHaveBeenCalledTimes(2);
    h.truncate(line(140, 40)); await h.tick();
    expect(h.snapshot().tokens.totalTokens).toBe(60);
    h.service.shutdown();
  });

  it.each(["endSession", "shutdown"])("does not restart or broadcast after %s during an initial read", async cleanup => {
    const h = harness();
    let release;
    h.block(new Promise(resolve => { release = resolve; }));
    h.event("UserPromptSubmit");
    h.service[cleanup]("panel");
    release(); await settle();
    expect(h.snapshot()).toBeNull();
    expect(h.callbacks).toHaveLength(0);
    expect(h.emitSnapshot).not.toHaveBeenCalled();
    expect(h.client.close).toHaveBeenCalledTimes(1);
  });
});
