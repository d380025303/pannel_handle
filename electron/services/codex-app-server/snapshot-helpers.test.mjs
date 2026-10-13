import { describe, expect, it } from "vitest";
import helpers from "./snapshot-helpers.cjs";

const { appendItemSummary, itemSummary } = helpers;

describe("streaming activity summaries", () => {
  it("matches the full summary at every boundary, including partial tags and whitespace", () => {
    const text = ` \t<PrOpOsEd_PlAn>\n${"a".repeat(498)} \r\n😀正文</proposed_plan>\t\n继续<<proposed_plan>末尾</proposed_planX> `;
    for (const type of ["agentMessage", "plan"]) {
      for (const size of [1, 2, 7, 35, 500]) {
        const item = { type, text: "初始 \n" };
        for (let offset = 0; offset < text.length; offset += size) {
          const delta = text.slice(offset, offset + size);
          const summary = appendItemSummary(item, delta);
          item.text += delta;
          expect(summary).toBe(itemSummary(item));
          expect(summary.length).toBeLessThanOrEqual(500);
        }
      }
    }
  });

  it("keeps item caches independent and seeds replacement items from authoritative text", () => {
    const first = { type: "agentMessage", text: "first <proposed_" };
    const second = { type: "plan", text: "second\n" };
    expect(appendItemSummary(first, "plan>answer")).toBe("first answer");
    expect(appendItemSummary(second, "plan")).toBe("second plan");
    expect(appendItemSummary({ ...first, text: "corrected\t" }, "answer")).toBe("corrected answer");
  });

  it("does not reread accumulated text after initializing a streaming item", () => {
    let reads = 0;
    const item = { type: "agentMessage", get text() { reads += 1; return ""; } };
    let summary;
    for (let index = 0; index < 8192; index += 1) summary = appendItemSummary(item, "x".repeat(35));
    expect(reads).toBe(1);
    expect(summary).toBe(`…${"x".repeat(499)}`);
  });
});
