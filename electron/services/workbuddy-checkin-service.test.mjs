import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  WORKBUDDY_CLAIM_PATH,
  WORKBUDDY_HOST,
  WORKBUDDY_STATUS_PATH,
  createWorkBuddyAcpTransport,
  createWorkBuddyCheckinService,
  getWorkBuddyInvocation,
  normalizeWorkBuddyCheckinStatus,
  requestWorkBuddyJson
} = require("./workbuddy-checkin-service.cjs");

function statusData(overrides = {}) {
  return {
    active: true,
    today_checked_in: false,
    streak_days: 2,
    daily_credit: 100,
    today_credit: 0,
    total_credits: 200,
    week_progress: [true, false, true, false, false, false, false],
    ...overrides
  };
}

function createAcpTransport() {
  const events = new EventEmitter();
  return {
    close: vi.fn(),
    on: (eventName, listener) => events.on(eventName, listener),
    write: vi.fn(line => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        queueMicrotask(() => events.emit("stdout", `${JSON.stringify({ id: message.id, result: {} })}\n`));
      } else if (message.method === "_codebuddy.ai/getUserInfo") {
        queueMicrotask(() => events.emit("stdout", `${JSON.stringify({
          id: message.id,
          result: { userInfo: { userId: "user-1", token: "secret-token", userName: "private-name" } }
        })}\n`));
      }
    })
  };
}

function createHttpsSequence(responses) {
  const calls = [];
  const httpsRequest = vi.fn((options, callback) => {
    calls.push(options);
    const request = new EventEmitter();
    request.destroy = vi.fn();
    request.end = vi.fn(() => {
      const next = responses.shift();
      const response = new EventEmitter();
      response.statusCode = next.statusCode ?? 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", typeof next.body === "string" ? next.body : JSON.stringify(next.body));
        response.emit("end");
      });
    });
    return request;
  });
  return { calls, httpsRequest };
}

describe("workbuddy-checkin-service", () => {
  it("resolves only the supported current-user WorkBuddy installation", () => {
    const localAppData = path.join("C:", "Users", "test", "AppData", "Local");
    const invocation = getWorkBuddyInvocation({ localAppData, existsSync: () => true });
    expect(invocation.command).toBe(path.join(localAppData, "Programs", "WorkBuddy", "WorkBuddy.exe"));
    expect(invocation.args).toEqual([
      path.join(localAppData, "Programs", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
      "--acp"
    ]);
    expect(() => getWorkBuddyInvocation({ localAppData, existsSync: () => false })).toThrow("not installed");
  });

  it("starts the bundled CLI in Electron Node mode and terminates its process tree", () => {
    const child = new EventEmitter();
    child.pid = 123;
    child.stdin = { writable: true, write: vi.fn(), end: vi.fn() };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawn = vi.fn(() => child);
    const spawnSync = vi.fn();
    const transport = createWorkBuddyAcpTransport({
      spawn,
      spawnSync,
      invocation: { command: "WorkBuddy.exe", args: ["codebuddy", "--acp"] },
      environment: { SAFE_VALUE: "1" }
    });

    transport.write("request\n");
    transport.close();

    expect(spawn).toHaveBeenCalledWith("WorkBuddy.exe", ["codebuddy", "--acp"], expect.objectContaining({
      windowsHide: true,
      env: { SAFE_VALUE: "1", ELECTRON_RUN_AS_NODE: "1" }
    }));
    expect(child.stdin.write).toHaveBeenCalledWith("request\n");
    expect(spawnSync).toHaveBeenCalledWith("taskkill.exe", ["/pid", "123", "/t", "/f"], expect.any(Object));
  });

  it("normalizes the public status fields and ignores unrelated response data", () => {
    expect(normalizeWorkBuddyCheckinStatus({ code: 0, data: statusData({
      today_checked_in: true,
      today_credit: "100",
      secret_field: "do-not-return"
    }) })).toEqual({
      active: true,
      todayCheckedIn: true,
      streakDays: 2,
      dailyCredit: 100,
      todayCredit: 100,
      totalCredits: 200,
      weekProgress: [true, false, true, false, false, false, false]
    });
    expect(() => normalizeWorkBuddyCheckinStatus({ code: 6005, msg: "not allowed" })).toThrow("not allowed");
  });

  it("posts an empty JSON body to the fixed host with only required credentials", async () => {
    const { calls, httpsRequest } = createHttpsSequence([{ body: { code: 0, data: statusData() } }]);
    await requestWorkBuddyJson({
      path: WORKBUDDY_STATUS_PATH,
      token: "secret-token",
      userId: "user-1",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      httpsRequest
    });
    expect(calls[0]).toMatchObject({
      hostname: WORKBUDDY_HOST,
      path: WORKBUDDY_STATUS_PATH,
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "x-user-id": "user-1"
      }
    });
  });

  it("does not claim twice when today is already checked in", async () => {
    const transportFactory = vi.fn(() => createAcpTransport());
    const { calls, httpsRequest } = createHttpsSequence([
      { body: { code: 0, data: statusData({ today_checked_in: true, today_credit: 100 }) } }
    ]);
    const service = createWorkBuddyCheckinService({ transportFactory, httpsRequest, timeoutMs: 1000 });

    await expect(service.claim()).resolves.toMatchObject({
      alreadyCheckedIn: true,
      status: { todayCheckedIn: true, todayCredit: 100 }
    });
    expect(calls.map(call => call.path)).toEqual([WORKBUDDY_STATUS_PATH]);
  });

  it("claims once and reloads status with the same in-memory credentials", async () => {
    const transportFactory = vi.fn(() => createAcpTransport());
    const { calls, httpsRequest } = createHttpsSequence([
      { body: { code: 0, data: statusData() } },
      { body: { code: 0, data: { success: true } } },
      { body: { code: 0, data: statusData({ today_checked_in: true, today_credit: 100, streak_days: 3 }) } }
    ]);
    const service = createWorkBuddyCheckinService({ transportFactory, httpsRequest, timeoutMs: 1000 });

    await expect(service.claim()).resolves.toMatchObject({
      alreadyCheckedIn: false,
      status: { todayCheckedIn: true, todayCredit: 100, streakDays: 3 }
    });
    expect(transportFactory).toHaveBeenCalledTimes(1);
    expect(calls.map(call => call.path)).toEqual([
      WORKBUDDY_STATUS_PATH,
      WORKBUDDY_CLAIM_PATH,
      WORKBUDDY_STATUS_PATH
    ]);
  });

  it("reports expired login, inactive activity, and invalid responses", async () => {
    const expired = createHttpsSequence([{ statusCode: 401, body: {} }]);
    await expect(requestWorkBuddyJson({
      path: WORKBUDDY_STATUS_PATH,
      token: "secret-token",
      userId: "user-1",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      httpsRequest: expired.httpsRequest
    })).rejects.toThrow("expired");

    const inactive = createHttpsSequence([{ body: { code: 0, data: statusData({ active: false }) } }]);
    await expect(createWorkBuddyCheckinService({
      transportFactory: () => createAcpTransport(),
      httpsRequest: inactive.httpsRequest,
      timeoutMs: 1000
    }).claim()).rejects.toThrow("not active");

    const invalid = createHttpsSequence([{ body: "not-json" }]);
    await expect(requestWorkBuddyJson({
      path: WORKBUDDY_STATUS_PATH,
      token: "secret-token",
      userId: "user-1",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      httpsRequest: invalid.httpsRequest
    })).rejects.toThrow("invalid check-in response");
  });
});
