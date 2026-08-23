import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { normalizeGeminiQuota } = require("./gemini-usage-client.cjs");

describe("Gemini usage client", () => {
  it("normalizes percentage, amount, total, and reset time without exposing credentials", () => {
    const snapshot = normalizeGeminiQuota({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.25, remainingAmount: "50", resetTime: "2026-08-24T00:00:00Z" }] }, 123);
    expect(snapshot).toEqual({
      provider: "gemini",
      fetchedAt: 123,
      primaryLimitId: "gemini-2.5-pro",
      limits: [expect.objectContaining({ id: "gemini-2.5-pro", remainingPercent: 25, usedPercent: 75, remainingAmount: 50, totalAmount: 200, usedAmount: 150 })]
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/access|refresh|credential/i);
  });
});
