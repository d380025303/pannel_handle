import { describe, expect, it } from "vitest";
import bridge from "./codebuddy-codex-bridge-service.cjs";

const { parseCodeBuddyVersion, parseCodeBuddyModels, buildModelCatalog } = bridge;

describe("CodeBuddy Codex bridge metadata", () => {
  it("parses the pinned CLI version and concrete model list", () => {
    expect(parseCodeBuddyVersion("2.142.0\n")).toBe("2.142.0");
    expect(parseCodeBuddyModels("Currently supported: (auto, glm-5.3, minimax-m3, kimi-k3-1)")).toEqual(["glm-5.3", "minimax-m3", "kimi-k3-1"]);
  });

  it("builds a conservative Codex model catalog", () => {
    const catalog = buildModelCatalog([{ id: "glm-5.3", name: "glm-5.3" }]);
    expect(catalog.models[0]).toMatchObject({ slug: "glm-5.3", input_modalities: ["text"], context_window: 128000, apply_patch_tool_type: "freeform", shell_type: "shell_command" });
  });
});
