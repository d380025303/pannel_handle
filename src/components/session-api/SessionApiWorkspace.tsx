import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { SessionApiResult, SessionApiState, SessionApiTemplate } from "../../vite-env";
import "./session-api.css";
import { SessionApiResponse } from "./SessionApiResponse";

export function SessionApiWorkspace({ visible, onOpenSession }: { visible: boolean; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<SessionApiState | null>(null);
  const [port, setPort] = useState("43125");
  const [token, setToken] = useState("");
  const [operation, setOperation] = useState<"list" | "create" | "listInstances" | "getInstanceStatus">("list");
  const [queryId, setQueryId] = useState("");
  const [templates, setTemplates] = useState<SessionApiTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [mode, setMode] = useState("plan");
  const [prompt, setPrompt] = useState("");
  const [source, setSource] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SessionApiResult | null>(null);
  const [sentBody, setSentBody] = useState<unknown>();
  const locked = useRef(false);

  useEffect(() => {
    let active = true;
    void window.sessionApi.get().then(value => { if (active) { setState(value); setPort(String(value.port)); } })
      .catch(err => { if (active) setError(String(err)); });
    const unsubscribe = window.sessionApi.onChanged(value => { if (active) setState(value); });
    return () => { active = false; unsubscribe(); };
  }, []);

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try { await action(); } catch (err) { setError(String(err)); }
    finally { locked.current = false; setBusy(false); }
  }
  const body = { templateId, mode, prompt, ...(source ? { agentProvider: source } : {}), ...(modelId.trim() ? { modelId: modelId.trim() } : {}) };
  const endpoint = operation === "list" ? "/api/v1/session-templates" : `/api/v1/session-instances${operation === "getInstanceStatus" ? `/${encodeURIComponent(queryId.trim())}` : ""}`;
  const method = operation === "create" ? "POST" : "GET";
  const url = `${state?.url || "http://127.0.0.1:43125"}${endpoint}`;
  const selected = templates.find(item => item.templateId === templateId);
  const invalid = (operation === "create" && (!selected?.graphicalSessionEnabled || !prompt.trim())) || (operation === "getInstanceStatus" && !queryId.trim());
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const curl = `curl -X ${method} ${quote(url)} -H 'Authorization: Bearer <ACCESS_TOKEN>'${operation === "create" ? ` -H 'Content-Type: application/json' --data-raw ${quote(JSON.stringify(body))}` : ""}`;
  async function send(kind = operation, id = queryId) {
    const requestBody = kind === "create" ? body : undefined;
    setResult(null);
    setSentBody(requestBody);
    const next = await window.sessionApi.invoke({ operation: kind, body: requestBody, ...(kind === "getInstanceStatus" ? { sessionId: id.trim() } : {}) });
    setResult(next);
    if (kind === "create" && next.status === 201) setQueryId((next.body as { sessionId: string }).sessionId);
    if (kind === "list" && next.status === 200) {
      const items = (next.body as { templates: SessionApiTemplate[] }).templates;
      setTemplates(items);
      setTemplateId(current => items.some(item => item.templateId === current && item.graphicalSessionEnabled) ? current : items.find(item => item.graphicalSessionEnabled)?.templateId || "");
    }
  }
  const sessionId = result?.status === 201 ? (result.body as { sessionId?: string }).sessionId : undefined;

  return <main className="session-api-workspace" hidden={!visible} aria-label={t("sessionApi.title")}>
    <section className="session-api-service">
      <strong>{t("sessionApi.title")}</strong>
      <span className="session-api-status" data-running={state?.running}>{state?.running ? t("sessionApi.running") : t("sessionApi.stopped")}</span>
      <label>{t("sessionApi.port")}<input type="number" min="1" max="65535" value={port} disabled={busy} onChange={event => setPort(event.target.value)} /></label>
      <button type="button" disabled={busy || !state || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={() => void run(async () => { setState(await window.sessionApi.configure({ port: Number(port) })); })}>{t("sessionApi.savePort")}</button>
      <button type="button" disabled={busy || !state} onClick={() => void run(async () => { setState(await window.sessionApi.configure({ enabled: !state?.enabled || !state?.running })); })}>{state?.running ? t("sessionApi.stop") : t("sessionApi.start")}</button>
      <div className="session-api-token-actions">
      <button type="button" disabled={busy} onClick={() => void run(async () => { setToken(token ? "" : await window.sessionApi.revealToken()); })}>{token ? t("sessionApi.hideToken") : t("sessionApi.showToken")}</button>
      <button type="button" disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(await window.sessionApi.revealToken()); })}>{t("sessionApi.copyToken")}</button>
      <button type="button" disabled={busy} onClick={() => void run(async () => { await window.sessionApi.resetToken(); setToken(""); })}>{t("sessionApi.resetToken")}</button>
      </div>
      <div className="session-api-addresses"><code>{state?.url}</code>{state?.lanUrls.map(value => <code key={value}>{value}</code>)}{token && <code>{token}</code>}</div>
    </section>
    {(error || state?.error) && <p className="session-api-error" role="alert">{error || state?.error}</p>}
    <div className="session-api-columns">
      <nav aria-label={t("sessionApi.interfaces")}>
        <button type="button" disabled={busy} aria-label={`GET · ${t("sessionApi.templates")}`} aria-pressed={operation === "list"} onClick={() => { setOperation("list"); setResult(null); }}><span className="session-api-method">GET</span><span>{t("sessionApi.templates")}</span></button>
        <button type="button" disabled={busy} aria-label={`POST · ${t("sessionApi.create")}`} aria-pressed={operation === "create"} onClick={() => { setOperation("create"); setResult(null); }}><span className="session-api-method" data-method="POST">POST</span><span>{t("sessionApi.create")}</span></button>
        {(["listInstances", "getInstanceStatus"] as const).map(kind => <button key={kind} type="button" disabled={busy} aria-label={`GET · ${t(`sessionApi.${kind}`)}`} aria-pressed={operation === kind} onClick={() => { setOperation(kind); setResult(null); }}><span className="session-api-method">GET</span><span>{t(`sessionApi.${kind}`)}</span></button>)}
      </nav>
      <section className="session-api-detail">
        <section className="session-api-request-card">
        <div className="session-api-endpoint"><span className="session-api-method" data-method={method}>{method}</span><code>{url}</code></div>
        {!state?.running && <p>{t("sessionApi.enableHint")}</p>}
        {operation === "getInstanceStatus" && <div className="session-api-form"><label>{t("sessionApi.sessionId")}<input value={queryId} disabled={busy} onChange={event => setQueryId(event.target.value)} /></label></div>}
        {operation === "create" && <div className="session-api-form">
          <label>{t("sessionApi.template")}<select value={templateId} disabled={busy} onChange={event => setTemplateId(event.target.value)}><option value="">{t("sessionApi.selectTemplate")}</option>{templates.map(item => <option key={item.templateId} value={item.templateId} disabled={!item.graphicalSessionEnabled}>{item.title} · {item.agentProvider}{!item.graphicalSessionEnabled ? ` · ${t("sessionApi.unsupported")}` : ""}</option>)}</select></label>
          <button type="button" disabled={busy || !state?.running} onClick={() => void run(() => send("list"))}>{t("sessionApi.refresh")}</button>
          <label>{t("sessionApi.mode")}<select value={mode} disabled={busy} onChange={event => setMode(event.target.value)}><option value="plan">Plan</option><option value="default">{t("sessionApi.normal")}</option></select></label>
          <label>{t("sessionApi.source")}<select value={source} disabled={busy} onChange={event => setSource(event.target.value)}><option value="">{t("sessionApi.inherit")}</option>{[["codex", "Codex"], ["codebuddy", "CodeBuddy"], ["opencode", "OpenCode"], ["claude", "Claude"], ["qoder", "Qoder"], ["gemini", "Gemini"], ["grok", "Grok"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>{t("sessionApi.model")}<input value={modelId} disabled={busy} onChange={event => setModelId(event.target.value)} /></label>
          <label className="session-api-prompt">{t("sessionApi.prompt")}<textarea value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} rows={5} /></label>
          <p className="session-api-prompt">{t("sessionApi.createHint")}</p>
        </div>}
        <div className="session-api-buttons">
          <button className="session-api-primary" type="button" disabled={busy || !state?.running || invalid} onClick={() => void run(() => send())}>{busy ? t("sessionApi.sending") : operation === "create" ? t("sessionApi.sendCreate") : t("sessionApi.send")}</button>
          <button type="button" disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(operation === "create" ? JSON.stringify(body, null, 2) : "{}"); })}>{t("sessionApi.copyJson")}</button>
          <button type="button" disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(curl); })}>{t("sessionApi.copyCurl")}</button>
        </div>
        <details open><summary>{t("sessionApi.request")}</summary><pre>{operation === "create" ? JSON.stringify(body, null, 2) : "{}"}</pre></details>
        <details><summary>cURL</summary><pre>{curl}</pre></details>
        </section>
        <section className="session-api-response-card">
          <div className="session-api-response-heading">
            <h3>{t("sessionApi.response")}</h3>
            {result && <><span className="session-api-http-status" data-success={result.status >= 200 && result.status < 300}>HTTP {result.status}</span><span>{result.elapsedMs} ms</span></>}
            {sessionId && <button type="button" disabled={busy || !state?.running} onClick={() => { setOperation("getInstanceStatus"); setQueryId(sessionId); void run(() => send("getInstanceStatus", sessionId)); }}>{t("sessionApi.queryStatus")}</button>}
            {sessionId && <button type="button" onClick={() => onOpenSession(sessionId)}>{t("sessionApi.openSession")}</button>}
          </div>
          {result && <code className="session-api-response-url">{result.method} {result.url}</code>}
          {result && sentBody !== undefined && <details className="session-api-sent-body"><summary>{t("sessionApi.sentRequest")}</summary><pre>{JSON.stringify(sentBody, null, 2)}</pre></details>}
          <SessionApiResponse key={operation} text={result ? JSON.stringify(result.body, null, 2) ?? "null" : null} visible={visible} onCopy={() => void run(async () => { await navigator.clipboard.writeText(JSON.stringify(result?.body, null, 2) ?? "null"); })} />
        </section>
      </section>
    </div>
  </main>;
}
