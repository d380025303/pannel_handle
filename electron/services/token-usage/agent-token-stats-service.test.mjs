import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentTokenStatsService } = require("./agent-token-stats-service.cjs");

function codexLine(inputTokens, outputTokens) {
  return `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } } } })}\n`;
}

function qoderLine(id, inputTokens, outputTokens) {
  return `${JSON.stringify({ type: "assistant", uuid: `row-${id}`, message: { id, model: "qoder-model", usage: { input_tokens: inputTokens, output_tokens: outputTokens }, content: [] } })}\n`;
}

function codeBuddyLine(id, inputTokens, outputTokens) {
  return `${JSON.stringify({ type: "message", providerData: { messageId: id, model: "hy3", usage: { inputTokens, outputTokens } } })}\n`;
}

function grokTurnLine(promptId, inputTokens, cachedReadTokens, outputTokens) {
  return `${JSON.stringify({
    timestamp: 1,
    params: {
      _meta: { promptId },
      update: {
        sessionUpdate: "turn_completed",
        usage: { inputTokens, cachedReadTokens, outputTokens, totalTokens: inputTokens + cachedReadTokens + outputTokens, modelUsage: { "grok-build": {} } }
      }
    }
  })}\n`;
}

function createMemoryFiles(initial = "", { beforeStat } = {}) {
  let content = Buffer.from(initial);
  return {
    append(value) { content = Buffer.concat([content, Buffer.from(value)]); },
    truncate(value = "") { content = Buffer.from(value); },
    promises: {
      stat: vi.fn(async () => {
        await beforeStat?.();
        return { size: content.length };
      }),
      open: vi.fn(async () => ({
        read: async (target, offset, length, position) => {
          const source = content.subarray(position, position + length);
          source.copy(target, offset);
          return { bytesRead: source.length };
        },
        close: async () => undefined
      }))
    }
  };
}

