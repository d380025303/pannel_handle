// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownBlock } from "./MarkdownBlock";

afterEach(cleanup);

describe("MarkdownBlock", () => {
  it("renders GFM content and highlighted code with semantic elements", () => {
    const content = [
      "# Guide",
      "",
      "> Important note",
      "",
      "- [x] Complete",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Mode | Safe |",
      "",
      "```ts",
      "const enabled = true;",
      "```"
    ].join("\n");

    const { container } = render(<MarkdownBlock className="markdown" content={content} />);

    expect(screen.getByRole("heading", { level: 1, name: "Guide" })).toBeTruthy();
    expect(screen.getByText("Important note").closest("blockquote")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(container.querySelector("pre code.hljs.language-ts")).toBeTruthy();
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
  });

  it("keeps custom link routing in control of navigation", () => {
    const onLinkClick = vi.fn();
    render(<MarkdownBlock content="[Guide](docs/guide.md)" onLinkClick={onLinkClick} />);

    expect(fireEvent.click(screen.getByRole("link", { name: "Guide" }))).toBe(false);
    expect(onLinkClick).toHaveBeenCalledWith("docs/guide.md");
  });
});
