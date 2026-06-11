const getHookUrl = () => {
  const value = process.env.PANNEL_HANDLE_HOOK_URL;
  if (!value) return "";
  return value.replace(/\/claude-hook$/, "/opencode-hook");
};

const getSessionId = (value) => (
  value?.sessionID ||
  value?.sessionId ||
  value?.session_id ||
  value?.id
);

const getHookUrls = async () => {
  const hookUrl = getHookUrl();
  if (!hookUrl) return [];

  const urls = [hookUrl];
  try {
    const parsed = new URL(hookUrl);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      const resolvConf = await globalThis.Bun?.file("/etc/resolv.conf").text();
      const host = resolvConf?.match(/^nameserver\s+(\S+)/m)?.[1];
      if (host) {
        parsed.hostname = host;
        urls.push(parsed.toString());
      }
    }
  } catch {
    // The primary URL remains usable on Windows and mirrored-network WSL.
  }
  return urls;
};

const postEvent = async (payload) => {
  const body = JSON.stringify({
    ...payload,
    pannel_handle_session_id: process.env.PANNEL_HANDLE_SESSION_ID
  });

  for (const hookUrl of await getHookUrls()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal
      });
      if (response.ok) return;
    } catch {
      // Try the WSL host fallback before giving up.
    } finally {
      clearTimeout(timeout);
    }
  }
};

export const PannelHandleNotification = async ({ directory }) => ({
  event: async ({ event }) => {
    const properties = event?.properties || {};
    void postEvent({
      ...properties,
      event_name: event?.type,
      session_id: getSessionId(properties),
      cwd: directory
    });
  },
  "tool.execute.before": async (input) => {
    void postEvent({
      event_name: "tool.execute.before",
      session_id: getSessionId(input),
      cwd: directory,
      tool_name: input?.tool,
      tool_input: input?.args
    });
  },
  "tool.execute.after": async (input, output) => {
    void postEvent({
      event_name: "tool.execute.after",
      session_id: getSessionId(input),
      cwd: directory,
      tool_name: input?.tool,
      success: output?.error === undefined,
      error: output?.error
    });
  }
});
