import { describe, expect, it } from "vitest";
import { formatOpenRouterPricing, formatPricePerMillion } from "./openRouterPricing";

describe("OpenRouter pricing formatting", () => {
  it("converts per-token prices to per-million-token prices", () => {
    expect(formatPricePerMillion("0.0000025", "en-US")).toBe("$2.5/M");
    expect(formatPricePerMillion("0", "zh-CN")).toBe("$0/M");
  });

  it("preserves very small non-zero prices", () => {
    expect(formatPricePerMillion("0.0000000000001", "en-US")).toBe("<$0.000001/M");
  });

  it("formats both prices and falls back when either one is unavailable", () => {
    const labels = { input: "input", output: "output", unavailable: "Pricing unavailable" };
    expect(formatOpenRouterPricing({ prompt: "0.000001", completion: "0.000004" }, "en-US", labels)).toBe("$1/M input · $4/M output");
    expect(formatOpenRouterPricing({ prompt: "0.000001" }, "en-US", labels)).toBe("Pricing unavailable");
  });
});
