const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { createProjectTools } = require("./project-tools.cjs");
const { createAccountController } = require("../codex-app-server/account-controller.cjs");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    action: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["create_session", "launch_saved_session", "launch_template", "rename_session", "close_session", "send_codex_input", "switch_codex_mode"] },
            id: { type: "string" },
            title: { type: "string" }
          },
          required: ["kind", "id", "title"],
          additionalProperties: false
        }
      ]
    }
  },
  required: ["answer", "action"],
  additionalProperties: false
};

const INSTRUCTIONS = `你是 Pannel Handle 应用内的本机数据助手。只能根据每轮附带的“应用数据快照”回答本机应用数据问题。快照来自应用受控服务，可能截断；不要假装有未提供的数据。不要调用命令、文件、网络或其他工具来读取应用数据，也不要自行操作应用。需要执行操作时，在结构化结果的 action 中提出一个操作，等待应用界面由用户确认。一次最多提议一个操作。可提议 create_session、launch_saved_session、launch_template、rename_session、close_session、send_codex_input、switch_codex_mode。后两者只能作用于 selectedCodexSession 的 id；send_codex_input 的 title 是要原样发给 Codex 的用户文字，switch_codex_mode 的 title 为空字符串。不要代替用户回答 Codex 的问题；用户会在镜像终端内自行回答。id 必须取自快照，创建会话时 id 为空字符串；无操作时 action 为 null。answer 使用用户提问的语言简洁说明结果或提议。不要输出凭据。`;

