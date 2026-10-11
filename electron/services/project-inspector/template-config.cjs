const AGENT_KEYS = ["agentProvider", "agentLocation", "localAgentCwd", "codexBackend", "codexModel", "modelSource", "modelId", "codeBuddyGraphicalOptions", "openCodeGraphicalOptions", "environmentOverrides"];
function agentSnapshot(template) {
  return Object.fromEntries(AGENT_KEYS.filter(key => template[key] !== undefined).map(key => [key, structuredClone(template[key])]));
}
function stageConfig(project, stage) {
  const base = { ...(project.templateSnapshot || { type: "windows", agentProvider: "codex", codexBackend: "openai" }) };
  const override = project.stageAgents?.[stage]?.config;
  if (!override) return base;
  for (const key of AGENT_KEYS) delete base[key];
  return { ...base, ...override };
}
function capability(config, stage) {
  if (config.type !== "windows") return "该环境尚未接入可验证的 agent 隔离执行器。";
  if (config.agentProvider !== "codex") return "该 agent 尚未接入可验证的巡检权限隔离。";
  if (config.codexBackend && config.codexBackend !== "openai") return "该 Codex 后端尚未接入巡检隔离执行器。";
  if (stage === "inspection" && config.modelSource) return "该模型来源尚未接入隔离巡检执行器。";
  return null;
}
function assertStage(project, stage) {
  const config = stageConfig(project, stage);
  const reason = capability(config, stage);
  if (reason) throw new Error(reason);
  return config;
}
function environmentKey(config) {
  return config.type === "ssh" ? JSON.stringify(["ssh", config.sshConfig?.host?.toLowerCase(), config.sshConfig?.port || 22, config.sshConfig?.username || "", config.sshConfig?.remotePlatform || "auto"])
    : config.type === "wsl" ? `wsl:${config.wslDistro || ""}` : "windows";
}
function summarize(project) {
  const { templateSnapshot, stageAgents, ...publicProject } = project;
  return { ...publicProject, agent: templateSnapshot?.agentProvider || "codex", stageAgents: Object.fromEntries(["inspection", "planning", "implementation"].map(stage => {
    const config = stageConfig(project, stage);
    return [stage, { templateId: stageAgents?.[stage]?.templateId || "", title: stageAgents?.[stage]?.title || "", agent: config.agentProvider, unsupportedReason: capability(config, stage) }];
  })) };
}
module.exports = { agentSnapshot, stageConfig, assertStage, capability, environmentKey, summarize };
