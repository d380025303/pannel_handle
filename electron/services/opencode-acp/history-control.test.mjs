import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const require = createRequire(import.meta.url);
const { createOpenCodeAcpSessionService } = require("./session-service.cjs");
const { runOpenCodeHistoryControl } = require("./history-control.cjs");
const services = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.shutdown())); });
function fixture({ version = "2.0.18" } = {}) {
  let boundary = null;
  const stored = [{ id: "msg_first", type: "user", text: "First" }, { id: "msg_second", type: "user", text: "Second" }];
  const controls = [];
  const checkpoint = vi.fn();
  let failStage = false, failRead = false;
  const service = createOpenCodeAcpSessionService({
    environmentService: { resolve: () => ({}) }, terminalManager: { broadcastAgentStatus: vi.fn() },
    broadcast: vi.fn(), onTokenUsageCheckpoint: checkpoint,
    openCodeControl: async value => {
      controls.push(value);
      if (value.operation === "version") return version;
      if (value.operation === "session.get") {
        if (failRead) throw new Error("offline");
        return { id: value.threadId, revert: boundary ? { messageID: boundary } : undefined };
      }
      if (value.operation === "session.message.list") return [...stored].reverse();
      if (value.operation === "session.revert.stage") {
        boundary = value.body.messageID;
        if (failStage) throw new Error("file restore failed");
      }
      if (value.operation === "session.revert.clear") boundary = null;
      if (value.operation === "session.revert.commit") { stored.splice(stored.findIndex(value => value.id === boundary)); boundary = null; }
    },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
      const emit = value => child.stdout.write(JSON.stringify(value) + "\n");
      child.stdin.on("data", chunk => {
        const call = JSON.parse(String(chunk));
        const reply = result => emit({ id: call.id, result });
        if (call.method === "initialize") reply({ agentCapabilities: { loadSession: true } });
        else if (call.method === "session/list") reply({ sessions: [{ sessionId: "ses_active", cwd: "C:\\work" }, { sessionId: "ses_history", cwd: "C:\\work" }] });
        else if (call.method === "session/new") reply({ sessionId: "ses_active" });
        else if (call.method === "session/load") {
          for (const row of stored) emit({ method: "session/update", params: { sessionId: call.params.sessionId,
            update: { sessionUpdate: "user_message_chunk", messageId: row.id, content: { type: "text", text: row.text } } } });
          reply({ sessionId: call.params.sessionId });
        } else if (call.method === "session/prompt") reply({ stopReason: "end_turn" });
      });
      return child;
    }
  });
  services.push(service);
  return { service, controls, checkpoint, stored, fail: () => { failStage = true; }, offline: () => { failRead = true; },
    start: async () => { await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" }); await service.listHistory("one"); await service.resume("one", "ses_active"); } };
}
it("stages consecutive native message boundaries, restores and commits before a new prompt", async () => {
  const f = fixture(); await f.start();
  expect(f.service.snapshot("one").items.map(item => item.rewindMessageId)).toEqual(["msg_first", "msg_second"]);
  const staged = await f.service.revertThread("one", "msg_second");
  expect(staged).toMatchObject({ busy: false, openCodeRevert: { messageID: "msg_second" } });
  expect(staged.items.map(item => item.text)).toEqual(["First"]);
  await f.service.revertThread("one", "msg_first");
  expect(f.service.snapshot("one").items).toEqual([]);
  await f.service.restoreThread("one");
  expect(f.service.snapshot("one").items.map(item => item.text)).toEqual(["First", "Second"]);
  await f.service.revertThread("one", "msg_second");
  await f.service.submit("one", "Replacement");
  expect(f.controls.some(value => value.operation === "session.revert.commit")).toBe(true);
  expect(f.service.snapshot("one").openCodeRevert).toBeNull();
  expect(f.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ resumed: true }));
});
it("renames only listed project history and rejects stale message IDs", async () => {
  const f = fixture(); await f.start();
  await f.service.renameThread("one", "ses_history", " New title ");
  expect(f.controls.at(-1)).toMatchObject({ operation: "session.update", threadId: "ses_history", body: { title: "New title" } });
  await expect(f.service.renameThread("one", "ses_other", "Title")).rejects.toThrow("当前项目");
  await expect(f.service.renameThread("one", "ses_history", " ")).rejects.toThrow("字符");
  await expect(f.service.revertThread("one", "msg_other")).rejects.toThrow("失效");
});
it("reads the actual staged boundary after a partial file failure", async () => {
  const f = fixture(); await f.start(); f.fail();
  await expect(f.service.revertThread("one", "msg_second")).rejects.toThrow("file restore failed");
  expect(f.service.snapshot("one")).toMatchObject({ busy: false, openCodeRevert: { messageID: "msg_second" } });
});
it("disables controls when state reading fails", async () => {
  const f = fixture(); f.offline(); await f.start();
  expect(f.service.snapshot("one").capabilities).toMatchObject({ revertHistory: false, renameHistory: false });
});
it("does not invent a message ID when stored text differs from the submitted prompt", async () => {
  const f = fixture(); await f.start(); await f.service.submit("one", "Different");
  expect(f.service.snapshot("one").items.at(-1).rewindMessageId).toBeUndefined();
});
it("reads an original ID after a prompt without a live user chunk", async () => {
  const f = fixture(); await f.start(); f.stored.push({ type: "user", id: "msg_third", text: "Third" });
  await f.service.submit("one", "Third");
  expect(f.service.snapshot("one").items.at(-1).rewindMessageId).toBe("msg_third");
});
it("quotes remote JSON bodies and rejects unlisted control operations", async () => {
  const exec = vi.fn(async () => "");
  await runOpenCodeHistoryControl({ session: { id: "ssh", type: "ssh", cwd: "/work" }, sshAgentTransport: { exec },
    operation: "session.update", threadId: "ses_remote", body: { title: "title'; touch /tmp/should-not-exist; '" } });
  expect(exec.mock.calls[0][1]).toContain("--standalone");
  expect(exec.mock.calls[0][1]).toContain("\\''");
  await expect(runOpenCodeHistoryControl({ operation: "session.delete", threadId: "ses_remote" })).rejects.toThrow("无效");
});

