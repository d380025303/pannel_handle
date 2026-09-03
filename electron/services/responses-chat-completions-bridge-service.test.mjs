import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createResponsesChatCompletionsBridgeService } = require("./responses-chat-completions-bridge-service.cjs");
const services = [];

afterEach(async () => {
  while (services.length) await services.pop().shutdown();
});

function createService(fetchImpl) {
  const service = createResponsesChatCompletionsBridgeService({
    providerId: "nararouter",
    providerName: "NaraRouter",
    upstreamUrl: "https://router.bynara.id/v1/chat/completions",
    apiKeyEnv: "PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY",
    fetchImpl
  });
  services.push(service);
  return service;
}

describe("Responses Chat Completions bridge", () => {
  it("keeps the provider key in the main process and converts both streaming directions", async () => {
    const fetchImpl = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }, choices: [] })}`,
      "data: [DONE]",
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const service = createService(fetchImpl);
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "sk-nry-secret", model: "model-a", catalogPath: "C:\\catalog.json", providerId: "nararouter", providerName: "NaraRouter" });

    expect(launch.apiKey).not.toBe("sk-nry-secret");
    expect(launch.apiKeyEnv).toBe("PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY");
    const response = await fetch(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model-a", stream: true, store: false, input: "hello" })
    });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(responseText).toContain('"type":"response.completed"');
    expect(responseText).toContain('"input_tokens":4');
    expect(fetchImpl).toHaveBeenCalledWith("https://router.bynara.id/v1/chat/completions", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-nry-secret" })
    }));
    const chatBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(chatBody).toMatchObject({ model: "model-a", stream: true, messages: [{ role: "user", content: "hello" }] });
  });

  it("isolates registrations by model and invalidates the token on disconnect", async () => {
    const service = createService(vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })));
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "secret", model: "allowed" });
    service.bindSession("session-1", launch.registrationId);

    const wrongModel = await fetch(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "other", stream: true, input: "hello" })
    });
    expect(wrongModel.status).toBe(400);

    service.disconnect("session-1");
    const expired = await fetch(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "allowed", stream: true, input: "hello" })
    });
    expect(expired.status).toBe(401);
  });

  it("preserves upstream HTTP errors for provider diagnostics", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { type: "telegram_required", message: "Relink your account", request_id: "req-nara" } }), { status: 403, headers: { "content-type": "application/json" } }));
    const service = createService(fetchImpl);
    const response = await service.fetchResponses({ apiKey: "secret", body: { model: "model-a", input: "hello", stream: true } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { type: "telegram_required", message: "Relink your account", request_id: "req-nara" } });
  });
});
