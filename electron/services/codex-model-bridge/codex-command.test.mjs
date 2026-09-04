import { describe, expect, it } from "vitest";
import commandModule from "./codex-command.cjs";

const { buildCodexBackendCommand } = commandModule;

describe("Codex backend command", () => {
  it("configures OpenRouter without embedding the API key", () => {
    const command = buildCodexBackendCommand({ type: "windows", shell: "powershell.exe" }, {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      apiKey: "secret-value",
      catalogPath: "C:\\Data\\openrouter-models.json",
      model: "anthropic/claude-sonnet-4"
    });
    expect(command).toContain("model_provider=openrouter");
    expect(command).toContain("wire_api=responses");
    expect(command).toContain("anthropic/claude-sonnet-4");
    expect(command).not.toContain("secret-value");
  });

  it("configures NaraRouter and disables unsupported web search", () => {
    const command = buildCodexBackendCommand({ type: "windows", shell: "powershell.exe" }, {
      providerId: "nararouter",
      providerName: "NaraRouter",
      baseUrl: "https://router.bynara.id/v1",
      apiKeyEnv: "NARAROUTER_API_KEY",
      apiKey: "secret-value",
      catalogPath: "C:\\Data\\nararouter-models.json",
      model: "gpt-test"
    });
    expect(command).toContain("model_provider=nararouter");
    expect(command).toContain("model_providers.nararouter.name=NaraRouter");
    expect(command).toContain('web_search="disabled"');
    expect(command).not.toContain("secret-value");
  });

  it("configures CodeBuddy without embedding the session token", () => {
    const command = buildCodexBackendCommand({ type: "windows", shell: "powershell.exe" }, {
      providerId: "codebuddy",
      providerName: "CodeBuddy",
      baseUrl: "http://127.0.0.1:4567/v1",
      apiKeyEnv: "PANNEL_HANDLE_CODEBUDDY_CODEX_KEY",
      apiKey: "session-secret",
      catalogPath: "C:\\Data\\codebuddy-models.json",
      model: "glm-5.3"
    });
    expect(command).toContain("model_providers.codebuddy.wire_api=responses");
    expect(command).toContain("glm-5.3");
    expect(command).not.toContain("session-secret");
  });
});
