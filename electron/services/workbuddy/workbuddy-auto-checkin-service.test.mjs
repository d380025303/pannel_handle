import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
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
});
