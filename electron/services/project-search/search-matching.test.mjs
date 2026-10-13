import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { getLineMatches } from "./search-matching.cjs";

describe("fallback Unicode whole-word matching", () => {
  it("finds only independent Chinese words and preserves unrestricted matches", () => {
    const content = "中文\n中文abc\nabc中文";
    expect(getLineMatches(content, "中文", 10, { wholeWord: true }))
      .toEqual([{ lineNumber: 1, line: "中文", matchStart: 0, matchLength: 2 }]);
    expect(getLineMatches(content, "中文", 10).map((match) => match.lineNumber)).toEqual([1, 2, 3]);
  });

  it.each(["中文", "word", "123", "_"])("agrees with real ripgrep for %j boundaries", (query) => {
    const adjacent = ["a", "中", "1", "_", "\u0301", "\u203f", "\u200c", "\u200d", "𐐀", "!", " ", "😀"];
    const content = [query, ...adjacent.flatMap((char) => [`${char}${query}`, `${query}${char}`]), `a${query} ${query}!`].join("\n");
    const rg = spawnSync(rgPath, ["--json", "--word-regexp", "--fixed-strings", "--ignore-case", "--", query, "-"], {
      input: content, encoding: "utf8", windowsHide: true
    });
    expect(rg.error).toBeUndefined();
    expect(rg.status).toBe(0);
    const expected = rg.stdout.trim().split("\n").map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "match").map((entry) => entry.data.line_number);
    expect(getLineMatches(content, query, 100, { wholeWord: true }).map((match) => match.lineNumber)).toEqual(expected);
  });

  it("continues after rejected candidates and handles empty regex matches", () => {
    expect(getLineMatches("中文abc 中文!", "中文", 10, { wholeWord: true })[0].matchStart).toBe(6);
    expect(getLineMatches("a !", "", 10, { wholeWord: true, regex: true })[0].matchStart).toBe(2);
    expect(getLineMatches("aaa", "", 10, { wholeWord: true, regex: true })).toEqual([]);
  });
});
