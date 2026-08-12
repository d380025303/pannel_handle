// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsageSnapshot } from "../../vite-env";
import { AgentUsageStatus } from "./AgentUsageStatus";

function snapshot(primaryRemaining = 51): AgentUsageSnapshot {
  return {
    provider: "codex",
    fetchedAt: new Date("2026-08-12T08:00:00Z").getTime(),
    primaryLimitId: "codex",
    limits: [
      {
        id: "codex",
        name: "Codex",
        usedPercent: 100 - primaryRemaining,
        remainingPercent: primaryRemaining,
        windowDurationMins: 10080,
        resetsAt: new Date("2026-08-19T08:00:00Z").getTime()
      },
      {
        id: "codex_spark",
        name: "GPT Spark",
        usedPercent: 0,
        remainingPercent: 100
      }
    ]
  };
}

describe("AgentUsageStatus", () => {
  afterEach(cleanup);

  it("hides non-Codex state and renders loading and retry states", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<AgentUsageStatus state={{ status: "hidden" }} onRefresh={onRefresh} />);
    expect(screen.queryByText(/Codex/)).toBeNull();

    rerender(<AgentUsageStatus state={{ status: "loading" }} onRefresh={onRefresh} />);
    expect(screen.getByRole("status").textContent).toContain("正在读取 Codex 用量");

    rerender(<AgentUsageStatus state={{ status: "error" }} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex 用量不可用" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows the primary remaining amount and opens all limit details", () => {
    const onRefresh = vi.fn();
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: snapshot(), refreshing: false }}
        onRefresh={onRefresh}
      />
    );

    const trigger = screen.getByRole("button", { name: "Codex 剩余 51%" });
    expect(trigger.classList.contains("normal")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Codex 用量" })).not.toBeNull();
    expect(screen.getByText("GPT Spark")).not.toBeNull();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getAllByText(/重置/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "刷新用量" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Codex 用量" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses warning and danger classes at the configured thresholds", () => {
    const { rerender } = render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: snapshot(49), refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Codex 剩余 49%" }).classList.contains("warning")).toBe(true);

    rerender(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: snapshot(20), refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Codex 剩余 20%" }).classList.contains("danger")).toBe(true);
  });
});
