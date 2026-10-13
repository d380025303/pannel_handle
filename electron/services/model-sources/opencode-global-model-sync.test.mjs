import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { parse } = require("jsonc-parser");
const { createOpenCodeGlobalModelSync } = require("./opencode-global-model-sync.cjs");
const directories = [];
afterEach(() => { vi.restoreAllMocks(); while (directories.length) rmSync(directories.pop(), { recursive: true, force: true }); });

function fixture(source = "openrouter") {
  const root = mkdtempSync(path.join(tmpdir(), "pannel-opencode-sync-"));
  directories.push(root);
  const home = path.join(root, "home");
  const userDataDir = path.join(root, "app");
  const configDir = path.join(home, ".config", "opencode");
  const authDir = path.join(home, ".local", "share", "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  const config = path.join(configDir, "opencode.jsonc");
  const auth = path.join(authDir, "auth.json");
  writeFileSync(config, '{\n  // user setting\n  "theme": "dark"\n}\n');
  writeFileSync(auth, '{"another":{"type":"api","key":"unrelated"}}\n');
  const state = { models: [{ id: "vendor/coder", name: "Coder" }], verified: { "vendor/coder": { status: "passed" } }, key: "secret" };
  const store = { getCachedModels: () => state.models, getAgentModelVerifications: () => state.verified, getApiKey: () => state.key };
  const empty = { getCachedModels: () => [], getAgentModelVerifications: () => ({}), getApiKey: () => "" };
  const createSync = (options = {}) => createOpenCodeGlobalModelSync({ home, userDataDir,
    stores: { openrouter: empty, nararouter: empty, minimax: empty, [source]: store }, ...options });
  const sync = createSync();
  return { root, state, sync, createSync, config, auth };
}

describe("OpenCode global model sync", () => {

  it("keeps timers responsive during a real 1500ms child process", async () => {
    const f = fixture();
    const command = vi.fn((_file, _args, options, callback) => execFile(process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('invalid'), 1500)"], options, callback));
    const started = performance.now();
    const pending = f.createSync({ wslCommand: command }).syncWsl("Ubuntu");
    const outcome = expect(pending).rejects.toThrow("配置目录无效");
    const timerElapsed = await new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 10));
    expect(timerElapsed).toBeLessThan(500);
    const peer = spawn(process.execPath, ["-e", "process.on('message', value => process.send(value))"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    try {
      const reply = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("IPC response timed out")), 1000);
        peer.once("message", value => { clearTimeout(timeout); resolve(value); });
        peer.send("ping");
      });
      expect(reply).toBe("ping");
      expect(performance.now() - started).toBeLessThan(1500);
    } finally { peer.kill(); }
    await outcome;
    expect(performance.now() - started).toBeGreaterThanOrEqual(1500);
    expect(command).toHaveBeenCalledWith("wsl.exe", ["-d", "Ubuntu", "--", "sh", "-lc",
      "printf '%s\\n%s' \"${XDG_CONFIG_HOME:-$HOME/.config}\" \"${XDG_DATA_HOME:-$HOME/.local/share}\""],
      { encoding: "utf8", windowsHide: true, timeout: 10000 }, expect.any(Function));
  });

  it("parses CRLF directory output and selects an existing JSONC configuration", async () => {
    const f = fixture();
    const config = path.join("\\\\wsl.localhost\\Ubuntu\\custom config\\opencode", "opencode.jsonc");
    const originalRead = fs.readFileSync;
    const marker = new Error("reached parsed config");
    vi.spyOn(fs, "existsSync").mockImplementation(file => file === config);
    const reads = vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
      if (file === config) throw marker;
      return originalRead(file, ...args);
    });
    await expect(f.createSync({ wslCommand: (_file, _args, _options, callback) =>
      callback(null, " /custom config\r\n /custom data \n") }).syncWsl("Ubuntu")).rejects.toBe(marker);
    expect(reads).toHaveBeenCalledWith(config, "utf8");
  });

  it.each(["relative\n/data", "/config", ""])("rejects invalid directories (%s)", async stdout => {
    const f = fixture();
    await expect(f.createSync({ wslCommand: (_file, _args, _options, callback) => callback(null, stdout) })
      .syncWsl("Ubuntu")).rejects.toThrow("配置目录无效");
  });

  it.each([Object.assign(new Error("timeout"), { killed: true }), Object.assign(new Error("exit"), { code: 1 }),
    Object.assign(new Error("missing"), { code: "ENOENT" })])("preserves command failure handling (%s)", async error => {
    const f = fixture();
    await expect(f.createSync({ wslCommand: (_file, _args, _options, callback) => callback(error, "/config\n/data") })
      .syncWsl("Ubuntu")).rejects.toThrow("无法读取 WSL Ubuntu 的 OpenCode 配置目录");
  });

  it("rejects an invalid distro without starting a command", async () => {
    const command = vi.fn();
    await expect(fixture().createSync({ wslCommand: command }).syncWsl("Ubuntu;pwd")).rejects.toThrow("无效的 WSL");
    expect(command).not.toHaveBeenCalled();
  });

  it.each(["nararouter", "minimax"])("restores %s models after all verifications fail, preserving user models and credentials", source => {
    const f = fixture(source);
    writeFileSync(f.config, "{}\n");
    const auth = JSON.stringify({ [source]: { type: "api", key: "user-key" } });
    writeFileSync(f.auth, auth);
    f.sync.syncWindows();
    const config = parse(readFileSync(f.config, "utf8"));
    config.providers[source].models["user/model"] = { name: "User model", limit: { context: 32768 } };
    writeFileSync(f.config, JSON.stringify(config));
    f.state.verified["vendor/coder"].status = "failed";
    f.createSync().syncWindows();
    const cleared = parse(readFileSync(f.config, "utf8")).providers[source];
    expect(cleared.models).toEqual({ "user/model": config.providers[source].models["user/model"] });
    const manifest = JSON.parse(readFileSync(path.join(f.root, "app", "opencode-managed-models.json"), "utf8"));
    expect(manifest.windows[source]).toMatchObject({ models: [], providerOwned: true });
    f.state.verified["vendor/coder"].status = "passed";
    f.createSync().syncWindows();
    expect(parse(readFileSync(f.config, "utf8")).providers[source].models).toEqual(config.providers[source].models);
    expect(readFileSync(f.auth, "utf8")).toBe(auth);

    // Provider ownership must not allow overwriting a model added by the user.
    f.state.models.push({ id: "user/model", name: "Replacement" });
    f.state.verified["user/model"] = { status: "passed" };
    const before = readFileSync(f.config, "utf8");
    expect(() => f.createSync().syncWindows()).toThrow("用户模型");
    expect(readFileSync(f.config, "utf8")).toBe(before);
    expect(readFileSync(f.auth, "utf8")).toBe(auth);
  });

  it.each(["nararouter", "minimax"])("protects an existing user %s provider", source => {
    const f = fixture(source);
    const config = JSON.stringify({ providers: { [source]: { settings: { baseURL: "https://user.example" }, models: {} } } });
    writeFileSync(f.config, config);
    const auth = readFileSync(f.auth, "utf8");
    f.state.verified["vendor/coder"].status = "failed";
    f.sync.syncWindows();
    f.state.verified["vendor/coder"].status = "passed";
    expect(() => f.sync.syncWindows()).toThrow(`已有 ${source} 用户配置`);
    expect(readFileSync(f.config, "utf8")).toBe(config);
    expect(readFileSync(f.auth, "utf8")).toBe(auth);
  });

  it.each(["nararouter", "minimax"])("migrates legacy %s ownership before clearing models", source => {
    for (const entry of [["vendor/coder"], { models: ["vendor/coder"], authOwned: false }]) {
      const f = fixture(source);
      f.sync.syncWindows();
      const manifest = path.join(f.root, "app", "opencode-managed-models.json");
      writeFileSync(manifest, JSON.stringify({ windows: { [source]: entry } }));
      f.state.verified["vendor/coder"].status = "failed";
      f.createSync().syncWindows();
      f.state.verified["vendor/coder"].status = "passed";
      f.createSync().syncWindows();
      expect(parse(readFileSync(f.config, "utf8")).providers[source].models["vendor/coder"].name).toBe("Coder");
    }
  });

  it("updates managed context limits while preserving model settings and comments", () => {
    const f = fixture();
    f.state.models[0].contextLength = 1000000;
    f.sync.syncWindows();
    let config = readFileSync(f.config, "utf8");
    expect(parse(config).providers.openrouter.models["vendor/coder"].limit.context).toBe(1000000);
    config = config.replace('"context": 1000000', '"context": 1000000,\n          // user output limit\n          "output": 8192');
    writeFileSync(f.config, config);
    f.state.models[0].contextLength = 200000;
    f.sync.syncWindows();
    config = readFileSync(f.config, "utf8");
    expect(parse(config).providers.openrouter.models["vendor/coder"].limit).toEqual({ context: 200000, output: 8192 });
    expect(config).toContain("// user output limit");
    expect(config).toContain("// user setting");
  });

  it.each([undefined, 0, 0.5, -1, NaN, Infinity])("omits invalid context limits (%s)", contextLength => {
    const f = fixture();
    f.state.models[0].contextLength = contextLength;
    f.sync.syncWindows();
    expect(parse(readFileSync(f.config, "utf8")).providers.openrouter.models["vendor/coder"].limit).toBeUndefined();
  });

  it("does not overwrite unmanaged models", () => {
    const f = fixture();
    writeFileSync(f.config, JSON.stringify({ providers: { openrouter: { models: { "vendor/coder": { limit: { context: 32768 } } } } } }));
    f.state.models[0].contextLength = 1000000;
    expect(() => f.sync.syncWindows()).toThrow("用户模型");
    expect(parse(readFileSync(f.config, "utf8")).providers.openrouter.models["vendor/coder"].limit.context).toBe(32768);
  });

  it("registers verified models without favorites and preserves user configuration and credentials", () => {
    const f = fixture();
    f.sync.syncWindows();
    const config = readFileSync(f.config, "utf8");
    expect(config).toContain("// user setting");
    expect(JSON.parse(readFileSync(f.auth, "utf8"))).toEqual({ another: { type: "api", key: "unrelated" } });
    expect(config).toContain('"vendor/coder"');
    expect(config).not.toContain("secret");
    f.state.verified["vendor/coder"] = { status: "failed" };
    f.sync.syncWindows();
    expect(readFileSync(f.config, "utf8")).not.toContain('"vendor/coder"');
    expect(JSON.parse(readFileSync(f.auth, "utf8"))).toEqual({ another: { type: "api", key: "unrelated" } });
  });

  it("preserves an existing user's provider credential", () => {
    const f = fixture();
    writeFileSync(f.auth, '{"openrouter":{"type":"api","key":"other"}}\n');
    f.sync.syncWindows();
    expect(JSON.parse(readFileSync(f.auth, "utf8")).openrouter.key).toBe("other");
    expect(readFileSync(f.config, "utf8")).toContain('"vendor/coder"');
  });

  it("removes only a matching legacy credential previously owned by the app", () => {
    const f = fixture();
    mkdirSync(path.join(f.root, "app"), { recursive: true });
    writeFileSync(path.join(f.root, "app", "opencode-managed-models.json"), JSON.stringify({
      windows: { openrouter: { models: ["vendor/coder"], authOwned: true } }
    }));
    writeFileSync(f.auth, '{"openrouter":{"type":"api","key":"secret"},"another":{"type":"api","key":"unrelated"}}\n');
    f.sync.syncWindows();
    expect(JSON.parse(readFileSync(f.auth, "utf8"))).toEqual({ another: { type: "api", key: "unrelated" } });
  });

  it("uses OpenCode v2 provider fields for a custom model service", () => {
    const f = fixture();
    f.state.verified = {};
    const custom = { getCachedModels: () => [{ id: "coder", name: "Coder" }],
      getAgentModelVerifications: () => ({ coder: { status: "passed" } }), getApiKey: () => "custom-key" };
    const empty = { getCachedModels: () => [], getAgentModelVerifications: () => ({}), getApiKey: () => "" };
    const sync = createOpenCodeGlobalModelSync({ home: path.join(f.root, "home"), userDataDir: path.join(f.root, "app2"),
      stores: { openrouter: empty, nararouter: custom, minimax: empty } });
    sync.syncWindows();
    const config = readFileSync(f.config, "utf8");
    expect(config).toContain('"providers"');
    expect(config).toContain('"package": "@opencode/ai/providers/openai-compatible"');
    expect(config).toContain('"env": [');
    expect(config).toContain('"NARAROUTER_API_KEY"');
    expect(config).toContain('"baseURL": "https://router.bynara.id/v1"');
    expect(config).not.toContain("custom-key");
    expect(JSON.parse(readFileSync(f.auth, "utf8")).nararouter).toBeUndefined();
  });
  it("registers MiniMax with the native credential name", () => {
    const f = fixture();
    const minimax = { getCachedModels: () => [{ id: "MiniMax-M3", name: "MiniMax-M3", contextLength: 1000000 }],
      getAgentModelVerifications: () => ({ "MiniMax-M3": { status: "passed" } }), getApiKey: () => "secret" };
    const empty = { getCachedModels: () => [], getAgentModelVerifications: () => ({}), getApiKey: () => "" };
    createOpenCodeGlobalModelSync({ home: path.join(f.root, "home"), userDataDir: path.join(f.root, "app2"),
      stores: { openrouter: empty, nararouter: empty, minimax } }).syncWindows();
    expect(readFileSync(f.config, "utf8")).toContain('"MINIMAX_API_KEY"');
    expect(parse(readFileSync(f.config, "utf8")).providers.minimax.models["MiniMax-M3"].limit.context).toBe(1000000);
    expect(readFileSync(f.config, "utf8")).not.toContain("secret");
  });
});
