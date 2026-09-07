import { describe, expect, it, vi } from "vitest";
import { createLaunchTemplateService } from "./launch-template-service.cjs";

describe("launch template service", () => {
  it("launches every available member in order and continues after failures", async () => {
    const launchTemplateStore = {
      get: vi.fn(() => ({
        id: "launch-1",
        sessionTemplateIds: ["one", "missing", "broken", "two"]
      }))
    };
    const templates = new Map([
      ["one", { id: "one", title: "One" }],
      ["broken", { id: "broken", title: "Broken" }],
      ["two", { id: "two", title: "Two" }]
    ]);
    const sessionStore = { getTemplate: vi.fn((id) => templates.get(id)) };
    const agentSessionLauncher = {
      launchSession: vi.fn(async (template, options) => {
        expect(options).toEqual({ recordUsage: true });
        if (template.id === "broken") throw new Error("spawn failed");
        return { id: `running-${template.id}` };
      })
    };
    const service = createLaunchTemplateService({ launchTemplateStore, sessionStore, agentSessionLauncher });

    await expect(service.launch("launch-1")).resolves.toEqual({
      launchedSessionIds: ["running-one", "running-two"],
      failures: [
        { templateId: "missing", error: "Session template not found." },
        { templateId: "broken", title: "Broken", error: "spawn failed" }
      ]
    });
    expect(agentSessionLauncher.launchSession.mock.calls.map(([template]) => template.id))
      .toEqual(["one", "broken", "two"]);
  });

  it("rejects an unknown launch template", async () => {
    const service = createLaunchTemplateService({
      launchTemplateStore: { get: () => undefined },
      sessionStore: {},
      agentSessionLauncher: {}
    });
    await expect(service.launch("missing")).rejects.toThrow("Launch template not found");
  });
});
