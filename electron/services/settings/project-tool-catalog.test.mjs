import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { z } = require("zod");
const { listProjectTools } = require("./project-tool-catalog.cjs");
const { TOOLS } = require("../module-owners/module-owner-service.cjs");
const { SESSION_TOOLS } = require("../mcp/session-tool-definitions.cjs");
const { REMOTE_TOOLS } = require("../../ssh/remote-agent-bridge-service.cjs");
describe("project tool catalog", () => {
  it("exposes every registered tool and uses the execution schemas", () => {
    const tools = listProjectTools();
    expect(tools).toHaveLength(14);
    expect(new Set(tools.map(tool => tool.name)).size).toBe(14);
    for (const tool of [...TOOLS, ...REMOTE_TOOLS]) expect(tools.find(entry => entry.name === tool.name).inputSchema).toEqual(tool.inputSchema);
    for (const [name, tool] of Object.entries(SESSION_TOOLS)) expect(tools.find(entry => entry.name === name).inputSchema).toEqual(z.toJSONSchema(tool.inputSchema));
  });
  it("provides valid examples and isolated, credential-free descriptions", () => {
    const tools = listProjectTools();
    for (const tool of tools) {
      expect(z.fromJSONSchema(tool.inputSchema).safeParse(tool.example).success, tool.name).toBe(true);
      expect(tool.resultExample, tool.name).toBeDefined();
      expect(JSON.parse(JSON.stringify(tool.resultExample))).toEqual(tool.resultExample);
      expect(tool.conditions["zh-CN"]).toBeTruthy();
      expect(tool.conditions["en-US"]).toBeTruthy();
    }
    expect(JSON.stringify(tools)).not.toMatch(/[a-f0-9]{64}|Authorization: Bearer|127\.0\.0\.1/);
    tools[0].resultExample[0].version = 999;
    expect(listProjectTools()[0].resultExample[0].version).toBe(1);
    expect(tools.find(tool => tool.name === "delete_module_owner").resultExample).not.toHaveProperty("record");
    expect(tools.find(tool => tool.name === "add_module_owner").resultExample.record.id).toBe("<OWNER_ID>");
    tools[0].inputSchema.type = "changed";
    expect(listProjectTools()[0].inputSchema.type).toBe("object");
  });
});
