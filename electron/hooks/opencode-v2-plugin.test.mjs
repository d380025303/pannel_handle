import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createServer } from "node:http";


afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PANNEL_HANDLE_HOOK_URL;
  delete process.env.PANNEL_HANDLE_SESSION_ID;
  delete process.env.PANNEL_HANDLE_OPENCODE_CAPABILITIES;
});

it("reads skills and MCP tools from the active OpenCode plugin process", async () => {
  const source = fs.readFileSync(new URL("./hook-assets/pannel-handle-opencode-capabilities.js", import.meta.url), "utf8");
  const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const sent = [];
  const hook = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    sent.push(JSON.parse(body));
    response.writeHead(200).end();
  });
  await new Promise(resolve => hook.listen(0, "127.0.0.1", resolve));
  process.env.PANNEL_HANDLE_OPENCODE_CAPABILITIES = "1";
  process.env.PANNEL_HANDLE_HOOK_URL = `http://127.0.0.1:${hook.address().port}/claude-hook`;
  process.env.PANNEL_HANDLE_SESSION_ID = "panel-1";
  const stop = await plugin.setup({ location: { directory: "C:\\work" },
    skill: { list: async () => ({ data: [{ id: "review", name: "Review" }] }) },
    mcp: { list: async () => ({ data: [{ name: "files", status: "connected" }] }) },
    tool: { list: async () => [{ id: "files_read_file", description: "Read file" }], hook: async () => {} },
    event: { subscribe: async function* () {} } });
  await vi.waitFor(() => expect(sent[0]).toMatchObject({ event_name: "capabilities.endpoint",
    pannel_handle_session_id: "panel-1" }));
  const token = sent[0].token;
  expect((await fetch(`http://127.0.0.1:${sent[0].port}/capabilities`)).status).toBe(404);
  const response = await fetch(`http://127.0.0.1:${sent[0].port}/capabilities`,
    { headers: { Authorization: `Bearer ${token}` } });
  expect(await response.json()).toMatchObject({ skills: [{ id: "review" }], mcp: [{ name: "files" }],
    tools: [{ id: "files_read_file" }] });
  stop();
  hook.close();
});

it("reports V2 execution, tool, text, and token events through the existing Hook endpoint", async () => {
  const source = fs.readFileSync(new URL("./hook-assets/pannel-handle-opencode-plugin.js", import.meta.url), "utf8");
  const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const sent = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true };
  }));
  process.env.PANNEL_HANDLE_HOOK_URL = "http://127.0.0.1:9000/claude-hook";
  process.env.PANNEL_HANDLE_SESSION_ID = "panel-1";
  const hooks = new Map();
  const events = [
    { type: "session.execution.started", data: { sessionID: "ses-1" } },
    { type: "session.step.started", data: { sessionID: "ses-1", assistantMessageID: "msg-1", model: { id: "model-1" } } },
    { type: "session.text.ended", data: { sessionID: "ses-1", assistantMessageID: "msg-1", text: "Done" } },
    { type: "session.step.ended", created: 100, data: { sessionID: "ses-1", assistantMessageID: "msg-1", finish: "stop",
      tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { type: "session.execution.succeeded", data: { sessionID: "ses-1" } }
  ];
  const stop = await plugin.setup({
    location: { directory: "C:\\work" },
    tool: { hook: async (name, callback) => { hooks.set(name, callback); } },
    event: { subscribe: async function* () { yield* events; } }
  });
  hooks.get("execute.after")({ sessionID: "ses-1", tool: "pannel_handle_remote_read", status: "completed", result: { content: "ok" } });
  await vi.waitFor(() => expect(sent).toHaveLength(5));
  expect(sent.map(item => item.event_name)).toEqual(expect.arrayContaining([
    "session.status", "message.part.updated", "message.updated", "session.idle", "tool.execute.after"
  ]));
  expect(sent.find(item => item.event_name === "message.updated").info).toMatchObject({
    modelID: "model-1", tokens: { input: 3, output: 2 }
  });
  expect(sent.every(item => item.pannel_handle_session_id === "panel-1")).toBe(true);
  stop();
});
