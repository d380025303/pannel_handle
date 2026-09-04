const MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
const MINIMAX_CHAT_COMPLETIONS_URL = `${MINIMAX_BASE_URL}/chat/completions`;
const MINIMAX_API_KEY_ENV = "PANNEL_HANDLE_MINIMAX_BRIDGE_KEY";
const MINIMAX_MAX_COMPLETION_TOKENS = 2048;

function adaptMiniMaxChatRequest(request = {}) {
  const {
    max_tokens: maxTokens,
    parallel_tool_calls: _parallelToolCalls,
    reasoning_effort: _reasoningEffort,
    stream_options: _streamOptions,
    ...rest
  } = request;
  const tools = Array.isArray(rest.tools)
    ? rest.tools.map(tool => tool?.type === "function" && tool.function
      ? { ...tool, function: Object.fromEntries(Object.entries(tool.function).filter(([key]) => key !== "strict")) }
      : tool)
    : undefined;
  const requestedMaxTokens = Number(maxTokens);
  return {
    ...rest,
    ...(tools ? { tools } : {}),
    ...(Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
      ? { max_completion_tokens: Math.min(Math.trunc(requestedMaxTokens), MINIMAX_MAX_COMPLETION_TOKENS) }
      : {})
  };
}

module.exports = {
  MINIMAX_BASE_URL,
  MINIMAX_CHAT_COMPLETIONS_URL,
  MINIMAX_API_KEY_ENV,
  MINIMAX_MAX_COMPLETION_TOKENS,
  adaptMiniMaxChatRequest
};
