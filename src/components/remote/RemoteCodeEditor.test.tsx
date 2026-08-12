// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteCodeEditor } from "./RemoteCodeEditor";

const baseProps = {
  languageMode: "auto" as const,
  onChange: () => undefined,
  onLanguageModeChange: () => undefined,
  onSave: () => undefined
};

describe("RemoteCodeEditor theme", () => {
  afterEach(cleanup);

  it("uses a visible themed cursor while CodeMirror keeps its blink animation", () => {
    const { container } = render(
      <RemoteCodeEditor value="hello" fileName="example.txt" {...baseProps} />
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
      <RemoteCodeEditor value="hello" fileName="example.txt" {...baseProps} />
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

  it("auto-detects a language and applies semantic token highlighting", async () => {
    const { container } = render(
      <RemoteCodeEditor value={'const message = "hello";'} fileName="example.ts" {...baseProps} />
    );

    expect(container.querySelector("select")?.selectedOptions[0].textContent).toContain("TypeScript");
    await waitFor(() => expect(container.querySelectorAll(".cm-content span").length).toBeGreaterThan(0));

    const themeRules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .join("\n");
    expect(themeRules).toContain("var(--color-code-keyword)");
    expect(themeRules).toContain("var(--color-code-string)");
  });

  it("reports manual language and plain-text selections", () => {
    const changes: string[] = [];
    const { getByRole } = render(
      <RemoteCodeEditor
        value="server { listen 80; }"
        fileName="site.conf"
        {...baseProps}
        onLanguageModeChange={(mode) => changes.push(mode)}
      />
    );
    const select = getByRole("combobox", { name: "语言模式" });

    fireEvent.change(select, { target: { value: "language:Nginx" } });
    fireEvent.change(select, { target: { value: "plain" } });

    expect(changes).toEqual(["language:Nginx", "plain"]);
  });
});