it("passes WSL actions through its distro with inherited environment and quoted JSON", async () => {
  const spawn = vi.fn(() => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    queueMicrotask(() => { child.stdout.write('{"data":{"id":"ses_wsl"}}'); child.emit("close", 0); });
    return child;
  });
  const result = await runOpenCodeHistoryControl({ session: { type: "wsl", wslDistro: "Ubuntu", cwd: "/work dir" },
    environment: { API_KEY: "secret", PANNEL_HANDLE_HOOK_URL: "http://unused" }, operation: "session.get", threadId: "ses_wsl", spawn });
  expect(result.id).toBe("ses_wsl");
  expect(spawn.mock.calls[0][0]).toBe("wsl.exe");
  expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["Ubuntu", "bash", "-lic"]));
  expect(spawn.mock.calls[0][1].at(-1)).toContain("cd '/work dir'");
  expect(spawn.mock.calls[0][2].env.WSLENV).toContain("API_KEY/u");
  expect(spawn.mock.calls[0][2].env.PANNEL_HANDLE_HOOK_URL).toBeUndefined();
});
it("rejects an API error object even when the CLI exits successfully", async () => {
  await expect(runOpenCodeHistoryControl({ session: { id: "ssh", type: "ssh", cwd: "/work" },
    sshAgentTransport: { exec: async () => JSON.stringify({ _tag: "SessionBusyError", message: "busy" }) },
    operation: "session.revert.clear", threadId: "ses_remote" })).rejects.toThrow("busy");
});
it("sanitizes remote command failures", async () => {
  await expect(runOpenCodeHistoryControl({ session: { id: "ssh", type: "ssh", cwd: "/work" }, environment: { API_KEY: "secret-value" },
    sshAgentTransport: { exec: async () => { throw new Error("failed secret-value"); } },
    operation: "session.get", threadId: "ses_remote" })).rejects.not.toThrow("secret-value");
});

it("keeps the staged revert after closing and loading the saved session", async () => {
  const f = fixture(); await f.start(); await f.service.revertThread("one", "msg_second");
  await f.service.close("one"); await f.start();
  expect(f.service.snapshot("one")).toMatchObject({ openCodeRevert: { messageID: "msg_second" } });
  expect(f.service.snapshot("one").items.map(item => item.text)).toEqual(["First"]);
  await f.service.restoreThread("one");
  expect(f.service.snapshot("one").items).toHaveLength(2);
});
it("disables history actions on an older installed OpenCode version", async () => {
  const f = fixture({ version: "1.3.17" }); await f.start();
  expect(f.service.snapshot("one").capabilities.revertHistory).toBe(false);
  expect(f.service.snapshot("one").historyActionsError).toContain("V2.0.18");
  await expect(f.service.revertThread("one", "msg_first")).rejects.toThrow("升级");
});
