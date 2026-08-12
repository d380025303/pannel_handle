// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { TerminalSession } from "../../vite-env";
import { orderSessionsByFrequency, SessionPickerModal } from "./SessionPickerModal";

function createSession(id: string, recentLaunchCount = 0, lastLaunchedAt?: number): TerminalSession {
  return {
    id,
    title: `Template ${id}`,
    shell: "powershell.exe",
    cwd: "C:\\work",
    createdAt: 1,
    type: "windows",
    recentLaunchCount,
    lastLaunchedAt
  };
}

describe("SessionPickerModal frequent templates", () => {
  afterEach(cleanup);

  it("pins at most ten qualified templates by count and recency", () => {
    const sessions = [
      createSession("ordinary"),
      ...Array.from({ length: 11 }, (_, index) => createSession(`frequent-${index}`, 2 + index, 100 + index)),
      createSession("tie-old", 20, 100),
      createSession("tie-new", 20, 200)
    ];

    const result = orderSessionsByFrequency(sessions);

    expect(result.frequentIds.size).toBe(10);
    expect(result.orderedSessions.slice(0, 2).map((session) => session.id)).toEqual(["tie-new", "tie-old"]);
    expect(result.frequentIds.has("ordinary")).toBe(false);
    expect(result.orderedSessions.slice(10).map((session) => session.id)).toEqual(
      sessions.filter((session) => !result.frequentIds.has(session.id)).map((session) => session.id)
    );
  });

  it("renders the frequent badge and no template drag handles", () => {
    const { container } = render(
      <I18nProvider locale="zh-CN">
        <SessionPickerModal
          pendingSessions={[createSession("normal", 1), createSession("frequent", 2, 200)]}
          runningSessions={[]}
          pickerManual
          onLaunch={vi.fn()}
          onStartFresh={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onEdit={vi.fn()}
          onImport={vi.fn()}
          onExport={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.getByText("常用")).toBeTruthy();
    expect(container.querySelector(".picker-item")?.textContent).toContain("Template frequent");
    expect(container.querySelector(".picker-drag-handle")).toBeNull();
    expect(container.querySelector("[draggable='true']")).toBeNull();
  });

  it("filters before applying the frequent ordering", () => {
    const frequent = { ...createSession("frequent", 3, 300), tags: ["Work"] };
    const ordinary = { ...createSession("ordinary", 1, 100), tags: ["Work"] };
    const hiddenFrequent = { ...createSession("hidden", 5, 500), tags: ["Personal"] };
    const { container } = render(
      <I18nProvider locale="zh-CN">
        <SessionPickerModal
          pendingSessions={[ordinary, hiddenFrequent, frequent]}
          runningSessions={[]}
          pickerManual
          onLaunch={vi.fn()}
          onStartFresh={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onEdit={vi.fn()}
          onImport={vi.fn()}
          onExport={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Work" })[0]);
    expect(Array.from(container.querySelectorAll(".picker-item-title")).map((item) => item.textContent))
      .toEqual(["Template frequent", "Template ordinary"]);

    fireEvent.change(screen.getByPlaceholderText("搜索会话或标签..."), { target: { value: "ordinary" } });
    expect(container.querySelector(".picker-frequent-badge")).toBeNull();
    expect(container.querySelectorAll(".picker-item")).toHaveLength(1);
  });
});
