// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { TerminalSession } from "../../vite-env";
import { TerminalPanel } from "./TerminalPanel";

describe("TerminalPanel", () => {
  it("preserves terminal hosts while an App Server session is shown", () => {
    const sessions = [
      { id: "terminal-1", runtimeMode: "terminal" },
      { id: "app-server-1", runtimeMode: "app-server" }
    ] as TerminalSession[];
    const hostRefs = { current: new Map<string, HTMLDivElement>() };
    const props = { sessions, hostRefs, onContextMenu: vi.fn(), onWheel: vi.fn(), sizeOwner: "desktop", onClaimSize: vi.fn() };
    const view = render(<I18nProvider locale="zh-CN"><TerminalPanel {...props} activeId="terminal-1" /></I18nProvider>);
    const host = view.container.querySelector('[data-session-id="terminal-1"]');
    expect(host).toBeTruthy();
    expect(hostRefs.current.get("terminal-1")).toBe(host);

    view.rerender(<I18nProvider locale="zh-CN"><TerminalPanel {...props} activeId={undefined} isVisible={false} /></I18nProvider>);
    expect(view.container.querySelector(".terminal-panel")?.getAttribute("style")).toContain("display: none");
    expect(view.container.querySelector('[data-session-id="terminal-1"]')).toBe(host);
    expect(view.container.querySelector('[data-session-id="app-server-1"]')).toBeNull();

    view.rerender(<I18nProvider locale="zh-CN"><TerminalPanel {...props} activeId="terminal-1" /></I18nProvider>);
    expect(view.container.querySelector('[data-session-id="terminal-1"]')).toBe(host);
    expect(hostRefs.current.get("terminal-1")).toBe(host);
  });
});
