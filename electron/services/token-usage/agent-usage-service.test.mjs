import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createAgentUsageService,
  createCodeBuddyProcessTransport,
  createSshTransport,
  getProcessInvocation,
  normalizeRateLimitResponse,
  runCodexRateLimitRequest,
  runCodexResetCreditRequest
} = require("./agent-usage-service.cjs");

function rateLimitResult(usedPercent = 25) {
  return {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent, windowDurationMins: 10080, resetsAt: 2_000_000_000 }
    }
  };
}

function createProtocolTransport(result = rateLimitResult(), options = {}) {
  const events = new EventEmitter();
  const transport = {
    writes: [],
    close: vi.fn(),
    on: (eventName, listener) => events.on(eventName, listener),
    write: vi.fn((line) => {
      const message = JSON.parse(line);
      transport.writes.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => events.emit("stdout", `${JSON.stringify({ id: message.id, result: { userAgent: "test" } })}\n`));
      } else if (message.method === "account/rateLimits/read") {
        queueMicrotask(() => {
          if (options.malformed) {
            events.emit("stdout", "not-json\n");
          } else if (options.error) {
            events.emit("stdout", `${JSON.stringify({ id: message.id, error: { message: options.error } })}\n`);
          } else {
            events.emit("stdout", `${JSON.stringify({ id: message.id, result })}\n`);
          }
        });
      } else if (message.method === "account/rateLimitResetCredit/consume") {
        queueMicrotask(() => events.emit("stdout", `${JSON.stringify({
          id: message.id,
          result: { outcome: options.resetOutcome || "reset" }
        })}\n`));
      }
    })
  };
  transport.emit = (...args) => events.emit(...args);
  return transport;
}

