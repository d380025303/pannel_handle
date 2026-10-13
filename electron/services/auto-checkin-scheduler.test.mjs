import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createWorkBuddyAutoCheckinService } = require("./workbuddy/workbuddy-auto-checkin-service.cjs");
const { createQoderAutoCheckinService } = require("./qoder-checkin/auto-checkin.cjs");
const { DEFAULT_RETRY_DELAY_MS } = require("./auto-checkin-scheduler.cjs");

describe.each([
  ["WorkBuddy", createWorkBuddyAutoCheckinService],
  ["Qoder", createQoderAutoCheckinService]
])("%s auto check-in contract", (_name, createAutoCheckinService) => {
  function createService(claim, notifyFailure = vi.fn(), options = {}) {
    return { notifyFailure, service: createAutoCheckinService({ checkinService: { claim }, notifyFailure, ...options }) };
  }

  afterEach(() => { vi.useRealTimers(); });
  it("retries a retryable failure three times before notifying once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 23, 10, 30, 0));
    const error = Object.assign(new Error("network unavailable"), { retryable: true });
    const claim = vi.fn().mockRejectedValue(error);
    const { notifyFailure, service } = createService(claim);

    service.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(notifyFailure).not.toHaveBeenCalled();

    for (let retry = 1; retry <= 3; retry += 1) {
      await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAY_MS);
      expect(claim).toHaveBeenCalledTimes(retry + 1);
    }
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    expect(notifyFailure).toHaveBeenCalledWith(error);
    service.shutdown();
  });

  it("does not retry installation or login failures", async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("not installed"), { retryable: false });
    const claim = vi.fn().mockRejectedValue(error);
    const { notifyFailure, service } = createService(claim);

    service.start(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(claim).toHaveBeenCalledTimes(1);
    expect(notifyFailure).toHaveBeenCalledWith(error);
    service.shutdown();
  });

  it("quietly waits until the next day when the activity is inactive", async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("inactive"), { code: "activity-inactive", retryable: false });
    const claim = vi.fn().mockRejectedValue(error);
    const { notifyFailure, service } = createService(claim);

    service.start(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(claim).toHaveBeenCalledTimes(1);
    expect(notifyFailure).not.toHaveBeenCalled();
    service.shutdown();
  });

  it("starts immediately when enabled and cancels pending work when disabled", async () => {
    vi.useFakeTimers();
    const claim = vi.fn().mockResolvedValue({ alreadyCheckedIn: true });
    const { service } = createService(claim);

    service.start(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).not.toHaveBeenCalled();

    service.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(1);

    service.setEnabled(false);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(claim).toHaveBeenCalledTimes(1);
    service.shutdown();
  });

  it.each(["disable", "shutdown"])("cancels a pending retry on %s", async (action) => {
    vi.useFakeTimers();
    const claim = vi.fn().mockRejectedValue(new Error("offline"));
    const { service, notifyFailure } = createService(claim);
    service.start(true);
    await vi.advanceTimersByTimeAsync(0);
    if (action === "disable") service.setEnabled(false);
    else service.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86400000);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(notifyFailure).not.toHaveBeenCalled();
    service.shutdown();
  });

  it.each(["success", "failure"])("ignores stale %s after restarting", async (outcome) => {
    vi.useFakeTimers();
    let resolveOld, rejectOld;
    const pending = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const claim = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({});
    const { service, notifyFailure } = createService(claim);
    service.start(true);
    await vi.advanceTimersByTimeAsync(0);
    service.shutdown();
    service.start(true);
    if (outcome === "success") resolveOld({});
    else rejectOld(Object.assign(new Error("old failure"), { retryable: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(notifyFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    service.shutdown();
  });

  it.each(["success", "failure"])("ignores in-flight %s after shutdown", async (outcome) => {
    vi.useFakeTimers();
    let resolveClaim, rejectClaim;
    const claim = vi.fn(() => new Promise((resolve, reject) => { resolveClaim = resolve; rejectClaim = reject; }));
    const { service, notifyFailure } = createService(claim);
    service.start(true);
    await vi.advanceTimersByTimeAsync(0);
    service.shutdown();
    if (outcome === "success") resolveClaim({});
    else rejectClaim(new Error("offline"));
    await vi.advanceTimersByTimeAsync(86400000);
    expect(vi.getTimerCount()).toBe(0);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  it("honors custom retry settings", async () => {
    vi.useFakeTimers();
    const claim = vi.fn().mockRejectedValue(new Error("offline"));
    const { service, notifyFailure } = createService(claim, vi.fn(), { maxRetries: 1, retryDelayMs: 250 });
    service.start(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    service.shutdown();
  });
});
