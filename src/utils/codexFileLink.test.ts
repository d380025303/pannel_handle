import { describe, expect, it } from "vitest";
import { resolveCodexFileLink } from "./codexFileLink";

describe("resolveCodexFileLink", () => {
  it("resolves project paths and source line references", () => {
    expect(resolveCodexFileLink("C:\\repo", "src/App.tsx:42")).toEqual({ kind: "file", path: "C:\\repo\\src\\App.tsx", line: 42 });
    expect(resolveCodexFileLink("C:\\repo", "C:/repo/src/App.tsx#L12C3")).toEqual({ kind: "file", path: "C:\\repo\\src\\App.tsx", line: 12 });
    expect(resolveCodexFileLink("/srv/repo", "src/App.tsx#L9")).toEqual({ kind: "file", path: "/srv/repo/src/App.tsx", line: 9 });
    expect(resolveCodexFileLink("C:\\repo", "file:///C:/repo/docs/Guide%20One.md")).toEqual({ kind: "file", path: "C:\\repo\\docs\\Guide One.md" });
  });

  it("keeps web links external and rejects paths outside the workspace", () => {
    expect(resolveCodexFileLink("C:\\repo", "https://example.com/docs")).toEqual({ kind: "external", url: "https://example.com/docs" });
    expect(resolveCodexFileLink("C:\\repo", "../outside.txt").kind).toBe("error");
    expect(resolveCodexFileLink("/srv/repo", "/tmp/outside.txt").kind).toBe("error");
    expect(resolveCodexFileLink("C:\\repo", "mailto:a@example.com")).toEqual({ kind: "ignore" });
    expect(resolveCodexFileLink("C:\\repo", "src/App.tsx:0").kind).toBe("error");
  });
});
