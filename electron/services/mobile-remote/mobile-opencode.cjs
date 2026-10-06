// Keep mobile requests explicit and bind interactive login input to its owning socket.
function createMobileOpenCodeHandlers({ graphicalService: service, openCodeVersionService: version, agentSessionLauncher: launcher }) {
  const operations = new Set();
  const text = (value, limit = 4000) => {
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new Error("参数无效。");
    return value;
  };
  function release(socket) {
    const login = socket.openCodeLogin;
    socket.openCodeLogin = null;
    if (login?.generation) service.cancelAcpLogin(login.id, login.generation);
  }
  function event(socket, channel, payload, send) {
    const login = socket.openCodeLogin;
    if (!socket.authenticated || !login || login.id !== payload?.id || socket.graphicalSessionId !== login.id) return;
    if (!login.generation && channel === "opencode-auth:state" && payload.status === "running") login.generation = payload.generation;
    if (payload.generation !== login.generation) return;
    send(socket, channel === "opencode-auth:data" ? { type: "graphical.opencode.auth-data", id: payload.id, generation: payload.generation, seq: payload.seq, data: payload.data }
      : { type: "graphical.opencode.auth-state", id: payload.id, generation: payload.generation, status: payload.status, error: payload.error });
  }
  async function handle(message, session, current, socket) {
    if (session.agentProvider !== "opencode" || current.provider !== "opencode") throw new Error("仅 OpenCode 图形会话支持此操作。");
    const command = message.type.slice("graphical.opencode.".length), p = message.input || {}, id = session.id;
    const idle = (thread = true) => {
      if (thread && !current.threadId || current.busy || current.archived || current.pendingPlan || current.approvals?.length || current.questions?.length
        || ["running", "reconnecting"].includes(current.acpAuth?.status)) throw new Error("当前会话不可执行此操作。");
    };
    const authOwner = () => {
      if (!Number.isSafeInteger(p.generation) || p.generation < 1 || socket.openCodeLogin?.id !== id || socket.openCodeLogin.generation !== p.generation) throw new Error("登录请求已失效。");
    };
    if (command === "auth-write") { authOwner(); if (typeof p.data !== "string" || !p.data || p.data.length > 16384 || p.data.includes("\0")) throw new Error("终端输入无效。");
      const at = Date.now(); if (!socket.openCodeInput || at - socket.openCodeInput.at >= 1000) socket.openCodeInput = { at, bytes: 0 };
      socket.openCodeInput.bytes += Buffer.byteLength(p.data); if (socket.openCodeInput.bytes > 65536) throw new Error("终端输入过快。");
      return service.writeAcpLogin(id, p.generation, p.data); }
    if (command === "auth-resize") {
      authOwner(); if (![p.cols, p.rows].every(Number.isInteger) || p.cols < 1 || p.cols > 500 || p.rows < 1 || p.rows > 300) throw new Error("终端尺寸无效。");
      return service.resizeAcpLogin(id, p.generation, p.cols, p.rows);
    }
    if (command === "auth-cancel") { authOwner(); release(socket); return; }
    if (command === "capabilities") return service.listCapabilities(id, p.refresh === true);
    if (command === "attachment-preview") return service.previewAttachment(id, text(p.path));
    if (command === "version") { if (!version) throw new Error("请更新桌面宿主后重试。"); return version.check(id, p.force === true); }
    if (operations.has(id)) throw new Error("操作正在处理，请稍候。");
    operations.add(id);
    try {
      switch (command) {
        case "auth-start": {
          idle(false); text(p.methodId, 512);
          if (!current.acpAuth?.methods?.some(method => method.id === p.methodId)) throw new Error("登录方式无效。");
          release(socket);
          const login = { id, generation: 0 }; socket.openCodeLogin = login;
          try {
            const result = await service.startAcpLogin(id, p.methodId);
            login.generation = result.generation;
            if (socket.openCodeLogin !== login || !socket.authenticated || socket.graphicalSessionId !== id) service.cancelAcpLogin(id, result.generation);
            return result;
          } catch (error) { if (socket.openCodeLogin === login) socket.openCodeLogin = null; throw error; }
        }
        case "version-update": idle(false); if (!version) throw new Error("版本服务不可用。"); return version.update(id);
        case "reconnect": {
          idle(false); if (session.type === "ssh") throw new Error("SSH 会话不支持重新连接本地模型。");
          const replacement = await launcher.switchModelSource(id, session.modelSource || "native", true);
          return { id: replacement.id, previousSessionId: id };
        }
        case "history.rename": idle(); if (!current.capabilities?.renameHistory) throw new Error("当前会话不支持重命名。"); return service.renameThread(id, text(p.targetThreadId, 200), text(p.name, 512));
        case "revert": idle(); if (!current.capabilities?.revertHistory || !current.items?.some(item => item.type === "userMessage" && item.rewindMessageId === p.messageId)) throw new Error("回退目标无效。"); return service.revertThread(id, text(p.messageId, 200));
        case "restore": idle(); if (!current.capabilities?.revertHistory || !current.openCodeRevert) throw new Error("没有可恢复的回退。"); return service.restoreThread(id);
        default: throw new Error("该移动端操作不被允许。");
      }
    } finally { operations.delete(id); }
  }
  return { handle, release, event };
}
module.exports = { createMobileOpenCodeHandlers };
