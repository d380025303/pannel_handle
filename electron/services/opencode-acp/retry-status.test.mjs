import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const require = createRequire(import.meta.url);
const { createOpenCodeAcpSessionService } = require("./session-service.cjs");
const { toMobileGraphicalSnapshot } = require("../mobile-remote/mobile-graphical-snapshot.cjs");

it.each(["success", "failure", "stop", "exit"])("tracks and clears retry status on %s", async outcome => {
  let child;
  let promptId;
  const emit = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  const spawnProcess = () => {
    child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    child.stdin.on("data", chunk => {
      const message = JSON.parse(String(chunk));
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
      if (message.method === "session/new" || message.method === "session/load") emit({ id: message.id, result: { sessionId: "thread" } });
      if (message.method === "session/prompt") promptId = message.id;
      if (message.method === "session/cancel") emit({ id: promptId, result: { stopReason: "cancelled" } });
    });
    return child;
  };
  const session = { id: "one", type: "windows", cwd: process.cwd(), shell: "powershell.exe" };
  const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({ API_KEY: "secret-marker" }) },
    terminalManager: { broadcastAgentStatus: vi.fn(), getSession: () => session, listSessions: () => [session] }, broadcast: vi.fn(), spawnProcess });
  const update = (retry, sessionId = "thread") => emit({ method: "session/update", params: { sessionId,
    update: { sessionUpdate: "session_info_update", _meta: { "opencode/retry": retry } } } });
  try {
    await service.start(session);
    update({ attempt: 1 });
    expect(service.snapshot("one").openCodeRetry).toBeNull();
    const prompt = service.submit("one", "hello");
    const retry = { attempt: 1, nextRetryAt: "2099-10-02T12:00:05.000Z", error: { type: "provider.rate-limit", message: "secret-marker", status: 429, response: { body: "private" } } };
    update(retry, "old-thread");
    expect(service.snapshot("one").openCodeRetry).toBeNull();
    update(retry);
    expect(service.snapshot("one")).toMatchObject({ busy: true, error: null, openCodeRetry: { attempt: 1, error: { message: "[已隐藏]", status: 429 } } });
    expect(JSON.stringify(toMobileGraphicalSnapshot(service.snapshot("one")))).not.toContain("private");
    emit({ method: "session/update", params: { sessionId: "thread", update: { sessionUpdate: "session_info_update" } } });
    update({ attempt: -1 });
    expect(service.snapshot("one").openCodeRetry.attempt).toBe(1);
    update(null);
    expect(service.snapshot("one").openCodeRetry).toBeNull();
    update({ ...retry, attempt: 2, nextRetryAt: "invalid" });
    expect(service.snapshot("one").openCodeRetry.nextRetryAt).toBeNull();
    if (outcome === "stop") service.interrupt("one");
    else if (outcome === "exit") child.emit("error", new Error("exited"));
    else emit({ id: promptId, ...(outcome === "failure" ? { error: { message: "failed" } } : { result: { stopReason: "end_turn" } }) });
    if (outcome === "failure" || outcome === "exit") await expect(prompt).rejects.toThrow();
    else await prompt;
    update(retry);
    expect(service.snapshot("one").openCodeRetry).toBeNull();
    if (outcome === "success") {
      const nextPrompt = service.submit("one", "again");
      expect(service.snapshot("one").openCodeRetry).toBeNull();
      update(retry);
      expect(service.snapshot("one").openCodeRetry.attempt).toBe(1);
      service.interrupt("one");
      update(retry);
      expect(service.snapshot("one").openCodeRetry).toBeNull();
      await nextPrompt;
      await service.restart("one");
      expect(service.snapshot("one").openCodeRetry).toBeNull();
    }
  } finally { service.close("one"); }
});
