import { createRequire } from "node:module";
import { describe, it, expect, vi } from "vitest";
const require = createRequire(import.meta.url);
const { normalizeQoderDesktopUsage, readQoderDesktopUsage } = require("./qoder-usage-client.cjs");
const credentials = { accountId: "desktop", accountLabel: "desktop@example.test", token: "test-secret" };
function desktopUsage() {
  return { displayMode: "qoder", qoderUsage: { userId: "desktop", userType: "personal_standard",
    expiresAt: 253402214400000, totalUsagePercentage: 0,
    userQuota: { total: 0, used: 0, remaining: 0, percentage: 0 },
    addOnQuota: { total: 200, used: 0, remaining: 200, percentage: 0 } } };
}

describe("Qoder desktop quota", () => {
  it("counts the 200 reward credits even with a zero base plan and ignores the no-expiry sentinel", () => {
    const snapshot = normalizeQoderDesktopUsage(desktopUsage(), credentials, 1000);
    expect(snapshot).toMatchObject({ summary: { total: 200, remaining: 200, used: 0, remainingPercent: 100 },
      qoderAccount: { id: "desktop" }, qoderSource: "desktop" });
    expect(snapshot.limits[0].expiresAt).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("test-secret");
  });
  it("derives remaining from complete amounts, handles fractional percentages and never adds details twice", () => {
    const now = Date.parse("2026-10-06T14:00:00Z");
    const payload = desktopUsage();
    payload.qoderUsage.addOnQuota = { total: 200, used: 50, percentage: 0.25 };
    payload.qoderUsage.dedicatedResourcePackages = [
      { id: "reward", name: "Daily reward", total: 200, used: 50, remaining: 150, available: true, expiresAt: now + 20000 },
      { id: "expired", total: 100, used: 0, remaining: 100, available: true, expiresAt: now - 1 },
      { id: "unavailable", total: 100, used: 0, remaining: 100, available: false }
    ];
    const snapshot = normalizeQoderDesktopUsage(payload, credentials, now);
    expect(snapshot.summary).toMatchObject({ total: 200, used: 50, remaining: 150, usedPercent: 25 });
    expect(snapshot.activities).toEqual([expect.objectContaining({ id: "reward", remainingAmount: 150, expiresAt: now + 20000 })]);
  });
  it("distinguishes absent details from empty details and preserves the balance on invalid details", () => {
    const payload = desktopUsage();
    expect(normalizeQoderDesktopUsage(payload, credentials).qoderRewardDetailsStatus).toBe("unavailable");
    payload.qoderUsage.dedicatedResourcePackages = [];
    expect(normalizeQoderDesktopUsage(payload, credentials).qoderRewardDetailsStatus).toBe("available");
    for (const invalid of [null, {}, [{ id: "reward", total: 100 }]]) {
      payload.qoderUsage.dedicatedResourcePackages = invalid;
      expect(normalizeQoderDesktopUsage(payload, credentials)).toMatchObject({
        summary: { remaining: 200 }, activities: [], qoderRewardDetailsStatus: "unavailable"
      });
    }
  });
  it("keeps independent reward expiration dates and never substitutes a campaign end date", () => {
    const now = Date.parse("2026-10-06T00:00:00Z");
    const payload = desktopUsage();
    payload.qoderUsage.dedicatedResourcePackages = [
      { id: "one", total: 100, used: 0, expiresAt: "2026-11-04T00:00:00Z" },
      { id: "two", total: 100, used: 0, expiresAt: Date.parse("2026-11-05T00:00:00Z") / 1000 },
      { id: "unknown", total: 100, used: 0, expiresAt: "invalid", activityEndAt: now + 10000 },
      { id: "sentinel", total: 100, used: 0, expiresAt: 253402214400000 }
    ];
    const snapshot = normalizeQoderDesktopUsage(payload, credentials, now);
    expect(snapshot.activities.map(value => value.expiresAt)).toEqual([
      Date.parse("2026-11-04T00:00:00Z"), Date.parse("2026-11-05T00:00:00Z"), undefined, undefined
    ]);
    expect(snapshot.summary.remaining).toBe(200);
  });
  it("rejects incomplete, null and cross-account responses instead of manufacturing zero credits", () => {
    for (const invalid of [{ total: 200 }, { total: null, used: 0 }, { total: 200, used: null }, { total: 200, used: 0, remaining: null }]) {
      const payload = desktopUsage(); payload.qoderUsage.addOnQuota = invalid;
      expect(() => normalizeQoderDesktopUsage(payload, credentials)).toThrow("incomplete");
    }
    expect(() => normalizeQoderDesktopUsage({ displayMode: "enterprise" }, credentials)).toThrow("unsupported");
    const payload = desktopUsage(); payload.qoderUsage.userId = "other";
    expect(() => normalizeQoderDesktopUsage(payload, credentials)).toThrow("account changed");
  });
  it("uses the App endpoint and revalidates identity after the server response", async () => {
    const getCredentials = vi.fn(async () => credentials);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(desktopUsage())));
    await expect(readQoderDesktopUsage({ getCredentials, fetchFn, now: () => 1000 })).resolves.toMatchObject({ summary: { remaining: 200 } });
    expect(fetchFn.mock.calls[0][0]).toBe("https://openapi.qoder.sh/sash/api/v2/me/usage");
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer test-secret", "Cosy-ClientType": "10" } });
    getCredentials.mockResolvedValueOnce(credentials).mockResolvedValueOnce({ ...credentials, accountId: "other" });
    await expect(readQoderDesktopUsage({ getCredentials, fetchFn })).rejects.toMatchObject({ code: "account-changed" });
  });
  it("redacts authentication and network failures", async () => {
    const getCredentials = () => credentials;
    await expect(readQoderDesktopUsage({ getCredentials, fetchFn: async () => new Response("secret", { status: 401 }) }))
      .rejects.toMatchObject({ code: "authentication", retryable: false });
    await expect(readQoderDesktopUsage({ getCredentials, fetchFn: async () => { throw Error("test-secret"); } }))
      .rejects.toThrow("request failed");
  });
});