describe("agent-usage-service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes the primary and model-specific limits with remaining percentages", () => {
    expect(normalizeRateLimitResponse({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 49, windowDurationMins: 10080, resetsAt: 200 }
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 49, windowDurationMins: 10080, resetsAt: 200 }
        },
        codex_spark: {
          limitId: "codex_spark",
          limitName: "GPT Spark",
          primary: { usedPercent: -5, windowDurationMins: null, resetsAt: null }
        }
      },
      rateLimitResetCredits: {
        availableCount: 2,
        credits: [{
          id: "reset-1",
          title: " Weekly reset ",
          description: " Resets eligible Codex limits. ",
          status: "available",
          resetType: "codexRateLimits",
          grantedAt: 300,
          expiresAt: 400
        }]
      }
    }, 1234)).toEqual({
      provider: "codex",
      fetchedAt: 1234,
      primaryLimitId: "codex",
      limits: [
        {
          id: "codex",
          name: "Codex",
          usedPercent: 49,
          remainingPercent: 51,
          windowDurationMins: 10080,
          resetsAt: 200000
        },
        {
          id: "codex_spark",
          name: "GPT Spark",
          usedPercent: 0,
          remainingPercent: 100
        }
      ],
      resetCredits: {
        availableCount: 2,
        credits: [{
          id: "reset-1",
          title: "Weekly reset",
          description: "Resets eligible Codex limits.",
          status: "available",
          resetType: "codexRateLimits",
          grantedAt: 300000,
          expiresAt: 400000
        }]
      }
    });
  });

  it("keeps reset-credit counts without details and ignores malformed reset-credit data", () => {
    expect(normalizeRateLimitResponse({
      ...rateLimitResult(),
      rateLimitResetCredits: { availableCount: 0, credits: null }
    }, 10)).toMatchObject({
      resetCredits: { availableCount: 0 }
    });

    const partial = normalizeRateLimitResponse({
      ...rateLimitResult(),
      rateLimitResetCredits: {
        availableCount: 3.8,
        credits: [
          { id: "missing-grant", status: "available", resetType: "codexRateLimits" },
          { id: "valid", status: "future-status", resetType: "future-type", grantedAt: 500 }
        ]
      }
    }, 10);
    expect(partial.resetCredits).toEqual({
      availableCount: 3,
      credits: [{
        id: "valid",
        status: "unknown",
        resetType: "unknown",
        grantedAt: 500000
      }]
    });

    expect(normalizeRateLimitResponse({
      ...rateLimitResult(),
      rateLimitResetCredits: { availableCount: -1 }
    }, 10).resetCredits).toBeUndefined();
  });

  it("falls back to the historical single-bucket response and rejects unusable data", () => {
    expect(normalizeRateLimitResponse(rateLimitResult(120), 10).limits[0]).toMatchObject({
      id: "codex",
      usedPercent: 100,
      remainingPercent: 0
    });
    expect(() => normalizeRateLimitResponse({ rateLimits: { primary: {} } })).toThrow("usable rate-limit window");
  });

  it("builds the Windows and WSL app-server invocations", () => {
    expect(getProcessInvocation({ type: "windows" })).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "codex app-server --stdio"]
    });
    expect(getProcessInvocation({ type: "wsl", wslDistro: "Ubuntu-24.04" })).toEqual({
      command: "wsl.exe",
      args: ["-d", "Ubuntu-24.04", "--", "bash", "-lic", "exec codex app-server --stdio"]
    });
  });

  it("starts Windows CodeBuddy ACP and terminates its complete process tree", () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { writable: true, write: vi.fn(), end: vi.fn() };
    const spawn = vi.fn(() => child);
    const terminateProcessTree = vi.fn();

    const transport = createCodeBuddyProcessTransport(
      { type: "windows" },
      spawn,
      terminateProcessTree
    );
    transport.write("hello\n");
    transport.close();

    expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", "codebuddy --acp"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(child.stdin.write).toHaveBeenCalledWith("hello\n");
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(terminateProcessTree).toHaveBeenCalledWith(child);
  });

  it("waits for initialization before requesting account rate limits", async () => {
    const transport = createProtocolTransport(rateLimitResult(36));
    await expect(runCodexRateLimitRequest(transport)).resolves.toEqual(rateLimitResult(36));
    expect(transport.writes.map(message => message.method)).toEqual([
      "initialize",
      "account/rateLimits/read"
    ]);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("consumes a specific Codex reset credit with an idempotency key", async () => {
    const transport = createProtocolTransport();
    await expect(runCodexResetCreditRequest(transport, {
      creditId: "reset-1",
      idempotencyKey: "attempt-1"
    })).resolves.toBe("reset");
    expect(transport.writes).toEqual([
      expect.objectContaining({ method: "initialize" }),
      expect.objectContaining({
        method: "account/rateLimitResetCredit/consume",
        params: { creditId: "reset-1", idempotencyKey: "attempt-1" }
      })
    ]);
    expect(transport.close).toHaveBeenCalledTimes(1);

    await expect(runCodexResetCreditRequest(createProtocolTransport(undefined, { resetOutcome: "future" }), {
      creditId: "reset-1",
      idempotencyKey: "attempt-2"
    })).rejects.toThrow("invalid reset outcome");
  });

  it("rejects malformed, protocol-error, oversized, and timed-out responses", async () => {
    await expect(runCodexRateLimitRequest(createProtocolTransport(rateLimitResult(), { malformed: true })))
      .rejects.toThrow("invalid App Server response");
    await expect(runCodexRateLimitRequest(createProtocolTransport(rateLimitResult(), { error: "not logged in" })))
      .rejects.toThrow("not logged in");

    const oversized = createProtocolTransport();
    oversized.write = vi.fn(() => queueMicrotask(() => oversized.emit("stdout", "x".repeat(40))));
    await expect(runCodexRateLimitRequest(oversized, { maxOutputBytes: 20 }))
      .rejects.toThrow("exceeded the allowed size");

    vi.useFakeTimers();
    const hanging = createProtocolTransport();
    hanging.write = vi.fn();
    const timeoutPromise = runCodexRateLimitRequest(hanging, { timeoutMs: 50 });
    const timeoutExpectation = expect(timeoutPromise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await timeoutExpectation;
  });

  it("reuses cached and pending usage, while force refresh bypasses the cache", async () => {
    const session = { id: "run-1", type: "windows", agentProvider: "codex" };
    let usedPercent = 10;
    const transports = [];
    const service = createAgentUsageService({
      terminalManager: { getSession: () => session },
      now: () => 1000,
      transportFactory: () => {
        const transport = createProtocolTransport(rateLimitResult(usedPercent));
        transports.push(transport);
        usedPercent += 10;
        return transport;
      }
    });

    const first = service.getUsage("run-1");
    const concurrent = service.getUsage("run-1");
    expect(concurrent).toBe(first);
    await expect(first).resolves.toMatchObject({ limits: [{ usedPercent: 10, remainingPercent: 90 }] });
    await expect(service.getUsage("run-1")).resolves.toMatchObject({ limits: [{ usedPercent: 10 }] });
    expect(transports).toHaveLength(1);
    await expect(service.getUsage("run-1", { force: true })).resolves.toMatchObject({ limits: [{ usedPercent: 20 }] });
    expect(transports).toHaveLength(2);
  });

  it("consumes a reset credit, invalidates the cache, and returns refreshed limits", async () => {
    const session = { id: "run-1", type: "windows", agentProvider: "codex" };
    const transports = [];
    const service = createAgentUsageService({
      terminalManager: { getSession: () => session },
      now: () => 2000,
      transportFactory: () => {
        const transport = transports.length === 0
          ? createProtocolTransport(undefined, { resetOutcome: "alreadyRedeemed" })
          : createProtocolTransport(rateLimitResult(5));
        transports.push(transport);
        return transport;
      }
    });

    await expect(service.consumeResetCredit(session.id, {
      creditId: "reset-1",
      idempotencyKey: "attempt-1"
    })).resolves.toMatchObject({
      outcome: "alreadyRedeemed",
      snapshot: { limits: [{ usedPercent: 5, remainingPercent: 95 }] }
    });
    expect(transports).toHaveLength(2);
    await expect(service.getUsage(session.id)).resolves.toMatchObject({ limits: [{ usedPercent: 5 }] });
    expect(transports).toHaveLength(2);
  });

  it("keeps a definitive reset outcome when the follow-up refresh fails", async () => {
    const session = { id: "run-1", type: "windows", agentProvider: "codex" };
    let call = 0;
    const service = createAgentUsageService({
      terminalManager: { getSession: () => session },
      transportFactory: () => call++ === 0
        ? createProtocolTransport(undefined, { resetOutcome: "nothingToReset" })
        : createProtocolTransport(undefined, { error: "refresh unavailable" })
    });

    await expect(service.consumeResetCredit(session.id, {
      creditId: "reset-1",
      idempotencyKey: "attempt-1"
    })).resolves.toEqual({ outcome: "nothingToReset", refreshError: "refresh unavailable" });
  });

  it("validates reset-credit sessions and identifiers before starting a transport", async () => {
    const transportFactory = vi.fn();
    let session = { id: "run-1", type: "windows", agentProvider: "codebuddy" };
    const service = createAgentUsageService({
      terminalManager: { getSession: () => session },
      transportFactory
    });

    await expect(service.consumeResetCredit(session.id, { creditId: "reset-1", idempotencyKey: "attempt-1" }))
      .rejects.toThrow("only available for Codex");
    session = { ...session, agentProvider: "codex" };
    await expect(service.consumeResetCredit(session.id, { creditId: "", idempotencyKey: "attempt-1" }))
      .rejects.toThrow("credit ID");
    await expect(service.consumeResetCredit(session.id, { creditId: "reset-1", idempotencyKey: "" }))
      .rejects.toThrow("idempotency key");
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("reads local-bridge SSH Codex usage from Windows and shares the local account cache", async () => {
    const sessions = new Map([
      ["bridge-1", { id: "bridge-1", type: "ssh", agentLocation: "local", agentProvider: "codex" }],
      ["bridge-2", { id: "bridge-2", type: "ssh", agentLocation: "local", agentProvider: "codex" }]
    ]);
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.stdin = {
        writable: true,
        end: vi.fn(),
        write: vi.fn((line) => {
          const message = JSON.parse(line);
          const result = message.method === "initialize"
            ? { userAgent: "test" }
            : rateLimitResult(18);
          queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify({ id: message.id, result })}\n`));
        })
      };
      return child;
    });
    const sshSessionRuntime = { connectClient: vi.fn() };
    const service = createAgentUsageService({
      terminalManager: { getSession: id => sessions.get(id) },
      sshSessionRuntime,
      spawn,
      now: () => 1_000
    });

    await expect(service.getUsage("bridge-1")).resolves.toMatchObject({ limits: [{ usedPercent: 18 }] });
    await expect(service.getUsage("bridge-2")).resolves.toMatchObject({ limits: [{ usedPercent: 18 }] });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", "codex app-server --stdio"], expect.any(Object));
    expect(sshSessionRuntime.connectClient).not.toHaveBeenCalled();
  });

  it("uses the current SSH session connection and closes it after the response", async () => {
    const client = { exec: vi.fn(), end: vi.fn() };
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.writable = true;
    stream.write = vi.fn();
    stream.end = vi.fn();
    stream.signal = vi.fn();
    client.exec.mockImplementation((_command, callback) => callback(undefined, stream));
    const sshSessionRuntime = {
      connectClient: vi.fn(async () => client)
    };

    const transport = await createSshTransport({ id: "ssh-1", type: "ssh" }, sshSessionRuntime);
    transport.write("hello\n");
    transport.close();

    expect(sshSessionRuntime.connectClient).toHaveBeenCalledWith("ssh-1", expect.objectContaining({ actionName: "Codex usage connection" }));
    expect(client.exec).toHaveBeenCalledWith("bash -lic 'exec codex app-server --stdio'", expect.any(Function));
    expect(stream.write).toHaveBeenCalledWith("hello\n");
    expect(stream.end).toHaveBeenCalledTimes(1);
    expect(stream.signal).toHaveBeenCalledWith("TERM");
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("validates the session and cancels an active request when disconnected", async () => {
    const session = { id: "ssh-1", type: "ssh", agentProvider: "codex" };
    const hanging = createProtocolTransport();
    hanging.write = vi.fn();
    hanging.close = vi.fn(() => hanging.emit("close", -1));
    const service = createAgentUsageService({
      terminalManager: { getSession: id => id === session.id ? session : undefined },
      transportFactory: () => hanging
    });

    const request = service.getUsage(session.id);
    await Promise.resolve();
    service.disconnect(session.id);
    await expect(request).rejects.toThrow("exited before returning usage");
    expect(hanging.close).toHaveBeenCalled();
    await expect(service.getUsage("missing")).rejects.toThrow("Session is not running");
  });

  it("rejects CodeBuddy quota outside Windows without starting a transport", async () => {
    const session = { id: "wsl-1", type: "wsl", wslDistro: "Ubuntu", agentProvider: "codebuddy" };
    const transportFactory = vi.fn();
    const service = createAgentUsageService({
      terminalManager: { getSession: () => session },
      transportFactory
    });

    await expect(service.getUsage(session.id)).rejects.toThrow("only available for Windows");
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("accepts a local-bridge SSH CodeBuddy session as a Windows runtime", async () => {
    const session = { id: "bridge-1", type: "ssh", agentLocation: "local", agentProvider: "codebuddy" };
    const events = new EventEmitter();
    const transportFactory = vi.fn(() => ({
      on: (eventName, listener) => events.on(eventName, listener),
      write: vi.fn(() => queueMicrotask(() => events.emit("error", new Error("stop")))),
      close: vi.fn()
    }));
    const service = createAgentUsageService({
      terminalManager: { getSession: () => session },
      transportFactory
    });

    await expect(service.getUsage(session.id)).rejects.toThrow("Unable to start CodeBuddy ACP");
    expect(transportFactory).toHaveBeenCalledWith(session);
  });

  it("hides ChatGPT Codex quota for OpenRouter sessions", async () => {
    const session = { id: "openrouter-1", type: "windows", agentProvider: "codex", codexBackend: "openrouter" };
    const transportFactory = vi.fn();
    const service = createAgentUsageService({ terminalManager: { getSession: () => session }, transportFactory });

    await expect(service.getUsage(session.id)).rejects.toThrow("do not use ChatGPT Codex rate limits");
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("reads CodeBuddy quota for a Codex session using the CodeBuddy backend", async () => {
    const session = { id: "codex-codebuddy-1", type: "wsl", wslDistro: "Ubuntu", agentProvider: "codex", codexBackend: "codebuddy" };
    const events = new EventEmitter();
    const transportFactory = vi.fn(() => ({
      on: (eventName, listener) => events.on(eventName, listener),
      write: vi.fn(() => queueMicrotask(() => events.emit("error", new Error("stop")))),
      close: vi.fn()
    }));
    const service = createAgentUsageService({ terminalManager: { getSession: () => session }, transportFactory });
    await expect(service.getUsage(session.id)).rejects.toThrow("Unable to start CodeBuddy ACP");
    expect(transportFactory).toHaveBeenCalledWith(session);
  });

  it("reads and caches Qoder quota through the SDK client", async () => {
    const session = { id: "qoder-1", type: "windows", cwd: "C:\\repo", agentProvider: "qoder" };
    const close = vi.fn(async () => undefined);
    const query = vi.fn(() => ({
      initializationResult: vi.fn(async () => ({})),
      getUsageInfo: vi.fn(async () => ({
        userType: "pro",
        userQuota: { total: 2000, used: 500, remaining: 1500, percentage: 25 }
      })),
      close
    }));
    const service = createAgentUsageService({
      terminalManager: { getSession: () => session },
      now: () => 1000,
      qoderSdkLoader: async () => ({ query, qodercliAuth: () => ({ type: "qodercli" }) })
    });

    await expect(service.getUsage(session.id)).resolves.toMatchObject({
      provider: "qoder",
      summary: { total: 2000, used: 500, remaining: 1500 }
    });
    await expect(service.getUsage(session.id)).resolves.toMatchObject({ provider: "qoder" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects Qoder quota over SSH before loading the SDK", async () => {
    const session = { id: "qoder-ssh", type: "ssh", cwd: "/srv/app", agentProvider: "qoder" };
    const qoderSdkLoader = vi.fn();
    const service = createAgentUsageService({
      terminalManager: { getSession: () => session },
      qoderSdkLoader
    });

    await expect(service.getUsage(session.id)).rejects.toThrow("only available for Windows and WSL");
    expect(qoderSdkLoader).not.toHaveBeenCalled();
  });
});
