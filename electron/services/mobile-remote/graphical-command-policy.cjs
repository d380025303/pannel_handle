function visibleOpenCodeOptions(snapshot, session, verifiedModels) {
  const options = (snapshot.acpOptions || []).find(option => option.id === "model")?.options || [];
  if (snapshot.provider !== "opencode" || session?.type === "ssh") return options;
  return options.filter(option => {
    const source = String(option.value || "").split("/", 1)[0];
    if (/^minimax(?:-|$)/i.test(source) && source !== "minimax") return false;
    return !["openrouter", "nararouter", "minimax"].includes(source) || verifiedModels?.[source]?.has(option.value);
  });
}

function availableModelIds(snapshot, session, verifiedModels) {
  if (snapshot.provider === "codex") return snapshot.backend === "openai"
    ? (snapshot.models || []).map(model => model.id) : [];
  if (snapshot.provider === "opencode") return visibleOpenCodeOptions(snapshot, session, verifiedModels).map(option => option.value);
  return (snapshot.acpOptions || []).find(option => option.id === "model")?.options?.map(option => option.value) || [];
}

function nativeModeFor(snapshot, mode) {
  const modes = snapshot.nativeModes || [];
  if (mode === "plan") return modes.find(value => /plan/i.test(value.id));
  if (snapshot.provider === "codebuddy")
    return modes.find(value => value.id === "bypassPermissions" || value.id === "fullAccess");
  const choices = ["default", "normal", "code", "ask", "build", "acceptEdits"];
  return choices.map(id => modes.find(value => value.id.toLowerCase() === id.toLowerCase())).find(Boolean);
}

module.exports = { availableModelIds, visibleOpenCodeOptions, nativeModeFor };
