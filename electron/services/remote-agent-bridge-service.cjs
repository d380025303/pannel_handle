const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_EVENTS = 300;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const REMOTE_AGENT_TOKEN_ENV = "PANNEL_HANDLE_REMOTE_AGENT_TOKEN";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function isPathInside(root, candidate) {
  return candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);
}

function normalizeRoot(value) {
  const root = path.posix.normalize(String(value || "").trim());
  if (!root || !root.startsWith("/") || root.includes("\0")) {
    throw new Error("本地 Agent 的远程工作目录必须是绝对 Linux 路径。");
  }
  return root;
}

function normalizeToolPath(root, value = ".") {
  const input = String(value || ".").trim() || ".";
  if (input.includes("\0")) throw new Error("远程路径无效。");
  const candidate = path.posix.normalize(input.startsWith("/") ? input : path.posix.join(root, input));
  if (!isPathInside(root, candidate)) {
    throw new Error("远程路径必须位于会话工作目录内。");
  }
  return candidate;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function toolResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function createRuntimeInstructions({ remoteRoot, hostLabel }) {
  return `# Remote workspace\n\nThe source of truth is the SSH workspace \`${remoteRoot}\` on \`${hostLabel}\`. This local directory only hosts the Codex session.\n\n1. Inspect remote files with \`remote_context\`, \`remote_list\`, \`remote_search\`, and \`remote_read_text\`.\n2. Change text files with \`remote_apply_patch\`; pass the version returned by the last read for every update or delete.\n3. Run repository commands with \`remote_exec\`. Treat its working directory as \`${remoteRoot}\`.\n4. Re-read a conflicted file before retrying. Finish only after the relevant remote checks pass.\n\nUse the remote tools for project work. Local shell and local files are not the remote project.\n`;
}

function createRemoteAgentBridgeService({
  terminalManager,
  sshSessionRuntime,
  remoteFileService,
  dialog,
  windowManager,
  workspacesRoot,
  broadcast,
  fsApi = fs,
  httpApi = http,
  now = () => Date.now()
}) {
  const bindingsByToken = new Map();
  const bindingsBySession = new Map();
  const auditBySession = new Map();
  let server = null;
  let port = 0;

  function emitAudit(sessionId, event) {
    const binding = bindingsBySession.get(sessionId);
    if (!binding || binding.closed) return;
    const secrets = [binding?.token, binding?.sshSecret]
      .filter((value) => typeof value === "string" && value.length >= 4);
    const redact = (value) => {
      if (typeof value !== "string") return value;
      let sanitized = value;
      for (const secret of secrets) sanitized = sanitized.split(secret).join("[REDACTED]");
      return sanitized.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
    };
    const payload = {
      sessionId,
      timestamp: now(),
      ...event,
      summary: redact(event.summary),
      output: redact(event.output),
      error: redact(event.error)
    };
    const events = auditBySession.get(sessionId) || [];
    events.push(payload);
    if (events.length > MAX_AUDIT_EVENTS) events.splice(0, events.length - MAX_AUDIT_EVENTS);
    auditBySession.set(sessionId, events);
    broadcast("remote-agent:audit", payload);
  }

  function listAudit(sessionId) {
    return [...(auditBySession.get(String(sessionId || "")) || [])];
  }

  function getBinding(token) {
    const binding = bindingsByToken.get(String(token || ""));
    if (!binding || binding.closed) throw new Error("远程 Agent 会话已失效。");
    const session = terminalManager.getSession(binding.sessionId);
    if (!session || session.type !== "ssh") throw new Error("SSH 会话已结束。");
    return binding;
  }

  async function resolveRealRoot(sessionId, root) {
    const client = await sshSessionRuntime.createSftpClient(sessionId, { actionName: "验证远程 Agent 工作目录" });
    try {
      const realRoot = path.posix.normalize(await client.realPath(root));
      const stat = await client.stat(realRoot);
      if (!stat || stat.isDirectory === false || stat.type === "-") {
        throw new Error("远程 Agent 工作目录不是目录。");
      }
      return realRoot;
    } finally {
      await client.end().catch(() => {});
    }
  }

  async function assertScopedPath(binding, requestedPath, options = {}) {
    const candidate = normalizeToolPath(binding.root, requestedPath);
    const client = await sshSessionRuntime.createSftpClient(binding.sessionId, { actionName: "验证远程路径" });
    try {
      let resolved;
      try {
        resolved = path.posix.normalize(await client.realPath(candidate));
        if (options.requireMissing) {
          const error = new Error("新建文件已经存在，请先读取并携带版本号后再修改。");
          error.code = "REMOTE_PATH_EXISTS";
          throw error;
        }
      } catch (error) {
        if (error?.code === "REMOTE_PATH_EXISTS") throw error;
        if (!options.allowMissing) throw error;
        const parent = path.posix.dirname(candidate);
        const realParent = path.posix.normalize(await client.realPath(parent));
        if (!isPathInside(binding.realRoot, realParent)) {
          throw new Error("远程路径通过符号链接越出了工作目录。");
        }
        resolved = path.posix.join(realParent, path.posix.basename(candidate));
      }
      if (!isPathInside(binding.realRoot, resolved)) {
        throw new Error("远程路径通过符号链接越出了工作目录。");
      }
      return candidate;
    } finally {
      await client.end().catch(() => {});
    }
  }

  async function authorizeMutation(binding, tool, summary) {
    if (binding.sessionMutationAllowed) return true;
    const prior = binding.approvalQueue || Promise.resolve();
    let resolveDecision;
    const decisionPromise = new Promise((resolve) => { resolveDecision = resolve; });
    binding.approvalQueue = prior.then(async () => {
      if (binding.closed) {
        resolveDecision(false);
        return;
      }
      if (binding.sessionMutationAllowed) {
        resolveDecision(true);
        return;
      }
      const result = await dialog.showMessageBox(windowManager.focusWindow(), {
        type: "warning",
        buttons: ["仅本次允许", "本会话允许", "拒绝"],
        defaultId: 0,
        cancelId: 2,
        title: "允许本地 Codex 操作远程服务器？",
        message: `${tool} 请求执行远程变更`,
        detail: String(summary || "").slice(0, 2000)
      });
      if (result.response === 1) binding.sessionMutationAllowed = true;
      const allowed = result.response === 0 || result.response === 1;
      emitAudit(binding.sessionId, {
        operationId: crypto.randomUUID(),
        kind: "approval",
        tool,
        status: allowed ? "allowed" : "denied",
        summary: String(summary || "").slice(0, 500)
      });
      resolveDecision(allowed);
    }).catch(() => resolveDecision(false));
    return decisionPromise;
  }

  function startOperation(binding, tool, summary) {
    const operationId = crypto.randomUUID();
    emitAudit(binding.sessionId, {
      operationId,
      kind: "operation",
      tool,
      status: "running",
      summary: String(summary || "").slice(0, 1000)
    });
    return operationId;
  }

  function finishOperation(binding, operationId, tool, status, detail = {}) {
    emitAudit(binding.sessionId, {
      operationId,
      kind: "operation",
      tool,
      status,
      ...detail
    });
  }

  async function withOperation(binding, tool, summary, task) {
    const operationId = startOperation(binding, tool, summary);
    try {
      const result = await task(operationId);
      finishOperation(binding, operationId, tool, "completed");
      return result;
    } catch (error) {
      finishOperation(binding, operationId, tool, "failed", { error: error?.message || String(error) });
      throw error;
    }
  }

  async function remoteSearch(binding, args) {
    const root = await assertScopedPath(binding, args.path || ".");
    const query = String(args.query || "").trim();
    if (!query || query.length > 500) throw new Error("搜索词无效。");
    const limit = clampInteger(args.limit, 200, 1, 500);
    const excludes = "-path './.git' -o -path './node_modules' -o -path './dist' -o -path './build'";
    let command;
    if (args.mode === "files") {
      command = `cd ${shellQuote(root)} && find . \\( ${excludes} \\) -prune -o -type f -print | grep -iF -- ${shellQuote(query)} | head -n ${limit}`;
    } else {
      command = `cd ${shellQuote(root)} && if command -v rg >/dev/null 2>&1; then rg --line-number --hidden --glob '!/.git/**' --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' --max-count ${limit} --fixed-strings -- ${shellQuote(query)} .; else grep -RInF --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build -m ${limit} -- ${shellQuote(query)} .; fi | head -n ${limit}`;
    }
    const output = await sshSessionRuntime.exec(binding.sessionId, `bash -lc ${shellQuote(command)}`, {
      actionName: "远程 Agent 搜索",
      timeoutMs: 30000,
      allowExitCodes: [0, 1]
    });
    return { root, mode: args.mode === "files" ? "files" : "text", output };
  }

  async function remoteApplyPatch(binding, args) {
    const changes = Array.isArray(args.changes) ? args.changes : [];
    if (!changes.length || changes.length > 50) throw new Error("远程补丁必须包含 1 到 50 个文件变更。");
    const prepared = [];
    for (const change of changes) {
      const requestedPath = String(change?.path || "");
      const deleting = change?.content === null;
      const creating = !deleting && !change?.expectedVersion;
      const remotePath = await assertScopedPath(binding, requestedPath, { allowMissing: creating, requireMissing: creating });
      if (!deleting && typeof change?.content !== "string") throw new Error(`文件内容无效：${requestedPath}`);
      if (deleting || change?.expectedVersion) {
        const current = await remoteFileService.readText(binding.sessionId, remotePath);
        if (current.kind !== "text") throw new Error(`只能修改文本文件：${requestedPath}`);
        if (!change.expectedVersion || current.version !== change.expectedVersion) {
          throw new Error(`文件已变化，请重新读取后重试：${requestedPath}`);
        }
        prepared.push({ remotePath, deleting, change, current });
      } else {
        prepared.push({ remotePath, deleting: false, change, current: null });
      }
    }

    const results = [];
    for (const item of prepared) {
      if (item.deleting) {
        await remoteFileService.deleteEntry(binding.sessionId, item.remotePath, { permanent: true });
        results.push({ path: item.change.path, status: "deleted" });
        continue;
      }
      const saved = await remoteFileService.writeText(
        binding.sessionId,
        item.remotePath,
        item.change.content,
        item.change.expectedVersion || "",
        {
          force: !item.change.expectedVersion,
          format: item.current ? { bom: item.current.bom, eol: item.current.eol } : { bom: false, eol: "lf" }
        }
      );
      if (saved.status === "conflict") throw new Error(`文件已变化，请重新读取后重试：${item.change.path}`);
      results.push({ path: item.change.path, status: "saved", version: saved.version, size: saved.size });
    }
    return { changes: results };
  }

  async function remoteExec(binding, args, operationId, requestId) {
    const command = String(args.command || "").trim();
    if (!command || command.length > 200000) throw new Error("远程命令无效。");
    const cwd = await assertScopedPath(binding, args.cwd || ".");
    const timeoutMs = clampInteger(args.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 1000, MAX_COMMAND_TIMEOUT_MS);
    const remoteCommand = `bash -lc ${shellQuote(`cd ${shellQuote(cwd)} && ${command}`)}`;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (kind, chunk) => {
      const value = String(chunk);
      const currentBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      const remaining = Math.max(0, MAX_COMMAND_OUTPUT_BYTES - currentBytes);
      if (remaining === 0) {
        truncated = true;
        return;
      }
      const accepted = Buffer.from(value).subarray(0, remaining).toString("utf-8");
      if (kind === "stdout") stdout += accepted; else stderr += accepted;
      if (accepted.length < value.length) truncated = true;
      emitAudit(binding.sessionId, {
        operationId,
        kind: "output",
        tool: "remote_exec",
        status: "streaming",
        stream: kind,
        output: accepted.slice(0, 16384)
      });
    };
    const handle = await sshSessionRuntime.execStreaming(binding.sessionId, remoteCommand, {
      connectTimeoutMs: 15000,
      stdin: typeof args.stdin === "string" ? args.stdin.slice(0, 65536) : undefined,
      onStdout: (chunk) => append("stdout", chunk),
      onStderr: (chunk) => append("stderr", chunk)
    });
    binding.activeCommands.set(String(requestId), handle);
    const timer = setTimeout(() => handle.cancel(), timeoutMs);
    try {
      const result = await handle.promise;
      return { cwd, exitCode: result.exitCode, signal: result.signal, stdout, stderr, truncated };
    } finally {
      clearTimeout(timer);
      binding.activeCommands.delete(String(requestId));
    }
  }

  const tools = [
    {
      name: "remote_context",
      description: "Return the SSH target and authoritative remote workspace root for this session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    {
      name: "remote_list",
      description: "List a directory inside the authoritative remote workspace.",
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Remote absolute path or path relative to the workspace root." } }, additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    {
      name: "remote_search",
      description: "Search remote file names or text without requiring ripgrep on the server.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          mode: { type: "string", enum: ["text", "files"] },
          limit: { type: "integer", minimum: 1, maximum: 500 }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    {
      name: "remote_read_text",
      description: "Read a UTF-8 remote text file. Preserve its version for remote_apply_patch.",
      inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    {
      name: "remote_apply_patch",
      description: "Create, replace, or delete remote text files. Updates and deletes require the version from remote_read_text; content null deletes a file.",
      inputSchema: {
        type: "object",
        required: ["changes"],
        properties: {
          changes: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: { type: "string" },
                expectedVersion: { type: "string" },
                content: { type: ["string", "null"], description: "Complete new UTF-8 content, or null to delete." }
              },
              additionalProperties: false
            }
          }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    {
      name: "remote_exec",
      description: "Run a command through a separate SSH channel rooted at the remote workspace. Use for Git, tests, builds, and system inspection.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          stdin: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: MAX_COMMAND_TIMEOUT_MS }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    }
  ];

  async function callTool(binding, name, args, requestId) {
    if (name === "remote_context") {
      const session = terminalManager.getSession(binding.sessionId);
      return { sessionId: binding.sessionId, type: "ssh", host: session.sshConfig?.host, username: session.sshConfig?.username, root: binding.root };
    }
    if (name === "remote_list") {
      return withOperation(binding, name, args.path || ".", async () => {
        const remotePath = await assertScopedPath(binding, args.path || ".");
        return { path: remotePath, entries: await remoteFileService.list(binding.sessionId, remotePath) };
      });
    }
    if (name === "remote_search") {
      return withOperation(binding, name, `${args.mode || "text"}: ${args.query}`, () => remoteSearch(binding, args));
    }
    if (name === "remote_read_text") {
      return withOperation(binding, name, args.path, async () => {
        const remotePath = await assertScopedPath(binding, args.path);
        const result = await remoteFileService.readText(binding.sessionId, remotePath);
        return { path: remotePath, ...result };
      });
    }
    if (name === "remote_apply_patch") {
      const summary = args.changes?.map((change) => change.path).join(", ") || "远程文件变更";
      if (!await authorizeMutation(binding, name, summary)) throw new Error("用户拒绝了远程文件变更。");
      return withOperation(binding, name, summary, () => remoteApplyPatch(binding, args));
    }
    if (name === "remote_exec") {
      if (!await authorizeMutation(binding, name, args.command)) throw new Error("用户拒绝了远程命令。");
      const operationId = startOperation(binding, name, args.command);
      try {
        const result = await remoteExec(binding, args, operationId, requestId);
        finishOperation(binding, operationId, name, result.exitCode === 0 ? "completed" : "failed", { exitCode: result.exitCode, signal: result.signal });
        return result;
      } catch (error) {
        finishOperation(binding, operationId, name, "failed", { error: error?.message || String(error) });
        throw error;
      }
    }
    throw new Error(`未知远程工具：${name}`);
  }

  function jsonResponse(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store"
    });
    response.end(body);
  }

  async function handleRpc(binding, message, response) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      jsonResponse(response, 400, { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (message.method === "notifications/cancelled") {
      binding.activeCommands.get(String(message.params?.requestId))?.cancel();
      response.writeHead(202, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    let result;
    try {
      if (message.method === "initialize") {
        const requestedVersion = String(message.params?.protocolVersion || "");
        result = {
          protocolVersion: [MCP_PROTOCOL_VERSION, "2024-11-05"].includes(requestedVersion)
            ? requestedVersion
            : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "pannel-handle-remote", version: "1.0.0" }
        };
      } else if (message.method === "ping") {
        result = {};
      } else if (message.method === "tools/list") {
        result = { tools };
      } else if (message.method === "tools/call") {
        result = toolResult(await callTool(binding, message.params?.name, message.params?.arguments || {}, message.id));
      } else {
        jsonResponse(response, 200, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Method not found" } });
        return;
      }
      jsonResponse(response, 200, { jsonrpc: "2.0", id: message.id ?? null, result });
    } catch (error) {
      if (message.method === "tools/call") {
        jsonResponse(response, 200, { jsonrpc: "2.0", id: message.id ?? null, result: toolResult(error?.message || String(error), true) });
      } else {
        jsonResponse(response, 200, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: error?.message || String(error) } });
      }
    }
  }

  function handleHttp(request, response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.url === "/mcp" && request.method === "GET") {
      response.writeHead(405, { "Allow": "POST", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }
    const auth = String(request.headers.authorization || "");
    if (!auth.startsWith("Bearer ")) {
      response.writeHead(401, { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    let binding;
    try {
      binding = getBinding(auth.slice(7));
    } catch {
      response.writeHead(401, { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) request.destroy(); else chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_REQUEST_BYTES) {
        if (!response.headersSent) response.writeHead(413);
        response.end();
        return;
      }
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        void handleRpc(binding, message, response);
      } catch {
        jsonResponse(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    });
  }

  async function start() {
    if (server?.listening) return port;
    server = httpApi.createServer(handleHttp);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    port = Number(server.address()?.port || 0);
    return port;
  }

  async function createBinding(sessionId) {
    await start();
    const session = terminalManager.getSession(sessionId);
    if (!session || session.type !== "ssh") throw new Error("本地 Agent 只能绑定正在运行的 SSH 会话。");
    const root = normalizeRoot(session.cwd);
    const realRoot = await resolveRealRoot(sessionId, root);
    await closeBinding(sessionId);
    const token = crypto.randomBytes(32).toString("base64url");
    const workspacePath = path.resolve(workspacesRoot, sessionId);
    const relativeWorkspace = path.relative(path.resolve(workspacesRoot), workspacePath);
    if (!relativeWorkspace || relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
      throw new Error("本地 Agent 临时目录无效。");
    }
    await fsApi.promises.rm(workspacePath, { recursive: true, force: true });
    await fsApi.promises.mkdir(workspacePath, { recursive: true });
    const hostLabel = `${session.sshConfig?.username ? `${session.sshConfig.username}@` : ""}${session.sshConfig?.host || "SSH"}`;
    await fsApi.promises.writeFile(path.join(workspacePath, "AGENTS.md"), createRuntimeInstructions({ remoteRoot: root, hostLabel }), "utf-8");
    const binding = {
      token,
      sessionId,
      root,
      realRoot,
      workspacePath,
      sshSecret: sshSessionRuntime.getSecret(session.sshConfig),
      activeCommands: new Map(),
      sessionMutationAllowed: false,
      approvalQueue: Promise.resolve(),
      closed: false
    };
    bindingsByToken.set(token, binding);
    bindingsBySession.set(sessionId, binding);
    return {
      workspacePath,
      url: `http://127.0.0.1:${port}/mcp`,
      token,
      tokenEnv: REMOTE_AGENT_TOKEN_ENV
    };
  }

  async function runConfiguredCommand(sessionId, command) {
    const binding = bindingsBySession.get(String(sessionId || ""));
    if (!binding || binding.closed) throw new Error("远程 Agent 会话已失效。");
    const operationId = startOperation(binding, "remote_prelaunch", command);
    try {
      const result = await remoteExec(binding, { command }, operationId, `prelaunch-${operationId}`);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `远程准备命令失败，退出码 ${result.exitCode}。`);
      }
      finishOperation(binding, operationId, "remote_prelaunch", "completed", { exitCode: result.exitCode });
      return result;
    } catch (error) {
      finishOperation(binding, operationId, "remote_prelaunch", "failed", { error: error?.message || String(error) });
      throw error;
    }
  }

  async function closeBinding(sessionId) {
    const binding = bindingsBySession.get(String(sessionId || ""));
    if (!binding) return;
    binding.closed = true;
    bindingsBySession.delete(binding.sessionId);
    bindingsByToken.delete(binding.token);
    auditBySession.delete(binding.sessionId);
    for (const handle of binding.activeCommands.values()) handle.cancel();
    binding.activeCommands.clear();
    const root = path.resolve(workspacesRoot);
    const target = path.resolve(binding.workspacePath);
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      await fsApi.promises.rm(target, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function shutdown() {
    await Promise.all(Array.from(bindingsBySession.keys()).map((sessionId) => closeBinding(sessionId)));
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
      port = 0;
    }
  }

  return { start, createBinding, runConfiguredCommand, closeBinding, shutdown, listAudit, handleHttp };
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  REMOTE_AGENT_TOKEN_ENV,
  createRemoteAgentBridgeService,
  createRuntimeInstructions,
  normalizeToolPath
};
