// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { groupTimeline } from "./GraphicalPresentation";
import { CodexActivityEvent } from "../../src/components/shared/CodexActivityEvent";
afterEach(cleanup);
it("keeps Codex activities visible independently and renders their details", () => {
  const items = [{ id: "s", type: "sleep", durationMs: 0, status: "inProgress" },
    { id: "i", type: "imageGeneration", savedPath: "/tmp/image.png", status: "completed" }];
  expect(groupTimeline(items, "codex").map(entry => entry.kind)).toEqual(["item", "item"]);
  expect(groupTimeline(items, "opencode")).toEqual([]);
  render(<>{items.map(item => <CodexActivityEvent key={item.id} item={item} className="graphical-card" />)}</>);
  expect(screen.getByText("等待时长：0 秒")).toBeTruthy();
  expect(screen.getByText("进行中")).toBeTruthy();
  expect(screen.getByText("结果路径：/tmp/image.png")).toBeTruthy();
});
