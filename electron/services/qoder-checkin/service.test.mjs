import { createRequire } from "node:module";
import { describe, it, expect, vi, afterEach } from "vitest";
const require = createRequire(import.meta.url);
const { createQoderCheckinService, normalizeStatus, windowStart } = require("./service.cjs");
const { createQoderAutoCheckinService, getNextQoderWindowDelay } = require("./auto-checkin.cjs");
const now = Date.parse("2026-10-06T13:57:29Z");
const credentials = { token: "private-test-token", accountId: "account", accountLabel: "desktop" };
const campaign = (claimStatus = "CLAIMABLE") => ({ campaignId: "daily-reward", campaignKey: "act-20260930-551", actionType: "CLAIM_BENEFIT", claimStatus,
  startAt: windowStart(now) / 1000, endAt: (windowStart(now) + 86340000) / 1000,
  benefit: { kind: "CREDITS", amount: 100, validity: { mode: "RELATIVE_DAYS", days: 30 } } });
const json = campaigns => new Response(JSON.stringify({ campaigns }));
const service = fetchFn => createQoderCheckinService({ getRequestHeaders: () => ({ "Cosy-Version": "0.4.3", "Cosy-MachineToken": "test-device-token" }), getCredentials: async () => credentials, fetchFn, now: () => now });
afterEach(() => vi.useRealTimers());

