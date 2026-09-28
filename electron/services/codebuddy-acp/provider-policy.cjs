function createAcpProviderPolicy(provider) {
  const codeBuddy = provider === "codebuddy";
  const agentName = codeBuddy ? "CodeBuddy" : provider === "claude" ? "Claude" : provider === "qoder" ? "Qoder" : provider === "gemini" ? "Gemini" : "OpenCode";

  function updateCapabilities(entry) {
    entry.capabilities.plan = entry.modes.some(mode => /plan/i.test(mode.id));
    entry.capabilities.multitask = codeBuddy && entry.multitaskSupport === true;
    entry.capabilities.supportedPermissions = provider === "claude" ? [] : codeBuddy ? [
      ...(entry.modes.some(mode => mode.id === "plan") ? ["readOnly"] : []),
      ...(entry.modes.some(mode => mode.id === "default") ? ["askApproval"] : []),
      ...(entry.modes.some(mode => mode.id === "bypassPermissions" || mode.id === "fullAccess") ? ["fullAccess"] : [])
    ] : [];
  }

  function reflectNativeMode(entry) {
    entry.mode = /plan/i.test(entry.nativeMode || "") ? "plan" : "default";
    entry.executionPermission = (provider === "qoder" || provider === "gemini") && /^(yolo|bypass_permissions|bypassPermissions)$/i.test(entry.nativeMode || "") ? "fullAccess" : !codeBuddy ? "askApproval"
      : entry.nativeMode === "bypassPermissions" || entry.nativeMode === "fullAccess"
        ? "fullAccess" : "askApproval";
  }

  function findMode(entry, mode) {
    return entry.modes.find(value => mode === "plan" ? /plan/i.test(value.id)
      : /^(default|normal|code|ask|build)$/i.test(value.id));
  }

  return { agentName, codeBuddy, updateCapabilities, reflectNativeMode, findMode };
}

module.exports = { createAcpProviderPolicy };
