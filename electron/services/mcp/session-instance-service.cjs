const { EXTERNAL_SOURCES } = require("../model-sources/model-selection.cjs");
const { sessionInstanceSchema } = require("./session-instance-schema.cjs");

function apiError(message, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode, apiCode: statusCode === 404 ? "template_not_found" : statusCode === 500 ? "creation_failed" : "unsupported_configuration" });
}

const GRAPHICAL_AGENTS = new Set(["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"]);
const sourceFor = template => template.modelSource || (EXTERNAL_SOURCES.has(template.codexBackend) ? template.codexBackend : "native");
function configuredModel(template) {
  if (sourceFor(template) !== "native") return template.modelId || template.codexModel || null;
  if (template.agentProvider === "codex") return template.codexAppServerModel || null;
  if (template.agentProvider === "codebuddy") return template.codeBuddyGraphicalOptions?.model || null;
  if (template.agentProvider === "opencode") return template.openCodeGraphicalOptions?.model || null;
  return null;
}
const isGraphical = template => GRAPHICAL_AGENTS.has(template.agentProvider) && template.graphicalSessionEnabled !== false;

function createSessionInstanceService({ sessionStore, agentSessionLauncher, terminalManager, graphicalService }) {
  function listTemplates() {
    return { templates: sessionStore.getLibrary().filter(template => template.agentProvider).map(template => ({
      templateId: template.id, title: template.title, agentProvider: template.agentProvider,
      type: template.type, graphicalSessionEnabled: isGraphical(template),
      modelSource: sourceFor(template), modelId: configuredModel(template)
    })) };
  }

  async function create(input, { onSessionCreated, onTaskSubmitted, creationSource } = {}) {
    const { templateId, mode, prompt, agentProvider, modelId, tools, toolCallback } = sessionInstanceSchema.parse(input);
    const original = sessionStore.getTemplate(templateId);
    if (!original) throw apiError("会话模板不存在。", 404);
    const provider = agentProvider ?? original.agentProvider;
    if (tools && (provider !== "codex" || original.type !== "windows"))
      throw apiError("工具注入仅支持本机 Windows Codex 图形会话。");
    if (!original.agentProvider || original.graphicalSessionEnabled === false || !GRAPHICAL_AGENTS.has(provider))
      throw apiError("仅支持已配置 Agent 的图形会话模板。");
    const override = agentProvider !== undefined || modelId !== undefined;
    const source = override ? "native" : sourceFor(original);
    const selected = modelId?.trim();
    if (EXTERNAL_SOURCES.has(source) && (original.type === "ssh" || !["codex", "codebuddy", "opencode"].includes(provider)))
      throw apiError("当前 Agent 或环境不支持该外部模型来源。");
    const template = structuredClone(original);
    template.graphicalSessionEnabled = true;
    if (provider !== original.agentProvider) {
      for (const key of Object.keys(template)) {
        if (/^(codex|codeBuddy|openCode|claude|qoder|gemini|grok)/.test(key)) delete template[key];
      }
      template.agentProvider = provider;
    }
    if (override) {
      template.modelSource = "native";
      template.modelId = undefined;
      if (provider === "codex") {
        template.codexBackend = "openai";
        template.codexModel = undefined;
        template.codexExperimentalAcknowledged = undefined;
        template.codexAppServerModel = undefined;
      }
      for (const key of ["codeBuddyGraphicalOptions", "openCodeGraphicalOptions"]) {
        if (template[key]) delete template[key].model;
      }
    }
    let session;
    let submitted = false;
    try {
      // Detach persistence so runtime model/mode changes cannot update the source template.
      session = await agentSessionLauncher.launchSession(template, { useProvidedTemplate: true, templateId: undefined, creationSource,
        ...(tools ? { injectedTools: { tools, toolCallback } } : {}) });
      if (session.runtimeMode !== "app-server") throw apiError("模板未启动为图形会话。", 500);
      onSessionCreated?.(session);
      if (override && source === "native" && selected) {
        try { await graphicalService.setModel(session.id, selected); }
        catch { throw apiError("当前 Agent 不支持指定的原生模型。"); }
      }
      let snapshot = graphicalService.snapshot(session.id);
      if (!snapshot.threadId || snapshot.busy || snapshot.error) throw apiError("图形会话尚未就绪。", 500);
      if (mode === "plan" && snapshot.capabilities?.plan === false) throw apiError("当前 Agent 不支持 Plan 模式。");
      await graphicalService.setMode(session.id, mode);
      snapshot = graphicalService.snapshot(session.id);
      if (snapshot.mode !== mode) throw apiError("Agent 未进入指定模式。");
      await graphicalService.submitStarted(session.id, prompt.trim());
      submitted = true;
      onTaskSubmitted?.(session);
      snapshot = graphicalService.snapshot(session.id);
      const actualModel = source === "native" ? snapshot.acpOptions?.find(option => option.id === "model")?.currentValue || snapshot.model || null
        : template.modelId || template.codexModel || null;
      return { sessionId: session.id, templateId, agentProvider: session.agentProvider, mode,
        modelSource: source, modelId: actualModel, status: "started" };
    } catch (error) {
      if (session && !submitted) terminalManager.closeSession(session.id);
      throw error;
    }
  }
  return { listTemplates, create };
}

module.exports = { createSessionInstanceService };
