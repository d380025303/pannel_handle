const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LIMIT = 2 * 1024 * 1024;
function bounded(value) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > LIMIT) throw new Error("MCP App 内容超过 2 MB。");
  return JSON.parse(text);
}

function createMcpApps({ current, request }) {
  const records = new Map();
  const grants = new Map();
  const calls = new Map();
  let lastThread;
  function context(threadId, itemId) {
    const entry = current();
    if (entry.session.type !== "windows" || entry.runtime.localBridge || entry.threadId !== threadId)
      throw new Error("MCP App 所属对话已失效。");
    const record = records.get(itemId);
    if (!record || record.threadId !== threadId) throw new Error("MCP App 已失效。");
    return { entry, record };
  }
  return {
    update(threadId, item, metadata, update) {
      if (!metadata || typeof metadata !== "object") return;
      if (lastThread !== threadId) { records.clear(); grants.clear(); calls.clear(); lastThread = threadId; }
      const previous = records.get(item.id);
      const data = bounded({ ...(previous?.threadId === threadId ? previous.data : {}), ...metadata });
      const match = /^mcp__(.+?)__(.+)$/.exec(data.toolName || update._meta?.["codebuddy.ai/toolName"] || item.toolName || "");
      if (!match || typeof data.toolResourceUri !== "string" || !data.toolResourceUri.startsWith("ui://")) return;
      records.set(item.id, { threadId, serverName: match[1], data });
      if (records.size > 100) records.delete(records.keys().next().value);
      // HTML stays in the owning main-process session, never in broadcast snapshots.
      item.mcpApp = { resourceUri: data.toolResourceUri, serverName: match[1], revision: (item.mcpApp?.revision || 0) + 1 };
      if (update.rawInput !== undefined) item.arguments = bounded(update.rawInput);
      if (data.toolResult !== undefined) item.result = bounded(data.toolResult);
    },
    load(threadId, itemId) {
      const { record } = context(threadId, itemId);
      return bounded(record.data);
    },
    async read(threadId, itemId, uri) {
      const { entry, record } = context(threadId, itemId);
      if (typeof uri !== "string" || uri.length > 4096 || !/^[a-z][a-z0-9+.-]*:/i.test(uri)) throw new Error("无效的 App 资源地址。");
      const result = await request(entry, "_codebuddy.ai/mcpUiReadResource", { sessionId: threadId, serverName: record.serverName, uri });
      context(threadId, itemId);
      return bounded(result);
    },
    async images(threadId, itemId, images) {
      const { entry } = context(threadId, itemId);
      if (!Array.isArray(images) || images.length > 10) throw new Error("最多回填 10 张图片。");
      const files = [];
      const directory = path.join(entry.session.cwd, ".pannel-handle-images");
      if (!path.isAbsolute(entry.session.cwd)) throw new Error("当前工作目录不支持图片回填。");
      try {
        for (const image of images) {
          const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[image?.mimeType];
          if (!ext || typeof image.data !== "string" || image.data.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("无效的 App 图片。");
          const buffer = Buffer.from(image.data, "base64");
          if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error("App 图片超过 10 MB。");
          const valid = ext === ".png" ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
            : ext === ".jpg" ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
            : ext === ".gif" ? /^GIF8[79]a/.test(buffer.toString("ascii", 0, 6))
            : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
          if (!valid) throw new Error("图片内容与格式不一致。");
          context(threadId, itemId);
          await fs.promises.mkdir(directory, { recursive: true });
          const file = path.join(directory, `mcp-app-${randomUUID()}${ext}`);
          await fs.promises.writeFile(file, buffer, { flag: "wx" });
          files.push(file);
        }
        context(threadId, itemId);
        for (const file of files) entry.pastedImages.add(file);
        return files;
      } catch (error) {
        await Promise.allSettled(files.map(file => fs.promises.unlink(file)));
        throw error;
      }
    },
    prepare(threadId, itemId, name, args) {
      const { record } = context(threadId, itemId);
      if (typeof name !== "string" || !name || name.length > 256 || name.includes("__")) throw new Error("无效的工具名称。");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("无效的工具参数。");
      for (const [token, grant] of grants) if (grant.expires < Date.now()) grants.delete(token);
      if (grants.size >= 20) throw new Error("待确认工具调用过多。");
      const token = randomUUID();
      grants.set(token, { threadId, itemId, name, args: bounded(args), expires: Date.now() + 120000 });
      return { token, serverName: record.serverName, toolName: name, arguments: bounded(args) };
    },
    async resolve(token, approved) {
      const grant = grants.get(token);
      grants.delete(token);
      if (!grant || grant.expires < Date.now()) throw new Error("工具授权已失效。");
      const { entry, record } = context(grant.threadId, grant.itemId);
      if (approved !== true) return { isError: true, content: [{ type: "text", text: "用户拒绝工具调用。" }] };
      calls.set(token, { ...grant, serverName: record.serverName });
      try {
        const result = await request(entry, "_codebuddy.ai/mcpUiCallTool", { sessionId: grant.threadId,
          serverName: record.serverName, toolName: grant.name, arguments: grant.args }, 120000);
        context(grant.threadId, grant.itemId);
        return bounded(result);
      } finally { calls.delete(token); }
    },
    async interruption(threadId, event) {
      if (event?.mcpUiIntercept !== true || typeof event.toolCallId !== "string") return false;
      const call = [...calls.values()].find(value => value.threadId === threadId
        && event.toolName === `mcp__${value.serverName}__${value.name}`
        && !value.interruptionHandled);
      if (!call) return false;
      const { entry } = context(threadId, call.itemId);
      call.interruptionHandled = true;
      // This exact reverse call was already approved in the host's one-time grant dialog.
      await request(entry, "_codebuddy.ai/resolveInterruption", { sessionId: threadId, toolCallId: event.toolCallId, decision: "allow" });
      return true;
    },
    dispose(threadId, itemId) {
      context(threadId, itemId);
      for (const [token, grant] of grants) if (grant.itemId === itemId) grants.delete(token);
    },
    clear() { records.clear(); grants.clear(); calls.clear(); }
  };
}

module.exports = { createMcpApps };
