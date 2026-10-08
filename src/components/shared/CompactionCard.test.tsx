// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { CompactionCard } from "./CompactionCard";

it("renders collapsed Markdown summary and failure details", () => {
  const view = render(<CompactionCard className="graphical-card" item={{ status: "completed", compactionSummary: [{ type: "text", text: "**Retained context**" }] }} />);
  expect(screen.getByText("上下文压缩完成")).toBeTruthy();
  expect(view.container.querySelector("details")?.open).toBe(false);
  expect(view.container.querySelector("strong")?.textContent).toBe("Retained context");
  view.rerender(<CompactionCard className="graphical-card" item={{ status: "failed", compactionError: "provider failure", compactionSource: "Explore" }} />);
  expect(screen.getByRole("alert").textContent).toBe("provider failure");
  expect(view.container.querySelector("details")).toBeNull();
});
