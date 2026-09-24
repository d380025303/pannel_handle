const crypto = require("node:crypto");
const ACTIONS = new Set(["create_session", "launch_saved_session", "launch_template", "rename_session", "close_session", "send_codex_input", "switch_codex_mode"]);
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function publicSession(session) {
  return {
    id: String(session.id),
    title: String(session.title || ""),
    type: session.type || "windows",
    cwd: String(session.cwd || ""),
    agentProvider: session.agentProvider || null,
    templateId: session.templateId || null
  };
}

function createProjectTools({ terminalManager, sessionStore, launchTemplateStore, launchTemplateService, agentSessionLauncher, tokenUsageModule, disconnectFileSession, remoteSystemService, codexSessionControl }) {
  function listData(kind) {
    if (kind === "running_sessions") { const all = terminalManager.listSessions(); return { total: all.length, items: all.slice(0, 100).map(publicSession) }; }
    if (kind === "saved_sessions") { const all = sessionStore.getLibrary(); return { total: all.length, items: all.slice(0, 100).map(publicSession) }; }
    if (kind === "launch_templates") { const all = launchTemplateStore.getAll(); return { total: all.length, items: all.slice(0, 100).map(({ id, name, sessionTemplateIds }) => ({ id, name, sessionTemplateIds })) }; }
    if (kind === "usage_summary") {
      const result = tokenUsageModule.getDashboard({ range: "30d", limit: 1 });
      return { range: result.range, summary: result.summary, providerBreakdown: result.providerBreakdown };
    }
    throw new Error("Unsupported data category.");
  }

  function prepareAction(action, input = {}) {
    if (!ACTIONS.has(action)) throw new Error("Unsupported action.");
    if (action === "create_session") {
      const title = String(input.title || "").trim();
      if (!title || title.length > 80) throw new Error("Session title must be 1-80 characters.");
      return { action, input: { title }, label: `创建本机 Windows 会话“${title}”` };
    }
    const id = String(input.id || "").trim();
    if (!id || id.length > 120) throw new Error("A valid id is required.");
    if (action === "send_codex_input" || action === "switch_codex_mode") {
      const target = codexSessionControl?.listSessions().find(item => item.id === id);
      if (!target) throw new Error("Codex session not found or ended.");
      if (action === "send_codex_input") {
        const title = String(input.title || "");
        if (!title.trim() || Buffer.byteLength(title, "utf8") > 16384) throw new Error("Codex input must be 1–16384 bytes.");
        return { action, input: { id, title }, label: `向 Codex 会话“${target.title}”发送：${title.slice(0, 120)}`, expected: target.title };
      }
      return { action, input: { id }, label: `切换 Codex 会话“${target.title}”的 Plan/默认模式`, expected: target.title };
    }
    if (action === "launch_saved_session") {
      const target = sessionStore.getLibrary().find(item => item.id === id);
      if (!target) throw new Error("Saved session not found.");
      if (target.type !== "windows") throw new Error("Only local Windows sessions can be launched by the assistant.");
      return { action, input: { id }, label: `启动已保存会话“${target.title}”`, expected: fingerprint(sessionStore.getTemplate(id)) };
    }
    if (action === "launch_template") {
      const target = launchTemplateStore.get(id);
      if (!target) throw new Error("Launch template not found.");
      const sessions = target.sessionTemplateIds.map(templateId => sessionStore.getTemplate(templateId));
      if (sessions.some(session => session?.type !== "windows")) throw new Error("Only local Windows launch templates are supported.");
      const names = sessions.map(session => session.title).join("、");
      return { action, input: { id }, label: `启动模板“${target.name}”中的会话：${names}`, expected: fingerprint({ target, sessions }) };
    }
    const target = terminalManager.getSession(id);
    if (!target) throw new Error("Running session not found.");
    if (target.type !== "windows") throw new Error("Only local Windows sessions can be changed by the assistant.");
    if (action === "rename_session") {
      const title = String(input.title || "").trim();
      if (!title || title.length > 80) throw new Error("Session title must be 1-80 characters.");
      return { action, input: { id, title }, label: `将会话“${target.title}”重命名为“${title}”`, expected: target.title };
    }
    return { action, input: { id }, label: `关闭运行中会话“${target.title}”`, expected: target.title };
  }

  async function executeAction(prepared) {
    const current = prepareAction(prepared.action, prepared.input);
    if (current.expected !== prepared.expected) throw new Error("Target changed before confirmation.");
    const { action, input } = prepared;
    if (action === "send_codex_input") { await codexSessionControl.submit(input.id, input.title); return { sent: input.id }; }
    if (action === "switch_codex_mode") { codexSessionControl.switchMode(input.id); return { switched: input.id }; }
    if (action === "create_session") return publicSession(await agentSessionLauncher.createSession({ title: input.title, type: "windows", persist: true }));
    if (action === "launch_saved_session") return publicSession(await agentSessionLauncher.launchSession(sessionStore.getTemplate(input.id), { recordUsage: true }));
    if (action === "launch_template") return launchTemplateService.launch(input.id);
    if (action === "rename_session") {
      terminalManager.renameSession(input.id, input.title);
      return publicSession(terminalManager.getSession(input.id));
    }
    terminalManager.closeSession(input.id);
    await disconnectFileSession?.(input.id);
    await remoteSystemService?.disconnect(input.id);
    return { closed: input.id };
  }

  return { listData, prepareAction, executeAction };
}

module.exports = { createProjectTools, publicSession };
