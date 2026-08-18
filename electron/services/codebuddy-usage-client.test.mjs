import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  CODEBUDDY_HOST,
  CODEBUDDY_PACKAGE_CODES,
  CODEBUDDY_RESOURCE_PATH,
  normalizeCodeBuddyResourceResponse,
  requestCodeBuddyResources,
  runCodeBuddyUserInfoRequest
} = require("./codebuddy-usage-client.cjs");

function resource(overrides = {}) {
  return {
    ResourceId: "resource-1",
    PackageCode: "TCACA_code_008_cfWoLwvjU4",
    PackageName: "Free plan",
    CycleCapacitySizePrecise: "1000",
    CycleCapacityRemainPrecise: "750",
    CycleEndTime: "2026-09-01T00:00:00+08:00",
    ...overrides
  };
}

function response(accounts) {
  return { code: 0, data: { Response: { Data: { Accounts: accounts } } } };
}

function createAcpTransport(options = {}) {
  const events = new EventEmitter();
  const transport = {
    writes: [],
    close: vi.fn(),
    on: (eventName, listener) => events.on(eventName, listener),
    write: vi.fn(line => {
      const message = JSON.parse(line);
      transport.writes.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => events.emit("stdout", `${JSON.stringify({ id: message.id, result: {} })}\n`));
      } else if (message.method === "_codebuddy.ai/getUserInfo") {
        queueMicrotask(() => events.emit("stdout", `${JSON.stringify({
          id: message.id,
          result: options.loggedOut ? { userInfo: {} } : {
            userInfo: { userId: "user-1", token: "secret-token" }
          }
        })}\n`));
      }
    })
  };
  return transport;
}

describe("codebuddy-usage-client", () => {
  it("normalizes, groups, sorts, and totals visible precise quota resources", () => {
    const snapshot = normalizeCodeBuddyResourceResponse(response([
      resource({ ResourceId: "bonus", PackageCode: "TCACA_code_007_nzdH5h4Nl0", PackageName: "Bonus", CycleCapacitySizePrecise: "50.5", CycleCapacityRemainPrecise: "10.25" }),
      resource({ ResourceId: "base", CycleCapacitySizePrecise: "100", CycleCapacityRemainPrecise: "25" }),
      resource({ ResourceId: "empty", PackageCode: "unknown", CycleCapacitySizePrecise: "500", CycleCapacityRemainPrecise: "0" })
    ]), 1234);

    expect(snapshot).toMatchObject({
      provider: "codebuddy",
      fetchedAt: 1234,
      primaryLimitId: "codebuddy-total",
      summary: {
        kind: "credits",
        total: 150.5,
        used: 115.25,
        remaining: 35.25,
        unit: "Credits"
      }
    });
    expect(snapshot.limits.map(limit => [limit.id, limit.category])).toEqual([
      ["base", "base"],
      ["bonus", "bonus"]
    ]);
    expect(snapshot.summary.total).toBe(snapshot.limits.reduce((sum, limit) => sum + limit.totalAmount, 0));
  });

  it("rejects missing and unusable account data", () => {
    expect(() => normalizeCodeBuddyResourceResponse({ code: 0 })).toThrow("invalid quota response");
    expect(() => normalizeCodeBuddyResourceResponse(response([
      resource({ CycleCapacitySizePrecise: "invalid" })
    ]))).toThrow("usable quota resources");
  });

  it("reads nested login information through ACP without returning profile fields", async () => {
    const transport = createAcpTransport();
    await expect(runCodeBuddyUserInfoRequest(transport, { timeoutMs: 1000, maxOutputBytes: 1024 }))
      .resolves.toEqual({ userId: "user-1", token: "secret-token" });
    expect(transport.writes.map(message => message.method)).toEqual([
      "initialize",
      "_codebuddy.ai/getUserInfo"
    ]);
    expect(transport.close).toHaveBeenCalledTimes(1);

    await expect(runCodeBuddyUserInfoRequest(createAcpTransport({ loggedOut: true }), {
      timeoutMs: 1000,
      maxOutputBytes: 1024
    })).rejects.toThrow("sign in");
  });

  it("posts only the required credentials and resource request to the fixed host", async () => {
    let requestOptions;
    let requestBody = "";
    const httpsRequest = vi.fn((options, callback) => {
      requestOptions = options;
      const request = new EventEmitter();
      request.end = vi.fn(body => {
        requestBody = body.toString();
        const incoming = new EventEmitter();
        incoming.statusCode = 200;
        callback(incoming);
        queueMicrotask(() => {
          incoming.emit("data", JSON.stringify(response([resource()])));
          incoming.emit("end");
        });
      });
      request.destroy = vi.fn();
      return request;
    });

    await expect(requestCodeBuddyResources({
      token: "secret-token",
      userId: "user-1",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      httpsRequest
    })).resolves.toMatchObject({ code: 0 });

    expect(requestOptions).toMatchObject({
      hostname: CODEBUDDY_HOST,
      path: CODEBUDDY_RESOURCE_PATH,
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "x-user-id": "user-1"
      }
    });
    expect(JSON.parse(requestBody)).toMatchObject({
      ProductCode: "p_tcaca",
      PackageCodes: CODEBUDDY_PACKAGE_CODES,
      OnlyValidPeriod: true
    });
  });
});
