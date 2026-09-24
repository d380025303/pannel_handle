// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("passes local file URLs to a controlled click handler", () => {
    const onLinkClick = vi.fn();
    render(<MarkdownBlock content="[Source](file:///C:/repo/src/App.tsx#L12)" onLinkClick={onLinkClick} />);
    expect(fireEvent.click(screen.getByRole("link", { name: "Source" }))).toBe(false);
    expect(onLinkClick).toHaveBeenCalledWith("file:///C:/repo/src/App.tsx#L12");
  });

  it("shows an App Server link address on hover and copies it without opening the link", async () => {
    const onLinkClick = vi.fn();
    const writeText = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "clipboardApi", { configurable: true, value: { writeText } });
    render(<MarkdownBlock content="[会话服务](https://example.com/app-server?view=full)" onLinkClick={onLinkClick} linkActions />);
    const link = screen.getByRole("link", { name: "会话服务" });
    expect(screen.queryByRole("button", { name: "复制链接地址" })).toBeNull();
    fireEvent.mouseEnter(link.parentElement!);
    expect(screen.getByText("https://example.com/app-server?view=full")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制链接地址" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://example.com/app-server?view=full"));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "已复制");
    expect(onLinkClick).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onLinkClick).toHaveBeenCalledWith("https://example.com/app-server?view=full");
  });

  it("shows relative addresses on focus and reports clipboard failure", async () => {
    const writeText = vi.fn().mockResolvedValue(false);
    Object.defineProperty(window, "clipboardApi", { configurable: true, value: { writeText } });
    render(<MarkdownBlock content="[源码](src/App.tsx:42)" onLinkClick={vi.fn()} linkActions />);
    const link = screen.getByRole("link", { name: "源码" });
    fireEvent.focus(link);
    expect(screen.getByText("src/App.tsx:42")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制链接地址" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "复制失败");
    expect(writeText).toHaveBeenCalledWith("src/App.tsx:42");
  });
});