function createHarness({ initial = "", now = 1_000, conversationSink = null, beforeStat } = {}) {
  const files = createMemoryFiles(initial, { beforeStat });
  const broadcasts = [];
  const intervals = [];
  let clock = now;
  const statsStore = {
    setBaseline: vi.fn(), update: vi.fn(), markEnded: vi.fn()
  };
  const service = createAgentTokenStatsService({
    terminalManager: {}, statsStore, sshSessionRuntime: {}, fsPromises: files.promises,
    now: () => clock,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    setIntervalFn: (callback) => { intervals.push(callback); return callback; },
    clearIntervalFn: vi.fn(),
    pollIntervalMs: 1000,
    conversationSink
  });
  const session = { id: "panel-1", type: "windows", title: "Codex", cwd: "C:\\work", agentProvider: "codex" };
  const input = { session_id: "agent-1", transcript_path: "C:\\tokens.jsonl", cwd: "C:\\work" };
  return { service, session, input, files, broadcasts, intervals, statsStore, setNow: value => { clock = value; } };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

describe("agent token live statistics", () => {
  it("ignores hooks from removed providers", async () => {
    const harness = createHarness();
    harness.service.handleHook({
      provider: "qwen",
      input: { ...harness.input, hook_event_name: "SessionStart" },
      session: { ...harness.session, agentProvider: "qwen" }
    });
    await flush();

    expect(harness.statsStore.setBaseline).not.toHaveBeenCalled();
    expect(harness.statsStore.update).not.toHaveBeenCalled();
    expect(harness.service.getLive("panel-1")).toBeNull();
  });

  it("emits only current-turn Codex conversation messages through the live reader", async () => {
    const oldMessage = `${JSON.stringify({ type: "response_item", payload: { type: "message", id: "old", role: "assistant", phase: "final", content: [{ type: "output_text", text: "old" }] } })}\n`;
    const sink = { startTurn: vi.fn(), appendMessages: vi.fn(), completeTurn: vi.fn(), clearSession: vi.fn() };
    const harness = createHarness({ initial: oldMessage + codexLine(100, 20), conversationSink: sink });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    expect(sink.clearSession).not.toHaveBeenCalled();
    expect(sink.appendMessages).not.toHaveBeenCalled();

    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));
    expect(sink.startTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "panel-1", supported: true }));
    harness.files.append(`${JSON.stringify({ type: "response_item", payload: { type: "message", id: "current", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "current" }] } })}\n`);
    await harness.intervals[0]();
    await vi.waitFor(() => expect(sink.appendMessages).toHaveBeenCalledWith("panel-1", [expect.objectContaining({ id: "current", text: "current" })]));

    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "Stop" }, session: harness.session });
    await flush();
    expect(sink.completeTurn).toHaveBeenCalledWith("panel-1");
  });

  it("passes the Codex Stop reply to conversation completion as a final fallback", async () => {
    const sink = { startTurn: vi.fn(), appendMessages: vi.fn(), completeTurn: vi.fn() };
    const harness = createHarness({ initial: codexLine(100, 20), conversationSink: sink });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit", turn_id: "turn-1" }, session: harness.session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));

    harness.service.handleHook({
      provider: "codex",
      input: { ...harness.input, hook_event_name: "Stop", turn_id: "turn-1", last_assistant_message: "final fallback" },
      session: harness.session
    });

    await vi.waitFor(() => expect(sink.completeTurn).toHaveBeenCalledWith("panel-1", expect.objectContaining({
      id: "stop:turn-1",
      provider: "codex",
      text: "final fallback"
    })));
  });

  it("emits current Codex final_answer transcript records as final replies", async () => {
    const sink = { startTurn: vi.fn(), appendMessages: vi.fn(), completeTurn: vi.fn() };
    const harness = createHarness({ initial: codexLine(100, 20), conversationSink: sink });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));
    harness.files.append(`${JSON.stringify({ type: "response_item", payload: { type: "message", id: "current-final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "current answer" }] } })}\n`);

    await harness.intervals[0]();

    await vi.waitFor(() => expect(sink.appendMessages).toHaveBeenCalledWith("panel-1", [
      expect.objectContaining({ id: "current-final", kind: "final", text: "current answer" })
    ]));
  });

  it.each(["codex", "codebuddy"])("preserves %s conversations until the panel session ends", async (provider) => {
    const sink = { clearSession: vi.fn() };
    const harness = createHarness({ initial: codexLine(100, 20), conversationSink: sink });
    const session = { ...harness.session, agentProvider: provider };

    harness.service.handleHook({
      provider,
      input: { ...harness.input, hook_event_name: "SessionStart" },
      session
    });
    await flush();

    expect(sink.clearSession).not.toHaveBeenCalled();

    harness.service.markEnded(session.id);

    expect(harness.statsStore.markEnded).toHaveBeenCalledWith("panel-1");
    expect(sink.clearSession).toHaveBeenCalledTimes(1);
    expect(sink.clearSession).toHaveBeenCalledWith("panel-1");
    expect(harness.service.getLive("panel-1")).toBeNull();
  });

  it("marks pure remote SSH turns as unsupported without polling the transcript", () => {
    const sink = { startTurn: vi.fn() };
    const harness = createHarness({ conversationSink: sink });
    harness.service.handleHook({
      provider: "codebuddy",
      input: { ...harness.input, hook_event_name: "UserPromptSubmit" },
      session: { ...harness.session, type: "ssh", agentLocation: "remote", agentProvider: "codebuddy" }
    });
    expect(sink.startTurn).toHaveBeenCalledWith(expect.objectContaining({ provider: "codebuddy", supported: false }));
  });

  it("publishes session deltas and freezes the final average output rate", async () => {
    const harness = createHarness({ initial: codexLine(100, 20), now: 1_000 });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await flush();

    harness.files.append(codexLine(160, 50));
    harness.setNow(4_000);
    await harness.intervals[0]();
    await flush();

    const generating = harness.service.getLive("panel-1");
    expect(generating).toMatchObject({
      state: "generating",
      tokens: { inputTokens: 60, outputTokens: 30 },
      turnOutputTokens: 30,
      outputTokensPerSecond: 10
    });

    harness.setNow(5_000);
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "Stop" }, session: harness.session });
    await flush();
    expect(harness.service.getLive("panel-1")).toMatchObject({ state: "completed", outputTokensPerSecond: 7.5 });
  });

  it("tracks deduplicated OpenCode usage events and persists accurate session totals", () => {
    const harness = createHarness({ now: 1_000 });
    const session = { ...harness.session, type: "ssh", agentProvider: "opencode", title: "OpenCode" };
    const baseInput = { session_id: "open-1", cwd: "/srv/app" };

    harness.service.handleHook({
      provider: "opencode",
      input: { ...baseInput, event_name: "session.status", status: { type: "busy" } },
      session
    });
    harness.setNow(4_000);
    harness.service.handleHook({
      provider: "opencode",
      input: {
        ...baseInput,
        event_name: "message.updated",
        info: {
          id: "message-one",
          role: "assistant",
          modelID: "glm-5.2",
          tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 30, write: 5 } }
        }
      },
      session
    });
    harness.service.handleHook({
      provider: "opencode",
      input: {
        ...baseInput,
        event_name: "message.updated",
        info: {
          id: "message-one",
          role: "assistant",
          modelID: "glm-5.2",
          tokens: { input: 100, output: 30, reasoning: 10, cache: { read: 30, write: 5 } }
        }
      },
      session
    });
    harness.service.handleHook({
      provider: "opencode",
      input: {
        ...baseInput,
        event_name: "message.updated",
        info: {
          id: "message-two",
          role: "assistant",
          modelID: "glm-5.2-mini",
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      },
      session
    });

    expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "opencode",
      state: "generating",
      tokens: {
        inputTokens: 145,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 5,
        outputTokens: 35,
        reasoningOutputTokens: 10,
        totalTokens: 190
      },
      turnOutputTokens: 35,
      outputTokensPerSecond: 11.7,
      models: ["glm-5.2", "glm-5.2-mini"]
    });
    expect(harness.statsStore.update).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "opencode",
      agentSessionId: "open-1",
      location: "ssh",
      tokens: expect.objectContaining({ totalTokens: 190 })
    }));

    const persistedCalls = harness.statsStore.update.mock.calls.length;
    harness.service.handleHook({
      provider: "opencode",
      input: {
        ...baseInput,
        event_name: "message.updated",
        info: {
          id: "message-one",
          role: "assistant",
          modelID: "glm-5.2",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      },
      session
    });
    expect(harness.service.getLive("panel-1")?.tokens.totalTokens).toBe(190);
    expect(harness.statsStore.update).toHaveBeenCalledTimes(persistedCalls);

    harness.setNow(5_000);
    harness.service.handleHook({ provider: "opencode", input: { ...baseInput, event_name: "session.idle" }, session });
    expect(harness.service.getLive("panel-1")).toMatchObject({ state: "completed", outputTokensPerSecond: 8.8 });
  });

  it("keeps CodeBuddy live tracking on the main transcript when subagents emit hooks", async () => {
    const harness = createHarness({ initial: codeBuddyLine("main-one", 100, 20) });
    const session = { ...harness.session, agentProvider: "codebuddy" };
    const input = {
      ...harness.input,
      session_id: "main-agent",
      transcript_path: "C:\\work\\main.jsonl"
    };
    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "SessionStart", source: "resume" }, session });
    await flush();
    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
    await flush();

    harness.service.handleHook({
      provider: "codebuddy",
      input: {
        ...input,
        session_id: "subagent-one",
        transcript_path: "C:\\work\\main\\subagents\\agent-one.jsonl",
        hook_event_name: "Stop"
      },
      session
    });
    harness.files.append(codeBuddyLine("main-two", 60, 30));
    await harness.intervals[0]();
    await flush();

    expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "codebuddy",
      state: "generating",
      tokens: { inputTokens: 60, outputTokens: 30 }
    });
    expect(harness.statsStore.update).not.toHaveBeenCalled();
  });

  it.each(["startup", undefined])("keeps the first CodeBuddy usage outside the %s session baseline", async (source) => {
    let releaseStat;
    const statGate = new Promise(resolve => { releaseStat = resolve; });
    const harness = createHarness({ beforeStat: () => statGate });
    const session = { ...harness.session, agentProvider: "codebuddy" };
    const input = {
      ...harness.input,
      session_id: "codebuddy-new",
      transcript_path: "C:\\work\\codebuddy-new.jsonl"
    };

    harness.service.handleHook({
      provider: "codebuddy",
      input: { ...input, hook_event_name: "SessionStart", ...(source ? { source } : {}) },
      session
    });
    harness.files.append(codeBuddyLine("first-response", 80, 25));
    releaseStat();

    await vi.waitFor(() => expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "codebuddy",
      tokens: { inputTokens: 80, outputTokens: 25, totalTokens: 105 }
    }));
  });

  it("resets a reused CodeBuddy tracker after clear", async () => {
    const harness = createHarness({ initial: codeBuddyLine("before-clear", 100, 20) });
    const session = { ...harness.session, agentProvider: "codebuddy" };
    const input = {
      ...harness.input,
      session_id: "codebuddy-clear",
      transcript_path: "C:\\work\\codebuddy-clear.jsonl"
    };

    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "SessionStart", source: "resume" }, session });
    await flush();
    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "SessionStart", source: "clear" }, session });
    harness.files.truncate();
    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
    await flush();
    harness.files.append(codeBuddyLine("after-clear", 35, 12));
    await harness.intervals[0]();

    await vi.waitFor(() => expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "codebuddy",
      state: "generating",
      tokens: { inputTokens: 35, outputTokens: 12, totalTokens: 47 }
    }));
  });

  it("tracks Grok usage from ACP updates with snake-case hook events", async () => {
    const harness = createHarness();
    const session = { ...harness.session, agentProvider: "grok" };
    const input = {
      sessionId: "grok-session",
      transcriptPath: "C:\\work\\updates.jsonl"
    };

    harness.service.handleHook({ provider: "grok", input: { ...input, hookEventName: "session_start" }, session });
    await flush();
    harness.service.handleHook({ provider: "grok", input: { ...input, hookEventName: "user_prompt_submit" }, session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));
    harness.files.append(grokTurnLine("turn-one", 12, 8, 5));
    await harness.intervals[0]();

    await vi.waitFor(() => expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "grok",
      state: "generating",
      tokens: { inputTokens: 12, cachedInputTokens: 8, outputTokens: 5, totalTokens: 25 },
      models: ["grok-build"]
    }));
  });

  it("tracks and persists Qoder transcript usage", async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), "pannel-handle-qoder-token-"));
    const transcriptPath = path.join(tempDirectory, "qoder.jsonl");
    await writeFile(transcriptPath, qoderLine("one", 100, 20), "utf-8");
    const intervals = [];
    const statsStore = {
      setBaseline: vi.fn(),
      markEnded: vi.fn(),
      update: vi.fn(input => input)
    };
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore, sshSessionRuntime: {}, retryDelaysMs: [0],
      setIntervalFn: callback => { intervals.push(callback); return callback; },
      clearIntervalFn: vi.fn()
    });
    const session = { id: "panel-qoder", type: "windows", title: "Qoder", cwd: "C:\\work", agentProvider: "qoder" };
    const input = { session_id: "agent-qoder", transcript_path: transcriptPath, cwd: "C:\\work" };

    try {
      service.handleHook({ provider: "qoder", input: { ...input, hook_event_name: "SessionStart" }, session });
      await vi.waitFor(() => expect(statsStore.setBaseline).toHaveBeenCalledWith("qoder", "agent-qoder", expect.objectContaining({ totalTokens: 120 }), expect.anything()));
      service.handleHook({ provider: "qoder", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
      await vi.waitFor(() => expect(service.getLive("panel-qoder")?.state).toBe("generating"));
      await appendFile(transcriptPath, qoderLine("two", 20, 5), "utf-8");
      intervals[0]();
      await vi.waitFor(() => expect(service.getLive("panel-qoder")).toMatchObject({ tokens: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }));

      service.handleHook({ provider: "qoder", input: { ...input, hook_event_name: "Stop" }, session });
      await vi.waitFor(() => expect(statsStore.update).toHaveBeenCalledWith(expect.objectContaining({
        provider: "qoder",
        agentSessionId: "agent-qoder",
        tokens: expect.objectContaining({ totalTokens: 145 })
      })));
      expect(service.getLive("panel-qoder")?.state).toBe("completed");
    } finally {
      service.shutdown();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("restarts parsing when a transcript is truncated", async () => {
    const harness = createHarness({ initial: codexLine(100, 20) });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    harness.files.truncate(codexLine(5, 2));
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await flush();
    expect(harness.service.getLive("panel-1")?.tokens).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it("holds a partial JSONL record until its newline arrives", async () => {
    const harness = createHarness({ initial: codexLine(100, 20).trimEnd() });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    expect(harness.service.getLive("panel-1")?.state).toBe("waiting");

    harness.files.append("\n");
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await flush();
    expect(harness.service.getLive("panel-1")).toMatchObject({
      state: "generating",
      tokens: { inputTokens: 0, outputTokens: 0 }
    });
  });

  it("converts WSL transcript paths through the host bridge", async () => {
    const harness = createHarness();
    const convert = vi.fn(() => "\\\\wsl.localhost\\Ubuntu\\home\\me\\tokens.jsonl");
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore: harness.statsStore, sshSessionRuntime: {}, fsPromises: harness.files.promises,
      toWslHostPathFn: convert, broadcast: () => undefined
    });
    service.handleHook({
      provider: "codex",
      input: { ...harness.input, hook_event_name: "SessionStart", transcript_path: "/home/me/tokens.jsonl" },
      session: { ...harness.session, type: "wsl", wslDistro: "Ubuntu" }
    });
    await flush();
    expect(convert).toHaveBeenCalledWith("Ubuntu", "/home/me/tokens.jsonl");
    service.shutdown();
  });

  it("tracks a local-bridge SSH Codex transcript from the Windows host", async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), "pannel-handle-token-"));
    const transcriptPath = path.join(tempDirectory, "bridge.jsonl");
    await writeFile(transcriptPath, codexLine(100, 20), "utf-8");
    const intervals = [];
    const broadcasts = [];
    const statsStore = {
      setBaseline: vi.fn(),
      markEnded: vi.fn(),
      update: vi.fn(input => ({ ...input, tokens: input.tokens, capabilities: input.capabilities, models: input.models }))
    };
    const sshSessionRuntime = { connectClient: vi.fn() };
    let clock = 1_000;
    const service = createAgentTokenStatsService({
      terminalManager: {},
      statsStore,
      sshSessionRuntime,
      now: () => clock,
      retryDelaysMs: [0],
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      setIntervalFn: callback => { intervals.push(callback); return callback; },
      clearIntervalFn: vi.fn()
    });
    const session = {
      id: "panel-bridge",
      type: "ssh",
      agentLocation: "local",
      title: "Bridge",
      cwd: "/srv/app",
      agentProvider: "codex"
    };
    const input = {
      session_id: "agent-bridge",
      transcript_path: transcriptPath,
      cwd: "C:\\runtime\\panel-bridge"
    };

    try {
      service.handleHook({ provider: "codex", input: { ...input, hook_event_name: "SessionStart" }, session });
      await vi.waitFor(() => expect(broadcasts.some(event => event.channel === "agent-token-live:changed")).toBe(true));
      service.handleHook({ provider: "codex", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
      await vi.waitFor(() => expect(service.getLive("panel-bridge")?.state).toBe("generating"));
      await appendFile(transcriptPath, codexLine(160, 50), "utf-8");
      clock = 4_000;
      await intervals[0]();
      await vi.waitFor(() => expect(service.getLive("panel-bridge")?.tokens).toMatchObject({ inputTokens: 60, outputTokens: 30 }));
      service.handleHook({ provider: "codex", input: { ...input, hook_event_name: "Stop" }, session });
      await vi.waitFor(() => expect(service.getLive("panel-bridge")?.state).toBe("completed"));
      await vi.waitFor(() => expect(statsStore.update).toHaveBeenCalled());

      expect(service.getLive("panel-bridge")).toMatchObject({
        state: "completed",
        tokens: { inputTokens: 60, outputTokens: 30 }
      });
      expect(statsStore.update).toHaveBeenCalledWith(expect.objectContaining({
        panelSessionId: "panel-bridge",
        location: "ssh",
        tokens: expect.objectContaining({ totalTokens: 210 })
      }));
      expect(sshSessionRuntime.connectClient).not.toHaveBeenCalled();
    } finally {
      service.shutdown();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("publishes a completed SSH snapshot after remote transcript collection", async () => {
    const broadcasts = [];
    const statsStore = {
      setBaseline: vi.fn(),
      markEnded: vi.fn(),
      update: vi.fn(input => ({ ...input, tokens: input.tokens, capabilities: input.capabilities, models: input.models }))
    };
    const transcript = [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 } } } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "mcp-a", name: "mcp__remote__inspect", arguments: "{}" } })
    ];
    const sshSessionRuntime = {
      connectClient: vi.fn(async () => ({
        exec: (_command, callback) => {
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          callback(null, stream);
          queueMicrotask(() => {
            stream.emit("data", Buffer.from(JSON.stringify(transcript)));
            stream.emit("close", 0);
          });
        },
        end: vi.fn()
      }))
    };
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore, sshSessionRuntime, retryDelaysMs: [0],
      broadcast: (channel, payload) => broadcasts.push({ channel, payload })
    });
    service.handleHook({
      provider: "codex",
      input: { session_id: "agent-ssh", transcript_path: "/tmp/session.jsonl", hook_event_name: "Stop" },
      session: { id: "panel-ssh", type: "ssh", title: "Remote", cwd: "/tmp" }
    });
    await flush();
    await flush();

    expect(service.getLive("panel-ssh")).toMatchObject({
      state: "completed",
      tokens: { totalTokens: 35 },
      capabilities: { mcp: { totalCalls: 1 } }
    });
    expect(broadcasts.some(event => event.channel === "agent-token-live:changed")).toBe(true);
  });
});
