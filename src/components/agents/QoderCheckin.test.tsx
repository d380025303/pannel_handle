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
  it("refreshes status with the quota account and ignores responses from the previous account", async () => {
    let resolveOld: (value: typeof status) => void = () => undefined;
    const getStatus = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ ...status, accountId: "new", accountLabel: "new-account", todayCheckedIn: true, claimable: false });
    const claim = vi.fn();
    Object.defineProperty(window, "qoderCheckinApi", { configurable: true, value: { getStatus, claim } });
    const onRefresh = vi.fn();
    const { rerender } = render(<QoderCheckin onRefresh={onRefresh} accountId="desktop" refreshVersion={0} />);
    rerender(<QoderCheckin onRefresh={onRefresh} accountId="new" refreshVersion={0} />);
    expect(await screen.findByText(/new-account/)).toBeTruthy();
    resolveOld(status);
    await waitFor(() => expect(screen.queryByText(/desktop@example.test/)).toBeNull());
    expect(getStatus).toHaveBeenNthCalledWith(1, "desktop");
    expect(getStatus).toHaveBeenNthCalledWith(2, "new");
    const checked = screen.getByRole<HTMLButtonElement>("button", { name: "今日已签到" });
    expect(checked.disabled).toBe(true);
    rerender(<QoderCheckin onRefresh={onRefresh} accountId="new" refreshVersion={1} />);
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(3));
    expect(claim).not.toHaveBeenCalled();
  });
  it("shows a readable fallback for an IPC transport failure instead of the remote-method prefix", async () => {
    setup(vi.fn().mockRejectedValue(Error("Error invoking remote method 'qoder-checkin:get-status': failure")));
    expect((await screen.findByRole("alert")).textContent).toContain("Qoder 签到查询失败");
    expect(screen.queryByText(/Error invoking/)).toBeNull();
  });
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
