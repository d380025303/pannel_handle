const getHookUrl = () => {
  const value = process.env.PANNEL_HANDLE_HOOK_URL;
  return value ? value.replace(/\/claude-hook$/, "/opencode-hook") : "";
};

const getSessionId = (value) => value?.sessionID || value?.sessionId || value?.session_id || value?.id;

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
    // Keep the primary URL on Windows and mirrored-network WSL.
  }
  return urls;
};

const postEvent = async (payload) => {
  const body = JSON.stringify({ ...payload, pannel_handle_session_id: process.env.PANNEL_HANDLE_SESSION_ID });
  for (const hookUrl of await getHookUrls()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(hookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal
      });
      if (response.ok) return;
    } catch {
      // Try the WSL host fallback before giving up.
    } finally {
      clearTimeout(timeout);
    }
  }
};

export default {
  id: "pannel-handle-notification",
  async setup(ctx) {
    const controller = new AbortController();
    const directory = ctx.location.directory;
    const models = new Map();
    const report = (payload) => { void postEvent({ ...payload, cwd: directory }); };

    await ctx.tool.hook("execute.before", (event) => {
      report({ event_name: "tool.execute.before", session_id: getSessionId(event),
        tool_name: event.tool, tool_input: event.input });
    });
    await ctx.tool.hook("execute.after", (event) => {
      report({ event_name: "tool.execute.after", session_id: getSessionId(event),
        tool_name: event.tool, success: event.status === "completed",
        error: event.status === "error" ? event.error : undefined,
        tool_response: event.status === "completed" ? event.result : undefined });
    });

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = event.data || {};
          const sessionId = getSessionId(data);
          if (!sessionId) continue;
          const base = { session_id: sessionId };
          if (event.type === "session.execution.started") {
            report({ ...base, event_name: "session.status", status: "busy" });
          } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted") {
            report({ ...base, event_name: "session.idle" });
          } else if (event.type === "session.execution.failed") {
            report({ ...base, event_name: "session.error", error: data.error });
          } else if (event.type === "session.step.started") {
            models.set(data.assistantMessageID, data.model);
          } else if (event.type === "session.step.ended" || event.type === "session.step.failed") {
            const model = models.get(data.assistantMessageID);
            report({ ...base, event_name: "message.updated", info: {
              id: data.assistantMessageID, role: "assistant", tokens: data.tokens,
              modelID: model?.id || data.model?.id, finish: data.finish || (event.type.endsWith("failed") ? "error" : undefined),
              time: { completed: event.created || Date.now() }
            } });
          } else if (event.type === "session.text.ended") {
            report({ ...base, event_name: "message.part.updated", part: {
              type: "text", text: data.text, messageID: data.assistantMessageID
            } });
          } else if (event.type === "permission.asked") {
            report({ ...base, event_name: event.type, permission: data });
          } else if (event.type === "session.deleted") {
            models.clear();
            report({ ...base, event_name: event.type });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("Pannel Handle OpenCode event subscription failed:", error);
      }
    })();
    return () => controller.abort();
  }
};
