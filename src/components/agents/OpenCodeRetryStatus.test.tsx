// @vitest-environment jsdom
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OpenCodeRetryStatus } from "./OpenCodeRetryStatus";

afterEach(() => { cleanup(); vi.useRealTimers(); });
it("shows retry details, waits at the deadline, and clears", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  const retry = { attempt: 2, nextRetryAt: "2026-10-08T12:00:02Z", error: { type: "rate-limit", message: "限流", status: 429 } };
  const view = render(<OpenCodeRetryStatus retry={retry} />);
  expect(screen.getByRole("status").textContent).toContain("第 2 次自动重试");
  expect(screen.getByRole("status").textContent).toContain("HTTP 429 · 限流");
  expect(screen.getByRole("status").textContent).toContain("预计");
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("status").textContent).toContain("等待 OpenCode 重试");
  view.rerender(<OpenCodeRetryStatus retry={{ ...retry, nextRetryAt: "invalid" }} />);
  expect(screen.getByRole("status").textContent).not.toContain("预计");
  view.rerender(<OpenCodeRetryStatus retry={null} />);
  expect(screen.queryByRole("status")).toBeNull();
});
