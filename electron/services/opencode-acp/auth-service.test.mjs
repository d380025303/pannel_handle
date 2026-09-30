import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { readAuthMethods, buildAuthInvocation, createOpenCodeAuthService } = require("./auth-service.cjs");
const { createOpenCodeAcpSessionService } = require("./session-service.cjs");
const legacy = { id: "opencode-login", name: "Login with opencode" };
const method = readAuthMethods([legacy])[0];
const session = { id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe", agentProvider: "opencode" };
const context = { session, runtime: {}, environment: { PRIVATE_KEY: "secret" }, authMethods: [method] };

function terminal() {
  const events = new EventEmitter();
  return { events, kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    onData: callback => { events.on("data", callback); return { dispose: () => events.off("data", callback) }; },
    onExit: callback => { events.on("exit", callback); return { dispose: () => events.off("exit", callback) }; } };
}

function fixture(overrides = {}) {
  const term = terminal();
  const reconnect = vi.fn().mockResolvedValue(undefined);
  const spawnTerminal = vi.fn(() => term);
  const broadcast = vi.fn();
  const service = createOpenCodeAuthService({ getContext: () => context, reconnect, spawnTerminal, broadcast, changed: vi.fn(), ...overrides });
  return { service, term, reconnect, spawnTerminal, broadcast };
}

describe("OpenCode terminal authentication", () => {
  it("accepts terminal descriptors and the exact legacy OpenCode method, without guessing others", () => {
    expect(readAuthMethods([legacy, { id: "unknown" }, { id: "agent", type: "agent" },
      { id: "new", type: "terminal", args: ["auth", "login"], env: { PROFILE: "work" } },
      { id: "bad", type: "terminal", args: "login" }, { id: "invalid", type: "terminal", env: { "INVALID-NAME": "x" } }, legacy]))
      .toEqual([method, { id: "new", name: "new", description: "", args: ["auth", "login"], env: { PROFILE: "work" } }]);
  });

  it("quotes arguments literally and uses the ACP directory and environment", () => {
    const value = buildAuthInvocation(context, { ...method, args: ["auth", "login", "a'b; $(bad)"], env: { PRIVATE_KEY: "override" } });
    expect(value.executable).toBe("powershell.exe");
    expect(value.args.at(-1)).toContain("'a''b; $(bad)'");
    expect(value.args).not.toContain("-NonInteractive");
    expect(value).toMatchObject({ cwd: session.cwd, env: { PRIVATE_KEY: "override" } });
  });

  it("uses the matching WSL distribution and exports the descriptor environment", () => {
    const value = buildAuthInvocation({ ...context, session: { ...session, type: "wsl", wslDistro: "Ubuntu", cwd: "/work" } },
      { ...method, env: { LOGIN_PROFILE: "work" } });
    expect(value.args).toEqual(["-d", "Ubuntu", "--cd", "/work", "--", "bash", "-lic", "exec opencode 'auth' 'login'"]);
    expect(value.env.WSLENV).toContain("LOGIN_PROFILE/u");
  });

  it("preserves CMD preparation and protects login arguments from CMD expansion", () => {
    const value = buildAuthInvocation({ ...context, session: { ...session, shell: "cmd.exe", initialCommand: "set PATH=C:\\custom;%PATH%" } },
      { ...method, args: ["auth", "login", "a&b%PATH%"] });
    expect(value.executable).toBe("cmd.exe");
    expect(value.args.at(-1)).toContain("(set PATH=C:\\custom;%PATH%) && powershell.exe");
    const encoded = value.args.at(-1).split(" ").at(-1);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain("'a&b%PATH%'");
  });

  it("runs SSH login remotely but local SSH bridge login in the Windows ACP workspace", () => {
    const remote = buildAuthInvocation({ ...context, session: { ...session, type: "ssh", cwd: "/remote" } }, method);
    expect(remote).toMatchObject({ remote: true });
    expect(remote.command).toContain("opencode");
    const local = buildAuthInvocation({ ...context, session: { ...session, type: "ssh", cwd: "/remote", initialCommand: "remote-command" },
      runtime: { localBridge: true, workspaceCwd: "C:\\bridge", shell: "pwsh.exe" } }, method);
    expect(local).toMatchObject({ executable: "pwsh.exe", cwd: "C:\\bridge" });
    expect(local.args.at(-1)).not.toContain("remote-command");
  });

  it("rejects unknown methods and prevents duplicate starts", async () => {
    const f = fixture();
    await expect(f.service.start("one", "unknown")).rejects.toThrow("未提供");
    const result = await f.service.start("one", method.id);
    await expect(f.service.start("one", method.id)).rejects.toThrow("正在进行");
    expect(f.spawnTerminal).toHaveBeenCalledOnce();
    f.service.cancel("one", result.generation);
    expect(f.term.kill).toHaveBeenCalledOnce();
    expect(f.reconnect).not.toHaveBeenCalled();
  });

  it("forwards terminal data, validates generation and reconnects exactly once only on zero exit", async () => {
    const f = fixture();
    const { generation } = await f.service.start("one", method.id);
    f.term.events.emit("data", "login output");
    expect(f.broadcast).toHaveBeenCalledWith("opencode-auth:data", { id: "one", generation, seq: 1, data: "login output" });
    f.service.write("one", generation - 1, "bad"); f.service.write("one", generation, "ok");
    expect(f.term.write).toHaveBeenCalledExactlyOnceWith("ok");
    f.service.resize("one", generation, 80, 20); f.service.resize("one", generation, -1, 20);
    expect(f.term.resize).toHaveBeenCalledExactlyOnceWith(80, 20);
    f.term.events.emit("exit", { exitCode: 0 }); f.term.events.emit("exit", { exitCode: 0 });
    await vi.waitFor(() => expect(f.service.snapshot("one").status).toBe("succeeded"));
    expect(f.reconnect).toHaveBeenCalledExactlyOnceWith("one", context);
    expect(f.term.events.listenerCount("data")).toBe(0);
  });

  it.each([{ exitCode: 1 }, { exitCode: null }, { exitCode: 0, signal: 2 }, { exitCode: 0, reason: "connection-close" }])
    ("does not reconnect after unsuccessful exit %j", async result => {
      const f = fixture(); await f.service.start("one", method.id);
      f.term.events.emit("exit", result);
      expect(f.service.snapshot("one").status).toBe("failed");
      expect(f.reconnect).not.toHaveBeenCalled();
    });

  it("ignores stale events after cancellation and retries with a new generation", async () => {
    const f = fixture(); const first = await f.service.start("one", method.id);
    f.service.cancel("one", first.generation); f.term.events.emit("exit", { exitCode: 0 });
    expect(f.reconnect).not.toHaveBeenCalled();
    const second = await f.service.start("one", method.id);
    f.service.cancel("one", first.generation);
    expect(f.service.snapshot("one")).toMatchObject({ status: "running", generation: second.generation });
    f.service.shutdown(); expect(f.service.snapshot("one").status).toBe("idle");
  });

  it("cancels a pending remote login and kills any late terminal", async () => {
    let resolve;
    const term = terminal();
    const createInteractiveTransport = vi.fn(() => new Promise(done => { resolve = done; }));
    const f = fixture({ getContext: () => ({ ...context, session: { ...session, type: "ssh", cwd: "/work" } }),
      sshAgentTransport: { createInteractiveTransport } });
    const pending = f.service.start("one", method.id);
    f.service.cancel("one", f.service.snapshot("one").generation);
    expect(createInteractiveTransport.mock.calls[0][1].signal.aborted).toBe(true);
    resolve(term); await pending;
    expect(term.kill).toHaveBeenCalledOnce(); expect(f.reconnect).not.toHaveBeenCalled();
  });

  it("reports reconnect errors without claiming login success", async () => {
    const f = fixture({ reconnect: vi.fn().mockRejectedValue(new Error("offline")) });
    await f.service.start("one", method.id); f.term.events.emit("exit", { exitCode: 0 });
    await vi.waitFor(() => expect(f.service.snapshot("one")).toMatchObject({ status: "failed", error: "登录后重连失败：offline" }));
  });

  it("does not publish success after the owning session closes during reconnect", async () => {
    let resolve;
    const f = fixture({ reconnect: () => new Promise(done => { resolve = done; }) });
    await f.service.start("one", method.id); f.term.events.emit("exit", { exitCode: 0 });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    f.service.close("one"); resolve(); await Promise.resolve();
    expect(f.service.snapshot("one").status).toBe("idle");
    expect(f.broadcast.mock.calls.some(([channel, value]) => channel === "opencode-auth:state" && value.status === "succeeded")).toBe(false);
  });
});

function acpChild(handle) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
  child.stdin.on("data", buffer => handle(JSON.parse(String(buffer)), result => child.stdout.write(`${JSON.stringify(result)}\n`)));
  return child;
}

