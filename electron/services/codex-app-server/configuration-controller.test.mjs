import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const { createConfigurationController, legacyOptions } = createRequire(import.meta.url)("./configuration-controller.cjs");
function fixture(respond) {
  const request = vi.fn(respond);
  const controller = createConfigurationController({ request, cwd: () => "/project", check: () => {} });
  return { request, controller };
}
describe("Codex configuration", () => {
  it("paginates profiles, resolves the project and never exposes secrets from config layers", async () => {
    const { controller, request } = fixture((method, params) => {
      if (method === "configRequirements/read") return { requirements: null };
      if (method === "permissionProfile/list") return { data: [{ id: params.cursor ? "denied" : "project", allowed: !params.cursor }], nextCursor: params.cursor ? null : "next" };
      return { config: { model: "model", model_provider: "openai", env: { KEY: "secret" }, model_providers: { x: { api_key: "secret" } }, features: { apps: true, token: "secret" } },
        layers: [{ name: { type: "project", dotCodexFolder: "/project/.codex" }, config: { model: "model", http_headers: { Authorization: "secret" } } }] };
    });
    const result = await controller.load(true);
    expect(result.profiles.data).toHaveLength(2);
    expect(result.requirements.data).toBeNull();
    expect(result.config.data.layers[0].path).toBe("/project/.codex");
    expect(JSON.stringify(result)).not.toMatch(/secret|api_key|Authorization/);
    expect(request).toHaveBeenCalledWith("config/read", { cwd: "/project", includeLayers: true });
    expect(controller.validate("project", "fullAccess")).toEqual({ permissions: "project" });
    expect(() => controller.validate("denied", "readOnly")).toThrow("禁止");
  });
  it("keeps failures separate from unrestricted admin requirements and permits legacy fallback on old CLI", async () => {
    const { controller } = fixture(method => {
      if (method === "configRequirements/read") throw new Error("Bearer secret");
      if (method === "permissionProfile/list") throw Object.assign(new Error("no method"), { code: -32601 });
      return { config: { model: "model" } };
    });
    const result = await controller.load(true);
    expect(result.requirements.status).toBe("error");
    expect(result.profiles.status).toBe("unsupported");
    expect(result.config.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(controller.validate(null, "askApproval").sandboxPolicy.type).toBe("workspaceWrite");
    expect(() => controller.validate("missing", "readOnly")).toThrow("无法验证");
  });
  it("normalizes policy spellings and treats empty allowlists as deny-all, including Plan", async () => {
    expect(legacyOptions({ allowedApprovalPolicies: ["onRequest"], allowedSandboxModes: ["workspace-write"] }).filter(v => v.allowed).map(v => v.id)).toEqual(["askApproval"]);
    const { controller } = fixture(method => method === "configRequirements/read" ? { requirements: { allowedSandboxModes: [] } } : { data: [{ id: "named", allowed: true }] });
    await controller.load();
    expect(() => controller.validate(null, "fullAccess")).toThrow("管理员");
    expect(() => controller.validate("named", "fullAccess", true)).toThrow("Plan");
  });
  it("rejects repeated cursors and stale refresh results", async () => {
    const { controller } = fixture(method => method === "configRequirements/read" ? { requirements: null } : { data: [], nextCursor: "same" });
    expect((await controller.load()).profiles.status).toBe("error");
    let release;
    let first = true;
    const next = fixture(method => {
      if (method === "permissionProfile/list") return { data: [] };
      if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
      return { requirements: null };
    });
    const old = next.controller.load();
    const assertion = expect(old).rejects.toThrow("已刷新");
    await next.controller.load(); release({ requirements: null }); await assertion;
  });
});
