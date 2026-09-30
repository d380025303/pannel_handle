import { expect, it } from "vitest";
import { createRequire } from "node:module";
const { fileResourceLink, applyStructuredToolUpdate, resourceAttachment } = createRequire(import.meta.url)("./content-values.cjs");

it("encodes Windows, UNC and Agent POSIX file paths without losing reserved characters", () => {
  expect(fileResourceLink("C:\\work\\中文 #%.pdf", 12)).toEqual({ type: "resource_link",
    uri: "file:///C:/work/%E4%B8%AD%E6%96%87%20%23%25.pdf", name: "中文 #%.pdf", mimeType: "application/pdf", size: 12 });
  expect(fileResourceLink("/home/user/中文 #%.json", 3)).toMatchObject({
    uri: "file:///home/user/%E4%B8%AD%E6%96%87%20%23%25.json", name: "中文 #%.json", mimeType: "application/json" });
  expect(fileResourceLink("\\\\server\\share\\a b.bin", 0)).toMatchObject({
    uri: "file://server/share/a%20b.bin", mimeType: "application/octet-stream", size: 0 });
});

it("restores file attachment metadata from structured history resources", () => {
  for (const file of ["C:\\work\\中文 #%.txt", "/srv/app/中文 #%.txt", "\\\\server\\share\\a.txt"]) {
    const link = fileResourceLink(file, 3);
    expect(resourceAttachment(link)).toEqual({ path: file, name: link.name });
    expect(resourceAttachment({ type: "resource", resource: { uri: link.uri, text: "contents" } }))
      .toEqual({ path: file, name: link.name });
  }
  expect(resourceAttachment({ type: "resource_link", uri: "https://example.com/a" })).toBeNull();
});

it("preserves structured values across partial updates and clears explicitly empty content", () => {
  const item = {};
  const content = [{ type: "diff", path: "/work/a", oldText: null, newText: "new" },
    { type: "content", content: { type: "text", text: "done" } }];
  for (const value of [{ a: 1 }, [1, 2], "text", false, 0]) {
    applyStructuredToolUpdate(item, { rawInput: value, rawOutput: value, content, locations: [{ path: "/work/a", line: 2 }] });
    applyStructuredToolUpdate(item, { rawInput: null, rawOutput: null, status: "completed" });
    expect(item).toMatchObject({ arguments: value, result: value, toolContent: content, output: "done", locations: [{ path: "/work/a", line: 2 }] });
  }
  applyStructuredToolUpdate(item, { content: [], locations: [] });
  expect(item).toMatchObject({ toolContent: [], output: "", locations: [] });
});
