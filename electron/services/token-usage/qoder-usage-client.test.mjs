import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createQoderProcessSpawner,
  normalizeQoderActivities,
  normalizeQoderUsage,
  readQoderActivities,
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

  it("normalizes active quotas as Credits and merges them into summary", () => {
    expect(normalizeQoderActivities({ data: { activities: [{
      activityId: "qwen38_800_invoke",
      modelName: "Qwen3.8-Max 免费额度",
      limit: 800,
      used: 12,
      remaining: 788,
      resetStrategy: "NEVER_EXPIRE",
      statusText: "剩余 788 次",
      tag: "限时特惠",
      description: "活动期内每人 800 次免费调用",
      eligible: true,
      activityEndAt: 2_000_000_000_000
    }] } }, 1_000)).toEqual([expect.objectContaining({
      id: "qwen38_800_invoke",
      name: "Qwen3.8-Max 免费额度",
      totalAmount: 800,
      usedAmount: 12,
      remainingAmount: 788,
      usedPercent: 2,
      remainingPercent: 98,
      unit: "Credits",
      expiresAt: 2_000_000_000_000
    })]);
    expect(normalizeQoderActivities([
      { activityId: "expired", limit: 10, remaining: 10, activityEndAt: 0.5 },
      { activityId: "ineligible", limit: 10, remaining: 10, eligible: false },
      { activityId: "invalid", remaining: 10 }
    ], 1_000)).toEqual([]);
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

  it("reads sanitized activity output from the helper and cancels its process tree", async () => {
    const helperChild = childProcess();
    const spawn = vi.fn(() => helperChild);
    const response = readQoderActivities({
      signal: new AbortController().signal,
      spawn,
      launch: { command: "electron.exe", args: ["--helper"] }
    });
    helperChild.stdout.emit("data", Buffer.from(
      "PANNEL_HANDLE_QODER_ACTIVITY:{\"activities\":[{\"activityId\":\"qwen38_800_invoke\",\"limit\":800,\"remaining\":800}]}\n"
    ));
    helperChild.emit("close", 0);
    await expect(response).resolves.toEqual([expect.objectContaining({ activityId: "qwen38_800_invoke" })]);
    expect(spawn).toHaveBeenCalledWith("electron.exe", ["--helper"], expect.objectContaining({ windowsHide: true }));

    const canceledChild = childProcess();
    const controller = new AbortController();
    const terminateProcessTree = vi.fn(() => true);
    const canceled = readQoderActivities({
      signal: controller.signal,
      spawn: vi.fn(() => canceledChild),
      terminateProcessTree,
      launch: { command: "electron.exe", args: ["--helper"] }
    });
    controller.abort();
    await expect(canceled).rejects.toThrow("canceled");
    expect(terminateProcessTree).toHaveBeenCalledWith(canceledChild);
  });

  it("uses the official SDK control request and always closes the temporary session", async () => {
    const close = vi.fn(async () => undefined);
    const initializationResult = vi.fn(async () => ({ account: {} }));
    const getUsageInfo = vi.fn(async () => usageInfo());
    const query = vi.fn(() => ({ initializationResult, getUsageInfo, close }));
    const qodercliAuth = vi.fn(() => ({ type: "qodercli" }));
    const activityReader = vi.fn(async () => [{
      activityId: "qwen38_800_invoke",
      modelName: "Qwen3.8-Max Free Quota",
      limit: 800,
      used: 0,
      remaining: 800,
      eligible: true
    }]);

    await expect(readQoderUsage({
      session: { type: "windows", cwd: "C:\\repo" },
      signal: new AbortController().signal,
      timeoutMs: 1000,
      now: () => 99,
      sdkLoader: async () => ({ query, qodercliAuth }),
      spawn: vi.fn(),
      activityReader
    })).resolves.toMatchObject({
      provider: "qoder",
      fetchedAt: 99,
      summary: { total: 4100, used: 800, remaining: 3300 },
      activities: [expect.objectContaining({ id: "qwen38_800_invoke", remainingAmount: 800 })]
    });

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
    expect(activityReader).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps Credits when Windows activity quota fails and skips activities for WSL", async () => {
    const close = vi.fn(async () => undefined);
    const query = vi.fn(() => ({
      initializationResult: vi.fn(async () => ({})),
      getUsageInfo: vi.fn(async () => usageInfo()),
      close
    }));
    const sdkLoader = async () => ({ query, qodercliAuth: () => ({ type: "qodercli" }) });
    const activityReader = vi.fn(async () => { throw new Error("private API changed"); });
    await expect(readQoderUsage({
      session: { type: "windows", cwd: "C:\\repo" },
      signal: new AbortController().signal,
      timeoutMs: 1000,
      sdkLoader,
      spawn: vi.fn(),
      activityReader
    })).resolves.toMatchObject({
      summary: { remaining: 2500 },
      activities: [],
      activityError: "Qoder activity quota is unavailable."
    });

    const wslActivityReader = vi.fn();
    await expect(readQoderUsage({
      session: { type: "wsl", wslDistro: "Ubuntu", cwd: "/srv/app" },
      signal: new AbortController().signal,
      timeoutMs: 1000,
      sdkLoader,
      spawn: vi.fn(),
      activityReader: wslActivityReader
    })).resolves.toMatchObject({ summary: { remaining: 2500 } });
    expect(wslActivityReader).not.toHaveBeenCalled();
  });
});
