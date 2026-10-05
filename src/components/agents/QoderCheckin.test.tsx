// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QoderCheckin } from "./QoderCheckin";
const status = { accountId: "desktop", accountLabel: "desktop@example.test", active: true, claimable: true,
  todayCheckedIn: false, dailyCredit: 100, windowStart: 0, nextClaimAt: 86400000 };
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "qoderCheckinApi"); });
function setup(getStatus = vi.fn(async () => status)) {
  const claim = vi.fn(async () => ({ alreadyCheckedIn: false, status: { ...status, claimable: false, todayCheckedIn: true } }));
  Object.defineProperty(window, "qoderCheckinApi", { configurable: true, value: { getStatus, claim } });
  const onRefresh = vi.fn();
  render(<QoderCheckin onRefresh={onRefresh} />);
  return { getStatus, claim, onRefresh };
}
describe("Qoder check-in UI", () => {
  it("shows the desktop account and confirms a manual claim", async () => {
    const { claim, onRefresh } = setup();
    expect(await screen.findByText(/desktop@example.test/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "立即签到" }));
    await waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("本轮已领取 100 Credits")).toBeTruthy();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
  it("allows retrying unavailable login", async () => {
    const getStatus = vi.fn().mockRejectedValueOnce(Error("Please sign in to Qoder desktop" )).mockResolvedValueOnce(status);
    setup(getStatus);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/desktop@example.test/)).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});
