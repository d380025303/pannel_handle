// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteSystemMetrics, TerminalSession } from "../vite-env";
import { useRemoteSystemMetrics } from "./useRemoteSystemMetrics";

const metrics: RemoteSystemMetrics = {
  sampledAt: 1, cpu: { usedPercent: 42 }, memory: { usedBytes: 1, totalBytes: 2 },
  network: { receivedBytesPerSecond: null, transmittedBytesPerSecond: null }, disks: []
};
const session = (id: string, type: TerminalSession["type"] = "ssh"): TerminalSession => ({
  id, type, title: id, cwd: "/", shell: "bash", createdAt: 1
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("useRemoteSystemMetrics", () => {
  it("discards late results and never renders the previous server under a new session", async () => {
    let resolveOld!: (value: RemoteSystemMetrics) => void;
    const getMetrics = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(metrics).mockImplementation(() => new Promise(() => {}));
    window.remoteSystemApi = { getMetrics };
    const seen: string[] = [];
    const { result, rerender } = renderHook(({ current }) => {
      const state = useRemoteSystemMetrics(current);
      seen.push(`${current.id}:${state.status}`);
      return state;
    }, { initialProps: { current: session("old") } });
    rerender({ current: session("new") });
    await act(async () => {});
    expect(result.current).toEqual({ status: "ready", metrics });
    await act(async () => resolveOld({ ...metrics, sampledAt: 999 }));
    expect(result.current).toEqual({ status: "ready", metrics });
    seen.length = 0;
    rerender({ current: session("third") });
    expect(seen.every((value) => value === "third:loading")).toBe(true);
    rerender({ current: session("local", "windows") });
    expect(result.current).toEqual({ status: "hidden" });
    expect(getMetrics).toHaveBeenCalledTimes(3);
  });

  it("retries failures every three seconds without polling again on unrelated renders", async () => {
    vi.useFakeTimers();
    const getMetrics = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(metrics);
    window.remoteSystemApi = { getMetrics };
    const { result, rerender, unmount } = renderHook(() => useRemoteSystemMetrics(session("ssh")));
    await act(async () => {});
    expect(result.current.status).toBe("error");
    rerender();
    expect(getMetrics).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(result.current.status).toBe("ready");
    unmount();
    await vi.advanceTimersByTimeAsync(6000);
    expect(getMetrics).toHaveBeenCalledTimes(2);
  });
});
