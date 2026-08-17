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

function codeBuddySnapshot(): AgentUsageSnapshot {
  return {
    provider: "codebuddy",
    fetchedAt: new Date("2026-08-17T08:00:00Z").getTime(),
    primaryLimitId: "codebuddy-total",
    summary: {
      kind: "credits",
      total: 1200,
      used: 450,
      remaining: 750,
      usedPercent: 38,
      remainingPercent: 62,
      unit: "Credits"
    },
    limits: [{
      id: "base-1",
      name: "Free plan",
      usedPercent: 50,
      remainingPercent: 50,
      category: "base",
      totalAmount: 1000,
      usedAmount: 500,
      remainingAmount: 500,
      unit: "Credits",
      expiresAt: new Date("2026-09-01T08:00:00Z").getTime()
    }, {
      id: "bonus-1",
      name: "Bonus",
      usedPercent: 0,
      remainingPercent: 100,
      category: "bonus",
      totalAmount: 250,
      usedAmount: 0,
      remainingAmount: 250,
      unit: "Credits"
    }]
  };
}

describe("AgentUsageStatus", () => {
  afterEach(cleanup);

  it("hides non-Codex state and renders loading and retry states", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<AgentUsageStatus state={{ status: "hidden" }} onRefresh={onRefresh} />);
    expect(screen.queryByText(/Codex/)).toBeNull();

    rerender(<AgentUsageStatus state={{ status: "loading", provider: "codex" }} onRefresh={onRefresh} />);
    expect(screen.getByRole("status").textContent).toContain("正在读取 Codex 用量");

    rerender(<AgentUsageStatus state={{ status: "error", provider: "codex" }} onRefresh={onRefresh} />);
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

  it("shows CodeBuddy total credits and grouped package details", () => {
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: codeBuddySnapshot(), refreshing: false }}
        onRefresh={() => undefined}
      />
    );

    const trigger = screen.getByRole("button", { name: /750 Credits/ });
    expect(trigger.classList.contains("normal")).toBe(true);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog").textContent).toContain("750 / 1,200 Credits");
    expect(screen.getByText("Free plan")).not.toBeNull();
    expect(screen.getByText("Bonus")).not.toBeNull();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });
});
