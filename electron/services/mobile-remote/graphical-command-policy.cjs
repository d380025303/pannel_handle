function availableModelIds(snapshot) {
  if (snapshot.provider === "codex") return snapshot.backend === "openai"
    ? (snapshot.models || []).map(model => model.id) : [];
  return (snapshot.acpOptions || []).find(option => option.id === "model")?.options?.map(option => option.value) || [];
}

function nativeModeFor(snapshot, mode) {
  const modes = snapshot.nativeModes || [];
  if (mode === "plan") return modes.find(value => /plan/i.test(value.id));
  const choices = ["default", "normal", "code", "ask", "build", "acceptEdits"];
  return choices.map(id => modes.find(value => value.id.toLowerCase() === id.toLowerCase())).find(Boolean);
}

module.exports = { availableModelIds, nativeModeFor };