it("retains auth-required startup, negotiates terminal auth, restores the original history and blocks prompts during login", async () => {
  const messages = [];
  let needsLogin = true;
  const term = terminal();
  const spawn = () => acpChild((message, emit) => {
    messages.push(message);
    const send = result => emit({ id: message.id, result });
    if (message.method === "initialize") send({ agentCapabilities: { loadSession: true }, authMethods: [legacy] });
    else if (message.method === "session/load") {
      if (needsLogin) emit({ id: message.id, error: { code: -32000, message: "Authentication required" } });
      else send({ sessionId: "original", configOptions: [] });
    } else if (message.method === "session/prompt") send({ stopReason: "end_turn" });
  });
  const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) }, broadcast: vi.fn(),
    terminalManager: { getSession: () => session, listSessions: () => [session] }, spawnProcess: spawn, spawnAuthTerminal: () => term });
  await service.start(session, { resumeThreadId: "original" });
  expect(messages[0].params.clientCapabilities).toEqual({ auth: { terminal: true } });
  expect(service.snapshot("one")).toMatchObject({ threadId: null, acpAuth: { required: true, methods: [{ id: method.id }] } });
  expect(service.snapshot("one").acpAuth.methods[0]).not.toHaveProperty("args");
  await service.startAcpLogin("one", method.id);
  expect(service.snapshot("one").busy).toBe(true);
  await expect(service.submit("one", "hello")).rejects.toThrow("登录正在进行");
  needsLogin = false; term.events.emit("exit", { exitCode: 0 });
  await vi.waitFor(() => expect(service.snapshot("one")).toMatchObject({ threadId: "original", busy: false, acpAuth: { status: "succeeded", required: false } }));
  expect(messages.filter(message => message.method === "session/load")).toHaveLength(2);
  expect(messages.some(message => message.method === "authenticate")).toBe(false);
  await service.shutdown();
});

