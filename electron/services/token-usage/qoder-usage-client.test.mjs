import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createQoderProcessSpawner,
  normalizeQoderUsage,
  readQoderUsage,
  windowsPathToWsl
} = require("./qoder-usage-client.cjs");

function usageInfo() {
  return {
    userType: "pro",
    totalUsagePercentage: 30,
    expiresAt: 2_000_000_000_000,
    userQuota: { total: 2000, used: 500, remaining: 1500, percentage: 25, unit: "credits" },
    addOnQuota: { total: 300, used: 100, remaining: 200, percentage: 33, unit: "credits" },
    orgResourcePackage: { cap: 1000, used: 200, remaining: 800, percentage: 20, available: true, unit: "credits" }
  };
}

function childProcess() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  return child;
}

describe("qoder-usage-client", () => {
  it("normalizes plan, add-on, and organization quota into a spendable summary", () => {
    expect(normalizeQoderUsage(usageInfo(), 1234)).toEqual({
      provider: "qoder",
      fetchedAt: 1234,
      primaryLimitId: "qoder-total",
      summary: {
        kind: "credits",
        total: 3300,
        used: 800,
        remaining: 2500,
        usedPercent: 30,
        remainingPercent: 70,
        unit: "Credits"
      },
      limits: [
        expect.objectContaining({ id: "qoder-plan", name: "pro", category: "base", remainingAmount: 1500, expiresAt: 2_000_000_000_000 }),
        expect.objectContaining({ id: "qoder-addon", category: "extra", remainingAmount: 200 }),
        expect.objectContaining({ id: "qoder-organization", category: "organization", remainingAmount: 800, available: true })
      ]
    });
  });

  it("does not count an unavailable organization bucket and rejects missing values", () => {
    const normalized = normalizeQoderUsage({
      ...usageInfo(),
      totalUsagePercentage: undefined,
      orgResourcePackage: { cap: 1000, used: 200, remaining: 800, available: false }
    }, 10);
    expect(normalized.summary).toMatchObject({ total: 2300, used: 600, remaining: 1700, usedPercent: 26, remainingPercent: 74 });
    expect(normalized.limits.at(-1)).toMatchObject({ available: false });
    expect(normalizeQoderUsage({ ...usageInfo(), isQuotaExceeded: true }).summary).toMatchObject({
      usedPercent: 100,
      remainingPercent: 0
    });
    expect(() => normalizeQoderUsage({ userQuota: { total: 10, remaining: 10 } })).toThrow("usable account quota");
    expect(() => normalizeQoderUsage(null)).toThrow("sign in or update");
  });

  it("builds Windows and WSL SDK process launches without forwarding the Windows environment", () => {
    const windowsChild = childProcess();
    const wslChild = childProcess();
    const spawn = vi.fn()
      .mockReturnValueOnce(windowsChild)
      .mockReturnValueOnce(wslChild);
    const terminate = vi.fn(() => true);
    const options = {
      command: "ignored",
      args: ["--print", "--input-format", "stream-json"],
      cwd: "C:\\repo",
      env: { PATH: "windows-only", QODER_AGENT_SDK_VERSION: "1", QODER_SDK_AUTH_PAYLOAD_FILE: "C:\\Temp\\auth\\payload.json" },
      signal: new AbortController().signal
    };

    const windows = createQoderProcessSpawner({ type: "windows" }, { spawn, terminateProcessTree: terminate })(options);
    expect(spawn).toHaveBeenNthCalledWith(1, "cmd.exe", ["/d", "/s", "/c", "qoder", ...options.args], expect.objectContaining({ cwd: "C:\\repo", env: options.env }));
    windows.kill("SIGTERM");
    expect(terminate).toHaveBeenCalledWith(windowsChild);

    createQoderProcessSpawner({ type: "wsl", wslDistro: "Ubuntu", cwd: "/srv/app" }, { spawn, terminateProcessTree: terminate })({
      ...options,
      cwd: "/srv/app"
    });
    const wslArgs = spawn.mock.calls[1][1];
    expect(wslArgs.slice(0, 7)).toEqual(["-d", "Ubuntu", "--cd", "/srv/app", "--", "env", "QODER_AGENT_SDK_VERSION=1"]);
    expect(wslArgs).toContain("QODER_SDK_AUTH_PAYLOAD_FILE=/mnt/c/Temp/auth/payload.json");
    expect(wslArgs.join(" ")).not.toContain("windows-only");
    expect(windowsPathToWsl("D:\\Users\\me\\payload.json")).toBe("/mnt/d/Users/me/payload.json");
  });

  it("uses the official SDK control request and always closes the temporary session", async () => {
    const close = vi.fn(async () => undefined);
    const initializationResult = vi.fn(async () => ({ account: {} }));
    const getUsageInfo = vi.fn(async () => usageInfo());
    const query = vi.fn(() => ({ initializationResult, getUsageInfo, close }));
    const qodercliAuth = vi.fn(() => ({ type: "qodercli" }));

    await expect(readQoderUsage({
      session: { type: "windows", cwd: "C:\\repo" },
      signal: new AbortController().signal,
      timeoutMs: 1000,
      now: () => 99,
      sdkLoader: async () => ({ query, qodercliAuth }),
      spawn: vi.fn()
    })).resolves.toMatchObject({ provider: "qoder", fetchedAt: 99, summary: { remaining: 2500 } });

    expect(qodercliAuth).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].options).toMatchObject({
      persistSession: false,
      permissionMode: "dontAsk",
      settingSources: [],
      skills: [],
      tools: [],
      pathToQoderCLIExecutable: "qoder"
    });
    expect(initializationResult).toHaveBeenCalledTimes(1);
    expect(getUsageInfo).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
