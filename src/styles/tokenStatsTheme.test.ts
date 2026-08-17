import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const featuresCss = readFileSync(resolve(process.cwd(), "src/styles/features.css"), "utf8");
const tokensCss = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const tokenStatsCss = featuresCss.match(/\.token-stats-page[\s\S]*?(?=\n@media)/)?.[0] ?? "";

describe("token stats theme styles", () => {
  it("only references defined theme tokens", () => {
    const references = [...tokenStatsCss.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]);
    const definitions = new Set([...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));

    expect([...new Set(references)].filter((token) => !definitions.has(token))).toEqual([]);
  });

  it("gives native dropdown options an explicit theme background and text color", () => {
    expect(tokenStatsCss).toMatch(/\.token-stats-actions select option\s*{[^}]*color:\s*var\(--color-text\);[^}]*background:\s*var\(--color-bg-panel\);[^}]*}/);
  });
});