it("keeps the login entry retryable when the replacement ACP process cannot start", async () => {
  let spawnCount = 0;
  const terminals = [];
  const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) }, broadcast: vi.fn(),
    terminalManager: { getSession: () => session, listSessions: () => [session] },
    spawnAuthTerminal: () => { const term = terminal(); terminals.push(term); return term; },
    spawnProcess: () => {
      if (++spawnCount === 2) throw new Error("spawn failed");
      return acpChild((message, emit) => {
        if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true }, authMethods: [legacy] } });
        else if (message.method === "session/new" || message.method === "session/load") emit({ id: message.id, result: { sessionId: "original" } });
      });
    } });
  await service.start(session);
  await service.startAcpLogin("one", method.id); terminals[0].events.emit("exit", { exitCode: 0 });
  await vi.waitFor(() => expect(service.snapshot("one").acpAuth).toMatchObject({ status: "failed", methods: [{ id: method.id }] }));
  expect(service.snapshot("one").busy).toBe(false);
  await service.startAcpLogin("one", method.id); terminals[1].events.emit("exit", { exitCode: 0 });
  await vi.waitFor(() => expect(service.snapshot("one")).toMatchObject({ threadId: "original", acpAuth: { status: "succeeded" } }));
  await service.shutdown();
});

it("restores the selected model, mode and effort after terminal login", async () => {
  const target = { ...session, openCodeGraphicalOptions: { model: "openai/other", mode: "plan", effort: "high" } };
  const changes = [];
  const term = terminal();
  const options = () => [
    { id: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
    { id: "model", type: "select", currentValue: "openai/default", options: [{ value: "openai/default", name: "Default" }, { value: "openai/other", name: "Other" }] },
    { id: "effort", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] }
  ];
  const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) }, broadcast: vi.fn(),
    terminalManager: { getSession: () => target, listSessions: () => [target] }, spawnAuthTerminal: () => term,
    spawnProcess: () => {
      let configOptions = options();
      return acpChild((message, emit) => {
        const result = value => emit({ id: message.id, result: value });
        if (message.method === "initialize") result({ agentCapabilities: { loadSession: true }, authMethods: [legacy] });
        else if (message.method === "session/new" || message.method === "session/load") result({ sessionId: "original", configOptions });
        else if (message.method === "session/set_config_option") {
          changes.push(message.params); configOptions = configOptions.map(option => option.id === message.params.configId ? { ...option, currentValue: message.params.value } : option);
          result({ configOptions });
        }
      });
    } });
  await service.start(target); changes.length = 0;
  await service.startAcpLogin("one", method.id); term.events.emit("exit", { exitCode: 0 });
  await vi.waitFor(() => expect(service.snapshot("one").acpAuth.status).toBe("succeeded"));
  expect(changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ configId: "mode", value: "plan" }),
    expect.objectContaining({ configId: "model", value: "openai/other" }),
    expect.objectContaining({ configId: "effort", value: "high" })
  ]));
  await service.shutdown();
});
