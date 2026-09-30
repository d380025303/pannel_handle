// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseTurnDiff, TurnDiffCard } from "./TurnDiffCard";

afterEach(cleanup);

const diff = [
  "diff --git a/src/old.ts b/src/new.ts",
  "similarity index 95%",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -10,2 +10,3 @@ function example() {",
  " unchanged",
  "-before",
  "+after",
  "+  a very long line of code that should wrap inside the card",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "new file mode 100644",
  "Binary files /dev/null and b/assets/logo.png differ"
].join("\n");

describe("TurnDiffCard", () => {
  it("groups files and preserves line numbers, metadata and counts", () => {
    const files = parseTurnDiff(diff)!;
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "src/new.ts", oldPath: "src/old.ts", additions: 2, deletions: 1 });
    expect(files[0].lines.filter(line => line.kind === "context")).toMatchObject([{ oldNumber: 10, newNumber: 10 }]);
    expect(files[0].lines.filter(line => line.kind === "delete")).toMatchObject([{ oldNumber: 11 }]);
    expect(files[0].lines.filter(line => line.kind === "add")).toMatchObject([{ newNumber: 11 }, { newNumber: 12 }]);
    expect(files[1].lines.map(line => line.text)).toContain("Binary files /dev/null and b/assets/logo.png differ");
  });

  it("defaults every file to collapsed and allows each file to expand and collapse", () => {
    const { container } = render(<TurnDiffCard diff={{ turnId: "turn-1", diff, updatedAt: 1 }} />);
    const card = container.querySelector<HTMLDetailsElement>(".codex-app-server-turn-diff")!;
    expect(card.open).toBe(false);
    fireEvent.click(screen.getByText("本轮变更"));
    expect(card.open).toBe(true);
    expect(screen.getByText("2 个文件")).toBeTruthy();
    expect(screen.getByText("src/old.ts → src/new.ts")).toBeTruthy();
    expect(screen.getByText("a very long line of code that should wrap inside the card", { exact: false })).toBeTruthy();
    const sections = container.querySelectorAll<HTMLDetailsElement>(".codex-app-server-diff-file");
    expect(sections).toHaveLength(2);
    expect(Array.from(sections).every(section => !section.open)).toBe(true);
    expect(within(sections[1]).getByText("Binary files /dev/null and b/assets/logo.png differ")).toBeTruthy();
    fireEvent.click(within(sections[0]).getByText("src/old.ts → src/new.ts"));
    expect(sections[0].open).toBe(true);
    expect(sections[1].open).toBe(false);
    fireEvent.click(within(sections[0]).getByText("src/old.ts → src/new.ts"));
    expect(sections[0].open).toBe(false);
  });

  it("preserves an expanded file on diff updates and collapses new files", async () => {
    const { container, rerender } = render(<TurnDiffCard diff={{ turnId: "turn-1", diff, updatedAt: 1 }} />);
    fireEvent.click(screen.getByText("本轮变更"));
    const first = container.querySelector<HTMLDetailsElement>(".codex-app-server-diff-file")!;
    fireEvent.click(within(first).getByText("src/old.ts → src/new.ts"));
    await waitFor(() => expect(first.open).toBe(true));
    fireEvent(first, new Event("toggle"));

    const updatedDiff = diff.replace("+after", "+updated") + "\n" + [
      "diff --git a/src/added.ts b/src/added.ts", "--- /dev/null", "+++ b/src/added.ts",
      "@@ -0,0 +1 @@", "+new file"
    ].join("\n");
    rerender(<TurnDiffCard diff={{ turnId: "turn-1", diff: updatedDiff, updatedAt: 2 }} />);
    const sections = container.querySelectorAll<HTMLDetailsElement>(".codex-app-server-diff-file");
    expect(sections).toHaveLength(3);
    expect(sections[0].open).toBe(true);
    expect(within(sections[0]).getByText("updated")).toBeTruthy();
    expect(sections[1].open).toBe(false);
    expect(sections[2].open).toBe(false);
  });

  it("keeps empty and unrecognized diffs readable", () => {
    expect(parseTurnDiff("diff --git a/a b/a")).toBeNull();
    const { rerender } = render(<TurnDiffCard diff={{ turnId: "turn-1", diff: "diff --git a/a b/a", updatedAt: 1 }} />);
    expect(screen.getByText("diff --git a/a b/a")).toBeTruthy();
    rerender(<TurnDiffCard diff={{ turnId: "turn-1", diff: "", updatedAt: 2 }} />);
    expect(screen.getByText("本轮暂无文件差异。")).toBeTruthy();
  });

  it("treats header-like source lines as changes inside a hunk", () => {
    const files = parseTurnDiff([
      "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@",
      "--- removed heading", "+++ added heading"
    ].join("\n"))!;
    expect(files[0]).toMatchObject({ path: "a.txt", additions: 1, deletions: 1 });
    expect(files[0].lines.slice(-2)).toMatchObject([
      { kind: "delete", text: "-- removed heading", oldNumber: 1 },
      { kind: "add", text: "++ added heading", newNumber: 1 }
    ]);
  });
});
