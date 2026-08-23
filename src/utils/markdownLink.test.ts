import { describe, expect, it } from "vitest";
import { resolveMarkdownLink } from "./markdownLink";

describe("resolveMarkdownLink", () => {
  it("resolves Windows links relative to the Markdown file", () => {
    expect(resolveMarkdownLink("C:\\workspace\\docs\\README.md", "../guides/Setup%20Guide.md#install"))
      .toEqual({ kind: "file", path: "C:\\workspace\\guides\\Setup Guide.md" });
    expect(resolveMarkdownLink("C:\\workspace\\README.md", "/docs/guide.md"))
      .toEqual({ kind: "file", path: "C:\\docs\\guide.md" });
  });

  it("resolves POSIX links and normalizes parent segments", () => {
    expect(resolveMarkdownLink("/home/me/docs/README.md", "./api/../guide.md?raw=1"))
      .toEqual({ kind: "file", path: "/home/me/docs/guide.md" });
  });

  it("supports absolute file URLs", () => {
    expect(resolveMarkdownLink("C:\\workspace\\README.md", "file:///C:/workspace/Guide%20One.md#top"))
      .toEqual({ kind: "file", path: "C:\\workspace\\Guide One.md" });
  });

  it("separates external links from ignored links", () => {
    expect(resolveMarkdownLink("/home/me/README.md", "https://example.com/docs?q=1"))
      .toEqual({ kind: "external", url: "https://example.com/docs?q=1" });
    expect(resolveMarkdownLink("/home/me/README.md", "#details")).toEqual({ kind: "ignore" });
    expect(resolveMarkdownLink("/home/me/README.md", "mailto:test@example.com")).toEqual({ kind: "ignore" });
  });
});
