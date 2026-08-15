// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";

const featureStyles = readFileSync(path.join(process.cwd(), "src/styles/features.css"), "utf8");

function getRules(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return featureStyles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";
}

function getPadding(selector: string) {
  const match = getRules(selector).match(/padding:\s*(\d+)px/);
  return Number(match?.[1] ?? 0);
}

describe("terminal fit layout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps every fitted row and column inside the visible terminal content box", () => {
    const hostPadding = getPadding(".terminal-host");
    const terminalPadding = getPadding(".terminal-host .xterm");
    const host = document.createElement("div");
    const terminalElement = document.createElement("div");
    host.appendChild(terminalElement);

    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const padding = element === host ? hostPadding : terminalPadding;
      const values: Record<string, string> = {
        height: "240px",
        width: "800px",
        "padding-top": `${padding}px`,
        "padding-right": `${padding}px`,
        "padding-bottom": `${padding}px`,
        "padding-left": `${padding}px`
      };
      return {
        getPropertyValue: (property: string) => values[property] ?? "0px"
      } as CSSStyleDeclaration;
    });

    const terminal = {
      element: terminalElement,
      options: { scrollback: 0 },
      _core: {
        _renderService: {
          dimensions: { css: { cell: { width: 10, height: 10 } } }
        }
      }
    } as unknown as Terminal;
    const fitAddon = new FitAddon();
    fitAddon.activate(terminal);

    const dimensions = fitAddon.proposeDimensions();
    expect(dimensions).toBeDefined();

    const visibleWidth = 800 - (hostPadding + terminalPadding) * 2;
    const visibleHeight = 240 - (hostPadding + terminalPadding) * 2;
    expect(dimensions!.cols * 10).toBeLessThanOrEqual(visibleWidth);
    expect(dimensions!.rows * 10).toBeLessThanOrEqual(visibleHeight);
  });
});
