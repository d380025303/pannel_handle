import { useEffect, useState } from "react";
import { Copy, Eye } from "lucide-react";
import { useI18n } from "../../i18n";
import type { SessionStatusMcpState } from "../../vite-env";

export function SessionStatusMcpPanel() {
  const { t } = useI18n();
  const [state, setState] = useState<SessionStatusMcpState | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void window.sessionStatusMcpApi.get().then(value => { if (active) setState(value); })
      .catch(err => { if (active) setError(String(err)); });
    const unsubscribe = window.sessionStatusMcpApi.onChanged(value => { if (active) setState(value); });
    return () => { active = false; unsubscribe(); };
  }, []);

  async function toggle() {
    if (!state) return;
    setBusy(true);
    setError("");
    try {
      const next = await window.sessionStatusMcpApi.setEnabled(!state.enabled || !state.running);
      setState(next);
      if (!next.enabled) setToken("");
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }

  async function reveal() {
    try { setToken(await window.sessionStatusMcpApi.revealToken()); }
    catch (err) { setError(String(err)); }
  }

  const url = state?.url || "http://127.0.0.1:43124/mcp";
  const bearer = token || "<ACCESS_TOKEN>";
  const examples = [
    { name: "Codex", value: `[mcp_servers.pannel_handle]\nurl = "${url}"\nbearer_token_env_var = "PANNEL_HANDLE_MCP_TOKEN"` },
    { name: "OpenCode", value: `"mcp": { "pannel_handle": { "type": "remote", "url": "${url}", "headers": { "Authorization": "Bearer {env:PANNEL_HANDLE_MCP_TOKEN}" } } }` },
    { name: "Claude", value: `"mcpServers": { "pannel_handle": { "type": "http", "url": "${url}", "headers": { "Authorization": "Bearer ${bearer}" } } }` }
  ];

  return <section className="session-status-mcp" aria-label={t("mcp.sessionStatusTitle")}>
    <div className="session-status-mcp-heading">
      <div><strong>{t("mcp.sessionStatusTitle")}</strong><small>{t("mcp.sessionStatusDescription")}</small></div>
      <button type="button" disabled={!state || busy} onClick={() => void toggle()}>
        {state?.enabled ? state.running ? t("mcp.sessionStatusStop") : t("mcp.sessionStatusRetry") : t("mcp.sessionStatusStart")}
      </button>
    </div>
    {state && <div className="session-status-mcp-details">
      <span>{state.running ? t("mcp.sessionStatusRunning") : state.enabled ? t("mcp.sessionStatusUnavailable") : t("mcp.disabled")}</span>
      <code>{url}</code>
      {state.enabled && <><button type="button" onClick={() => void navigator.clipboard.writeText(url)}><Copy aria-hidden="true" />{t("mcp.sessionStatusCopyUrl")}</button>
        <button type="button" onClick={() => void reveal()}><Eye aria-hidden="true" />{token ? t("mcp.sessionStatusRefreshToken") : t("mcp.sessionStatusRevealToken")}</button>
        {token && <><code>{token}</code><button type="button" onClick={() => void navigator.clipboard.writeText(token)}><Copy aria-hidden="true" />{t("mcp.sessionStatusCopyToken")}</button></>}
      </>}
    </div>}
    {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    {state?.enabled && <details><summary>{t("mcp.sessionStatusExamples")}</summary>
      <p>{t("mcp.sessionStatusTokenHint")}</p>
      {examples.map(example => <div key={example.name}><strong>{example.name}</strong><pre>{example.value}</pre></div>)}
      <div><strong>list_session_templates</strong><pre>{"{}"}</pre></div>
      <div><strong>create_session_instance</strong><pre>{JSON.stringify({ templateId: "<TEMPLATE_ID>", mode: "plan", prompt: "<TASK>", agentProvider: "codex", modelId: "<MODEL_ID>" }, null, 2)}</pre></div>
    </details>}
  </section>;
}
