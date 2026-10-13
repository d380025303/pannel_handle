import { describe, expect, it } from "vitest";
import helpers from "./snapshot-helpers.cjs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const { appendItemSummary, itemSummary } = helpers;

describe("user message attachments", () => {
  const display = text => helpers.displayItem({ type: "userMessage", content: [{ type: "text", text }] });
  const marker = "请读取以下附件文件：";

  it("decodes multiple JSON paths and preserves the message body", () => {
    const paths = ['C:\\project\\带空格 notes.txt', '/tmp/quote"slash\\tab\tline\n.txt', ""];
    const result = display(`检查\n第二行  \n\n${marker}${paths.map(value => JSON.stringify(value)).join("、")}`);
    expect(result.text).toBe("检查\n第二行");
    expect(result.parts).toEqual([{ type: "text", text: "检查\n第二行" }]);
    expect(result.attachments).toEqual(paths.map(value => ({ path: value, name: path.basename(value) })));
    expect(display(`${marker}"\\u4e2d.txt"`).attachments).toEqual([{ path: "中.txt", name: "中.txt" }]);
  });

  it.each(['', '"unfinished', '"bad\\q"', '"bad\\u12xz"', '"raw\nnewline"', '"ok"、', '"ok", "other"', ' "ok"', '"ok" trailing', '"ok"、"bad\\q"', '"ok"、"unfinished'])
    ("preserves invalid references without partially adding attachments: %j", references => {
      const raw = `${marker}${references}`;
      expect(display(raw)).toMatchObject({ text: raw, attachments: [], parts: [{ type: "text", text: raw }] });
    });

  it.each(["普通文本", `正文${marker}"file"`, `正文\n${marker}"file"`])("preserves ordinary text: %j", raw => {
    expect(display(raw)).toMatchObject({ text: raw, attachments: [], parts: [{ type: "text", text: raw }] });
  });

  it("handles growing unterminated escaped strings within a bounded time", () => {
    const start = performance.now();
    for (const bytes of [8192, 16384, 32768, 65536]) {
      const raw = `${marker}"${'\\"'.repeat(bytes / 2)}`;
      expect(display(raw)).toMatchObject({ text: raw, attachments: [] });
    }
    // Generous ceiling for CI; the old scanner takes seconds for these inputs.
    expect(performance.now() - start).toBeLessThan(500);
  });
});

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
