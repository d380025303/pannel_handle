// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteCodeEditor } from "./RemoteCodeEditor";

describe("RemoteCodeEditor theme", () => {
  afterEach(cleanup);

  it("uses a visible themed cursor while CodeMirror keeps its blink animation", () => {
    const { container } = render(
      <RemoteCodeEditor value="hello" fileName="example.txt" onChange={() => undefined} onSave={() => undefined} />
    );

    const editor = container.querySelector(".cm-editor");
    expect(editor).not.toBeNull();

    const themeRules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .join("\n");

    expect(container.querySelector<HTMLElement>(".cm-cursorLayer")?.style.animationDuration).toBe("900ms");
    expect(themeRules).toMatch(/\.cm-cursor[^}]*border-left:\s*2px solid var\(--color-text\)/);
    expect(themeRules).toMatch(/\.cm-cursor[^}]*drop-shadow\(0 0 2px var\(--color-accent\)\)/);
  });

  it("overrides CodeMirror selection colors with a subtle themed highlight", () => {
    render(
      <RemoteCodeEditor value="hello" fileName="example.txt" onChange={() => undefined} onSave={() => undefined} />
    );

    const themeRules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .join("\n");

    expect(themeRules).toMatch(
      /\.cm-selectionBackground[^}]*background-color:\s*color-mix\(in srgb, var\(--color-accent\) 18%, transparent\)/
    );
    expect(themeRules).toMatch(
      /\.cm-focused\s*>\s*\.cm-scroller\s*>\s*\.cm-selectionLayer\s+\.cm-selectionBackground[^}]*background-color:\s*color-mix\(in srgb, var\(--color-accent\) 18%, transparent\)/
    );
  });
});
