function minimaxContextWindow(modelId) {
  const id = String(modelId || "");
  if (/^MiniMax-M3(?:\b|[-.])/i.test(id)) return 1_000_000;
  if (/^MiniMax-M2(?:\b|[-.])/i.test(id)) return 204_800;
  return 128_000;
}

function transformMiniMaxModels(models) {
  return (Array.isArray(models) ? models : []).map(model => {
    const id = String(model?.id || "").trim();
    return {
      ...model,
      name: String(model?.name || id).trim() || id,
      description: String(model?.description || `MiniMax text model ${id}`).trim(),
      context_length: Number(model?.context_length) || minimaxContextWindow(id),
      architecture: { ...(model?.architecture || {}), input_modalities: ["text"] },
      supported_parameters: ["tools", "tool_choice"]
    };
  });
}

module.exports = {
  minimaxContextWindow,
  transformMiniMaxModels
};