describe("Qoder campaign check-in", () => {
  it("selects only the current daily credits reward and rejects ambiguity", () => {
    const c = campaign();
    const s = normalizeStatus({ campaigns: [c, { ...c, actionType: "VIEW_DETAILS" }, { ...c, startAt: c.startAt - 86400 }] }, credentials, now);
    expect(s).toMatchObject({ active: true, claimable: true, campaignId: "daily-reward", accountLabel: "desktop" });
    expect(() => normalizeStatus({ campaigns: [c, { ...c, campaignId: "other" }] }, credentials, now)).toThrow("uniquely");
    expect(normalizeStatus({ campaigns: [{ ...c, benefit: { kind: "COUPON" } }] }, credentials, now).active).toBe(false);
  });
  it("skips an already claimed reward", async () => {
    const fetchFn = vi.fn(async () => json([campaign("CLAIMED")]));
    expect(await service(fetchFn).claim()).toMatchObject({ alreadyCheckedIn: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("merges claims, uses dynamic ID without body and confirms server state", async () => {
    const fetchFn = vi.fn().mockImplementationOnce(async () => json([campaign()]))
      .mockImplementationOnce(async () => new Response("{}"))
      .mockImplementationOnce(async () => json([campaign("CLAIMED")]));
    const s = service(fetchFn);
    const first = s.claim();
    expect(s.claim()).toBe(first);
    expect(await first).toMatchObject({ alreadyCheckedIn: false, status: { todayCheckedIn: true } });
    expect(fetchFn.mock.calls[1][0].endsWith("/daily-reward/claim")).toBe(true);
    expect(fetchFn.mock.calls[1][1].method).toBe("POST");
    for (const [, options] of fetchFn.mock.calls) expect(options.headers).toMatchObject({ "Cosy-MachineToken": "test-device-token", "Cosy-Version": "0.4.3", Authorization: "Bearer private-test-token" });
    expect(fetchFn.mock.calls[1][1]).not.toHaveProperty("body");
  });
  it("rechecks after an ambiguous POST timeout rather than reposting", async () => {
    const fetchFn = vi.fn().mockImplementationOnce(async () => json([campaign()]))
      .mockRejectedValueOnce(new Error("private-test-token"))
      .mockImplementationOnce(async () => json([campaign("CLAIMED")]));
    expect((await service(fetchFn).claim()).status.todayCheckedIn).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it("does not report unconfirmed claims as success", async () => {
    const fetchFn = vi.fn(async (_url, options) => options.method === "POST" ? new Response("{}") : json([campaign()]));
    await expect(service(fetchFn).claim()).rejects.toMatchObject({ code: "claim-unconfirmed" });
  });
  it("stops before posting if the desktop account changes", async () => {
    const fetchFn = vi.fn(async () => json([campaign()]));
    const getCredentials = vi.fn().mockResolvedValueOnce(credentials).mockResolvedValueOnce(credentials)
      .mockResolvedValueOnce(credentials).mockResolvedValueOnce({ ...credentials, accountId: "other" });
    const s = createQoderCheckinService({ getRequestHeaders: () => ({}), getCredentials, fetchFn, now: () => now });
    await expect(s.claim()).rejects.toMatchObject({ code: "account-changed", retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("redacts network errors and stops retrying authentication failures", async () => {
    await expect(service(async () => { throw Error(credentials.token); }).getStatus()).rejects.toThrow("request failed");
    await expect(service(async () => new Response("secret", { status: 403 })).getStatus()).rejects.toMatchObject({ code: "authentication", retryable: false });
  });
  it("binds queries and claims to the quota account and rechecks after a response", async () => {
    const fetchFn = vi.fn(async () => json([campaign()]));
    await expect(service(fetchFn).getStatus("other")).rejects.toMatchObject({ code: "account-changed" });
    await expect(service(fetchFn).claim("other")).rejects.toMatchObject({ code: "account-changed" });
    expect(fetchFn).not.toHaveBeenCalled();
    const getCredentials = vi.fn().mockResolvedValueOnce(credentials).mockResolvedValueOnce(credentials)
      .mockResolvedValueOnce({ ...credentials, accountId: "other" });
    const s = createQoderCheckinService({ getCredentials, getRequestHeaders: () => ({}), fetchFn, now: () => now });
    await expect(s.getStatus()).rejects.toMatchObject({ code: "account-changed" });
    expect(() => normalizeStatus({ uid: "other", campaigns: [campaign()] }, credentials, now)).toThrow("account changed");
  });
});

describe("Qoder automatic check-in", () => {
  it("uses 10:00 UTC+8 even at the exact boundary", () => {
    expect(getNextQoderWindowDelay(Date.parse("2026-10-05T01:59:59Z"))).toBe(1000);
    expect(getNextQoderWindowDelay(Date.parse("2026-10-05T02:00:00Z"))).toBe(86400000);
  });
  it("stays off by default, runs on enabling and resume, and stops when disabled", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const claim = vi.fn(async () => ({}));
    const s = createQoderAutoCheckinService({ checkinService: { claim } });
    s.start(false); await vi.advanceTimersByTimeAsync(1); expect(claim).not.toHaveBeenCalled();
    s.setEnabled(true); await vi.advanceTimersByTimeAsync(1); expect(claim).toHaveBeenCalledTimes(1);
    s.resume(); await vi.advanceTimersByTimeAsync(1); expect(claim).toHaveBeenCalledTimes(2);
    s.setEnabled(false); await vi.advanceTimersByTimeAsync(86400000); expect(claim).toHaveBeenCalledTimes(2);
    s.shutdown(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retries three times then notifies once", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const claim = vi.fn(async () => { throw Object.assign(Error("offline"), { retryable: true }); });
    const notifyFailure = vi.fn();
    const s = createQoderAutoCheckinService({ checkinService: { claim }, notifyFailure });
    s.start(true); await vi.advanceTimersByTimeAsync(3 * 3600000 + 1);
    expect(claim).toHaveBeenCalledTimes(4); expect(notifyFailure).toHaveBeenCalledTimes(1); s.shutdown();
  });
  it("runs at the next reward window and does not notify for inactive campaigns", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const claim = vi.fn(async () => { throw Object.assign(Error("inactive"), { code: "activity-inactive", retryable: false }); });
    const notifyFailure = vi.fn();
    const s = createQoderAutoCheckinService({ checkinService: { claim }, notifyFailure });
    s.start(true); await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(getNextQoderWindowDelay(Date.now()));
    expect(claim).toHaveBeenCalledTimes(2); expect(notifyFailure).not.toHaveBeenCalled(); s.shutdown();
  });
});