function createProjectAssistantService({ userData, broadcast, dependencies, spawnProcess = spawn, fsApi = fs, now = () => Date.now() }) {
  const tools = createProjectTools(dependencies);
  const stateFile = path.join(userData, "project-assistant.json");
  let state = { threadId: null, messages: [], pendingAction: null, busy: false, error: null };
  let child = null;
  let lineReader = null;
  let nextId = 1;
  let pendingRequests = new Map();
  let activeTurnId = null;
  let finalText = "";
  let streamedText = "";
  let pendingTurn = null;
  let startPromise = null;
  let turnTargetSessionId = null;
  let startingNewConversation = false;
  let threadReady = false;
  let threadStartPromise = null;

  try {
    const stored = JSON.parse(fsApi.readFileSync(stateFile, "utf8"));
    state.threadId = typeof stored.threadId === "string" ? stored.threadId : null;
    state.messages = Array.isArray(stored.messages) ? stored.messages.slice(-100) : [];
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load project assistant history:", error);
  }

  function snapshot() { return { ...state, messages: [...state.messages], account: accountController.snapshot() }; }
  function publish() { broadcast("project-assistant:changed", snapshot()); }
  function persist(nextState = state) {
    fsApi.mkdirSync(userData, { recursive: true });
    const temp = `${stateFile}.tmp`;
    fsApi.writeFileSync(temp, JSON.stringify({ threadId: nextState.threadId, messages: nextState.messages.slice(-100) }), "utf8");
    fsApi.renameSync(temp, stateFile);
  }
  function threadParams() {
    return { cwd: userData, modelProvider: "openai", approvalPolicy: "never", sandbox: "read-only", developerInstructions: INSTRUCTIONS, serviceName: "pannel_handle_assistant" };
  }
  function send(message) {
    if (!child?.stdin?.writable) throw new Error("Codex App Server is unavailable.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(method, params, timeoutMs = 30000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingRequests.delete(id); reject(new Error(`${method} timed out.`)); }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pendingRequests.delete(id); reject(error); }
    });
  }
  const accountController = createAccountController({ request, changed: publish,
    authenticated: async () => { if (child) await ensureThread(); } });
  async function ensureThread() {
    if (threadReady) return;
    if (threadStartPromise) return threadStartPromise;
    threadStartPromise = (async () => {
      if (state.threadId) {
        try { await request("thread/resume", { threadId: state.threadId, ...threadParams() }); threadReady = true; return; }
        catch { state.threadId = null; }
      }
      const result = await request("thread/start", threadParams());
      state.threadId = result.thread.id;
      threadReady = true;
      persist();
      publish();
    })();
    try { await threadStartPromise; } finally { threadStartPromise = null; }
  }
  function finishTurn(error) {
    const turn = pendingTurn;
    pendingTurn = null;
    activeTurnId = null;
    turnTargetSessionId = null;
    state.busy = false;
    if (error) state.error = String(error.message || error);
    publish();
    if (turn) error ? turn.reject(error) : turn.resolve(snapshot());
  }
  function handleMessage(message) {
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message || "Codex request failed.")) : pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      // This assistant never grants command, file, network, or tool permissions.
      const result = message.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
        : ["item/tool/requestUserInput", "tool/requestUserInput"].includes(message.method) ? { answers: {} }
          : message.method === "mcpServer/elicitation/request" ? { action: "decline", content: null }
            : { decision: "decline" };
      try { send({ id: message.id, result }); } catch { /* process exit handles failure */ }
      return;
    }
    const params = message.params || {};
    if (accountController.onNotification(message.method, params)) return;
    if (message.method === "turn/started") activeTurnId = params.turn?.id || null;
    if (message.method === "item/completed" && params.item?.type === "agentMessage" && params.item.phase === "final_answer") finalText = params.item.text || "";
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      streamedText += params.delta;
      const match = streamedText.match(/"answer"\s*:\s*"/);
      if (match) {
        const start = match.index + match[0].length;
        let end = start;
        let escaped = false;
        for (; end < streamedText.length; end++) {
          const char = streamedText[end];
          if (char === '"' && !escaped) break;
          if (char === "\\" && !escaped) escaped = true;
          else escaped = false;
        }
        const raw = streamedText.slice(start, end);
        try { broadcast("project-assistant:progress", { text: JSON.parse(`"${raw}"`) }); }
        catch { broadcast("project-assistant:progress", { text: "" }); }
      }
    }
    if (message.method === "turn/completed" && pendingTurn) {
      const status = params.turn?.status;
      if (status === "interrupted") {
        state.messages.push({ role: "system", text: "已停止生成。", at: now() });
        persist();
        finishTurn();
        return;
      }
      if (status !== "completed") { finishTurn(new Error(`Codex turn ${status || "failed"}.`)); return; }
      try {
        const raw = finalText || (params.turn?.items || []).filter(item => item.type === "agentMessage").at(-1)?.text || "";
        const output = JSON.parse(raw);
        if (typeof output.answer !== "string") throw new Error("Codex returned an invalid answer.");
        state.messages.push({ role: "assistant", text: output.answer, at: now() });
        if (output.action) {
          try {
            if ((output.action.kind === "send_codex_input" || output.action.kind === "switch_codex_mode") && output.action.id !== turnTargetSessionId) {
              throw new Error("目标 Codex 会话与当前选择不符。");
            }
            const prepared = tools.prepareAction(output.action.kind, { id: output.action.id, title: output.action.title });
            state.pendingAction = { ...prepared, createdAt: now() };
          } catch (error) {
            state.messages.push({ role: "system", text: `操作提议无效：${error.message}`, at: now() });
          }
        }
        state.messages = state.messages.slice(-100);
        persist();
        finishTurn();
      } catch (error) { finishTurn(error); }
    }
  }

  async function start() {
    if (startPromise) return startPromise;
    if (child) return;
    startPromise = (async () => {
      const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "codex";
      const args = process.platform === "win32" ? ["/d", "/s", "/c", "codex app-server"] : ["app-server"];
      const processHandle = spawnProcess(command, args, { cwd: userData, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      child = processHandle;
      lineReader = readline.createInterface({ input: processHandle.stdout });
      lineReader.on("line", line => { try { handleMessage(JSON.parse(line)); } catch { /* Ignore diagnostics on stdout. */ } });
      let stderr = "";
      processHandle.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
      processHandle.once("error", error => { state.error = error.message; shutdownProcess(error); });
      processHandle.once("exit", code => shutdownProcess(new Error(stderr.trim() || `Codex App Server exited (${code}).`)));
      await request("initialize", { clientInfo: { name: "pannel_handle", title: "Pannel Handle", version: "0.1.0" } });
      send({ method: "initialized", params: {} });
      const account = await accountController.refresh();
      if (account.status !== "signedOut") await ensureThread();
      state.error = null;
      publish();
    })();
    try { await startPromise; } catch (error) { shutdownProcess(error); throw error; } finally { startPromise = null; }
  }

  async function newConversation() {
    if (state.busy || startingNewConversation) throw new Error("The assistant is busy.");
    startingNewConversation = true;
    try {
      await start();
      if (accountController.snapshot().status === "signedOut") throw new Error("请先登录 Codex 账号。");
      const result = await request("thread/start", threadParams());
      const threadId = result.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("Codex did not return a new thread ID.");
      const nextState = { ...state, threadId, messages: [], pendingAction: null, error: null };
      persist(nextState);
      state = nextState;
      threadReady = true;
      finalText = "";
      streamedText = "";
      publish();
      return snapshot();
    } finally {
      startingNewConversation = false;
    }
  }

  async function dataSnapshot(selectedSessionId) {
    return {
      runningSessions: tools.listData("running_sessions"),
      savedSessions: tools.listData("saved_sessions"),
      launchTemplates: tools.listData("launch_templates"),
      usage: tools.listData("usage_summary"),
      codexSessions: dependencies.codexSessionControl.listSessions(),
      selectedCodexSession: selectedSessionId ? await dependencies.codexSessionControl.getContext(selectedSessionId) : null
    };
  }

  async function sendMessage(text, selectedSessionId) {
    const prompt = String(text || "").trim();
    if (!prompt || prompt.length > 4000) throw new Error("Message must be 1-4000 characters.");
    if (state.busy || startingNewConversation) throw new Error("The assistant is already responding.");
    if (state.pendingAction) throw new Error("请先确认或拒绝当前操作。");
    await start();
    if (accountController.snapshot().status === "signedOut") throw new Error("请先登录 Codex 账号。");
    await ensureThread();
    state.busy = true;
    turnTargetSessionId = selectedSessionId || null;
    state.error = null;
    state.messages.push({ role: "user", text: prompt, at: now() });
    persist();
    publish();
    finalText = "";
    streamedText = "";
    const completion = new Promise((resolve, reject) => { pendingTurn = { resolve, reject }; });
    try {
      const input = `${prompt}\n\n应用数据快照（仅供本次回答，数据可能在操作前变化）：\n${JSON.stringify(await dataSnapshot(selectedSessionId))}`;
      const result = await request("turn/start", { threadId: state.threadId, input: [{ type: "text", text: input }], outputSchema: OUTPUT_SCHEMA, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
      activeTurnId = result.turn?.id || activeTurnId;
    } catch (error) { finishTurn(error); }
    return completion;
  }

  async function resolveAction(approved) {
    if (startingNewConversation) throw new Error("The assistant is busy.");
    const pending = state.pendingAction;
    if (!pending) throw new Error("No pending action.");
    state.pendingAction = null;
    if (!approved) {
      state.messages.push({ role: "system", text: "已拒绝操作。", at: now() });
      persist(); publish();
      return { approved: false };
    }
    if (now() - pending.createdAt > 120000) {
      state.messages.push({ role: "system", text: "操作确认已超时，请重新提出请求。", at: now() });
      persist(); publish();
      throw new Error("操作确认已超时，请重新提出请求。");
    }
    const result = await tools.executeAction(pending);
    state.messages.push({ role: "system", text: `操作完成：${pending.label}`, at: now() });
    persist(); publish();
    return { approved: true, result };
  }

  async function stop() {
    if (!state.busy || !activeTurnId) return;
    await request("turn/interrupt", { threadId: state.threadId, turnId: activeTurnId });
  }
  function shutdownProcess(error) {
    const processHandle = child;
    child = null;
    lineReader?.close();
    lineReader = null;
    for (const pending of pendingRequests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    pendingRequests.clear();
    threadReady = false;
    accountController.reset();
    if (pendingTurn) finishTurn(error);
    else { state.error = error?.message || null; publish(); }
    processHandle?.kill();
  }
  function shutdown() { shutdownProcess(new Error("Assistant stopped.")); }
  async function readAccount() { await start(); return accountController.refresh(); }
  async function startLogin(type) { await start(); return accountController.startLogin(type); }
  async function cancelLogin() { return accountController.cancelLogin(); }
  async function logout() {
    if (state.busy) throw new Error("请等待当前回复完成后登出。");
    const result = await accountController.logout();
    threadReady = false;
    return result;
  }
  async function refreshAccountUsage() { await start(); return accountController.refreshUsage(); }
  return { snapshot, start, newConversation, sendMessage, resolveAction, stop, shutdown,
    readAccount, startLogin, cancelLogin, logout, refreshAccountUsage };
}

module.exports = { createProjectAssistantService, OUTPUT_SCHEMA };
