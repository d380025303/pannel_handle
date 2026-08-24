import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createOpenRouterService } = require("./openrouter-service.cjs");

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

describe("openrouter-service", () => {
  it("validates the key without returning it", async () => {
    const fetchImpl = vi.fn(async () => response({ data: { label: "sk-or-...123", limit_remaining: 8 } }));
    const configStore = { getApiKey: () => "sk-or-secret", getConfig: () => ({ hasApiKey: true }) };
    const service = createOpenRouterService({ configStore, fetchImpl });

    await expect(service.testConnection()).resolves.toEqual({
      ok: true,
      config: { hasApiKey: true },
      keyLabel: "sk-or-...123",
      limitRemaining: 8,
      expiresAt: undefined
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", expect.objectContaining({
      headers: { Authorization: "Bearer sk-or-secret" }
    }));
  });

  it("returns cached text models with tool support only", async () => {
    let now = 100;
    const fetchImpl = vi.fn(async () => response({ data: [
      { id: "vendor/tools", name: "Tools", supported_parameters: ["tools"], architecture: { output_modalities: ["text"] }, context_length: 1000, pricing: { prompt: "0.1", completion: "0.2" } },
      { id: "vendor/no-tools", name: "No tools", supported_parameters: [], architecture: { output_modalities: ["text"] } },
      { id: "vendor/image", name: "Image", supported_parameters: ["tools"], architecture: { output_modalities: ["image"] } }
    ] }));
    const service = createOpenRouterService({ configStore: { getApiKey: () => "key" }, fetchImpl, now: () => now });

    const first = await service.listModels();
    now += 1000;
    const second = await service.listModels();

    expect(first.models).toEqual([{ id: "vendor/tools", name: "Tools", contextLength: 1000, promptPrice: "0.1", completionPrice: "0.2" }]);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps authentication and rate-limit errors without exposing credentials", async () => {
    const configStore = { getApiKey: () => "sk-or-secret" };
    await expect(createOpenRouterService({ configStore, fetchImpl: async () => response({}, 401) }).listModels())
      .rejects.toThrow("API Key 无效");
    await expect(createOpenRouterService({ configStore, fetchImpl: async () => response({}, 429) }).listModels())
      .rejects.toThrow("请求过于频繁");
  });

  it("does not replace the stored key when validation fails", async () => {
    const configStore = { setApiKey: vi.fn(), getConfig: () => ({ hasApiKey: false }) };
    const service = createOpenRouterService({ configStore, fetchImpl: async () => response({}, 401) });
    await expect(service.setApiKey("bad-key")).rejects.toThrow("API Key 无效");
    expect(configStore.setApiKey).not.toHaveBeenCalled();
  });
});
