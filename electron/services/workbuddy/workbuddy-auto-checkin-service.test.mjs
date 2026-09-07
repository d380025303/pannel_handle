import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  DEFAULT_RETRY_DELAY_MS,
  createWorkBuddyAutoCheckinService,
  getNextLocalDayDelay
} = require("./workbuddy-auto-checkin-service.cjs");

function createService(claim, notifyFailure = vi.fn()) {
  return {
    notifyFailure,
    service: createWorkBuddyAutoCheckinService({
      checkinService: { claim },
      notifyFailure
    })
  };
}

describe("workbuddy-auto-checkin-service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks immediately and again on the next local day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 23, 10, 30, 0));
    const claim = vi.fn().mockResolvedValue({ alreadyCheckedIn: true });
    const { service } = createService(claim);

    service.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(getNextLocalDayDelay(Date.now()));
    expect(claim).toHaveBeenCalledTimes(2);
    service.shutdown();
  });

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
});
