const { z } = require("zod");
const toolsSchema = z.array(z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string().trim().min(1),
  inputSchema: z.object({ type: z.literal("object") }).passthrough()
}).strict()).min(1).max(64).refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length, "工具名称不能重复。");
const toolCallbackSchema = z.object({
  url: z.string().refine(value => {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  }, "回调地址必须为 HTTP/HTTPS 且不能包含凭据。"),
  bearerToken: z.string().min(1).regex(/^[\x21-\x7e]+$/).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(60000)
}).strict();

const sessionInstanceSchema = z.object({
  templateId: z.string().trim().min(1),
  mode: z.enum(["plan", "default"]),
  prompt: z.string().trim().min(1),
  agentProvider: z.enum(["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"]).optional(),
  modelId: z.string().trim().min(1).optional(),
  tools: toolsSchema.optional(),
  toolCallback: toolCallbackSchema.optional()
}).strict().refine(input => Boolean(input.tools) === Boolean(input.toolCallback), "工具与回调必须配套提供。");

module.exports = { sessionInstanceSchema };
