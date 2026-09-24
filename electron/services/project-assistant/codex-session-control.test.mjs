import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCodexSessionControl } = require("./codex-session-control.cjs");

function fixture() {
  const sessions = new Map([
    ["codex-1", { id: "codex-1", title: "Code", type: "windows", cwd: "C:\\work", agentProvider: "codex", agentStatus: "running", term: { write() {} } }],
    ["shell-1", { id: "shell-1", title: "Shell", type: "windows", agentProvider: null, term: { write() {} } }]
  ]);
  const terminalManager = {
    getSession: vi.fn(id => sessions.get(id)),
    listSessions: vi.fn(() => [...sessions.values()]),
    write: vi.fn()
  };
  const stateHub = {
    getSnapshot: vi.fn(async id => ({ sessionId: id, ansi: "hello", seq: 3, cols: 80, rows: 24 })),
    getDeltas: vi.fn(() => [{ seq: 4, data: "next" }]),
    getText: vi.fn(async () => "Current work")
  };
  const conversationManager = { getTurn: vi.fn(() => ({ messages: [{ kind: "commentary", text: "Checking", timestamp: 1 }] })) };
  const delay = vi.fn(async () => {});
  return { control: createCodexSessionControl({ terminalManager, stateHub, conversationManager, delay }), sessions, terminalManager, stateHub, delay };
}

describe("Codex session control", () => {
  it("returns a screen, ordered deltas, and bounded context for the selected live Codex session", async () => {
    const f = fixture();
    expect(f.control.listSessions()).toEqual([{ id: "codex-1", title: "Code", type: "windows", cwd: "C:\\work", status: "running" }]);
    expect(await f.control.getScreen("codex-1")).toMatchObject({ ansi: "hello", seq: 3 });
    expect(f.control.getDeltas("codex-1", 3)).toEqual([{ seq: 4, data: "next" }]);
    expect(await f.control.getContext("codex-1")).toMatchObject({ screenText: "Current work", messages: [{ text: "Checking" }] });
  });

  it("submits text to only the chosen instance, then validates it again before Enter", async () => {
    const f = fixture();
    f.delay.mockImplementation(async () => { f.sessions.get("codex-1").agentStatus = "ended"; });
    await expect(f.control.submit("codex-1", "answer")).rejects.toThrow("已结束");
    expect(f.terminalManager.write).toHaveBeenCalledTimes(1);
    expect(f.terminalManager.write).toHaveBeenCalledWith("codex-1", "answer");
    expect(() => f.control.write("shell-1", "unsafe")).toThrow("已结束");
    expect(() => f.control.switchMode("codex-1")).toThrow("已结束");
  });

  it("sends the Codex mode key and rejects an unavailable SSH session", async () => {
    const f = fixture();
    f.control.switchMode("codex-1");
    expect(f.terminalManager.write).toHaveBeenCalledWith("codex-1", "\x1b[Z");
    const ssh = f.sessions.get("codex-1");
    ssh.type = "ssh";
    ssh.sshConnectionState = "reconnecting";
    await expect(f.control.getScreen("codex-1")).rejects.toThrow("尚未连接");
  });
});
