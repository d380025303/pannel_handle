import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cable, Copy, Eye, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { SessionStatusMcpPanel } from "./SessionStatusMcpPanel";
import type {
  McpDocument,
  McpProvider,
  McpScope,
  McpSecretEntry,
  McpServerDraft,
  McpServerSummary,
  TerminalSession
} from "../../vite-env";

type McpManagerProps = {
  api?: typeof window.mcpApi;
  session?: TerminalSession;
  embeddedCodex?: boolean;
  embeddedCodeBuddy?: boolean;
  runtimeStatuses?: Array<{ name: string; status: string }>;
  onDirtyChange: (dirty: boolean) => void;
  onRegisterSave: (handler: (() => Promise<boolean>) | null) => void;
  onCommitted?: () => void;
};

const emptyDraft = (provider: McpProvider): McpServerDraft => ({
  name: "",
  enabled: true,
  transport: "stdio",
  command: "",
  args: [],
  argsMasked: false,
  cwd: "",
  url: "",
  urlMasked: false,
  bearerTokenEnvVar: "",
  env: [],
  headers: [],
  startupTimeoutSec: provider === "codex" ? "" : undefined,
  toolTimeoutSec: provider === "codex" ? "" : undefined
});

function cloneDraft(server: McpServerSummary): McpServerDraft {
  return {
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    args: [...server.args],
    argsMasked: server.argsMasked,
    cwd: server.cwd,
    url: server.url,
    urlMasked: server.urlMasked,
    bearerTokenEnvVar: server.bearerTokenEnvVar,
    env: server.env.map((entry) => ({ ...entry })),
    headers: server.headers.map((entry) => ({ ...entry })),
    startupTimeoutSec: server.startupTimeoutSec ?? "",
    toolTimeoutSec: server.toolTimeoutSec ?? ""
  };
}

function draftSignature(draft: McpServerDraft | null) {
  return draft ? JSON.stringify(draft) : "";
}

type SecretRowsProps = {
  entries: McpSecretEntry[];
  disabled: boolean;
  keyLabel: string;
  valueLabel: string;
  onChange: (entries: McpSecretEntry[]) => void;
  onReveal: (key: string) => void;
};

function SecretRows({ entries, disabled, keyLabel, valueLabel, onChange, onReveal }: SecretRowsProps) {
  const update = (index: number, patch: Partial<McpSecretEntry>) => {
    onChange(entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry));
  };
  return (
    <div className="mcp-key-values">
      {entries.map((entry, index) => (
        <div className="mcp-key-value-row" key={`${entry.key}-${index}`}>
          <input aria-label={keyLabel} value={entry.key} disabled={disabled || entry.masked} onChange={(event) => update(index, { key: event.target.value })} />
          <input
            aria-label={valueLabel}
            type={entry.masked ? "password" : "text"}
            value={entry.masked ? "••••••••" : entry.value}
            disabled={disabled || entry.masked}
            autoComplete="off"
            onChange={(event) => update(index, { value: event.target.value, hasValue: Boolean(event.target.value) })}
          />
          {entry.masked && (
            <button className="icon-button" type="button" disabled={disabled} title={valueLabel} aria-label={valueLabel} onClick={() => onReveal(entry.key)}>
              <Eye aria-hidden="true" />
            </button>
          )}
          <button className="icon-button danger" type="button" disabled={disabled} aria-label="Remove" onClick={() => onChange(entries.filter((_value, entryIndex) => entryIndex !== index))}>
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
      <button className="mcp-add-row" type="button" disabled={disabled} onClick={() => onChange([...entries, { key: "", value: "", masked: false, hasValue: false }])}>
        <Plus aria-hidden="true" />
      </button>
    </div>
  );
}

export function McpManager({ api = window.mcpApi, session, embeddedCodex = false, embeddedCodeBuddy = false, runtimeStatuses = [], onDirtyChange, onRegisterSave, onCommitted }: McpManagerProps) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<McpProvider>(embeddedCodeBuddy ? "codebuddy" : "codex");
  const [scope, setScope] = useState<McpScope>("user");
  const [document, setDocument] = useState<McpDocument | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [originalName, setOriginalName] = useState<string | undefined>();
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [savedSignature, setSavedSignature] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestRef = useRef(0);
  const dirty = Boolean(draft && draftSignature(draft) !== savedSignature);
  const projectAvailable = Boolean(session?.cwd) && (session?.type === "windows" || embeddedCodex);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const targetFor = useCallback((nextProvider: McpProvider, nextScope: McpScope) => ({
    provider: nextProvider,
    scope: nextScope,
    ...((nextScope !== "user" || embeddedCodex) && session ? { sessionId: session.id } : {})
  }), [session?.id, embeddedCodex]);

  const requestTarget = useCallback(() => targetFor(provider, scope), [provider, scope, targetFor]);

  const selectServer = useCallback((server: McpServerSummary | undefined) => {
    if (!server) {
      setSelectedName(null);
      setOriginalName(undefined);
      setDraft(null);
      setSavedSignature("");
      return;
    }
    const nextDraft = cloneDraft(server);
    setSelectedName(server.name);
    setOriginalName(server.name);
    setDraft(nextDraft);
    setSavedSignature(draftSignature(nextDraft));
  }, []);

  const load = useCallback(async (nextProvider: McpProvider, nextScope: McpScope, preferredName?: string) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await api.list(targetFor(nextProvider, nextScope));
      if (requestRef.current !== requestId) return;
      setDocument(next);
      const selected = next.servers.find((server) => server.name === preferredName) || next.servers[0];
      selectServer(selected);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setDocument(null);
      selectServer(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [selectServer, targetFor]);

  useEffect(() => { void load(embeddedCodeBuddy ? "codebuddy" : "codex", "user"); }, [load, embeddedCodeBuddy]);

  const confirmDiscard = useCallback(() => !dirty || window.confirm(t("mcp.discardChanges")), [dirty, t]);

  const save = useCallback(async () => {
    if (!draft || !document || !dirty) return true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.save({
        ...requestTarget(),
        originalName,
        draft,
        expectedVersion: document.version
      });
      if (result.status === "conflict") {
        setError(t("mcp.conflict"));
        return false;
      }
      setDocument(result.document);
      const saved = result.document.servers.find((server) => server.name === result.serverName);
      selectServer(saved);
      setNotice(t("mcp.saved"));
      onCommitted?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirty, document, draft, originalName, requestTarget, selectServer, t, onCommitted]);

  useEffect(() => {
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [onRegisterSave, save]);

  const switchTarget = (nextProvider: McpProvider, nextScope: McpScope) => {
    if ((nextProvider === provider && nextScope === scope) || !confirmDiscard()) return;
    setProvider(nextProvider);
    setScope(nextScope);
    setQuery("");
    void load(nextProvider, nextScope);
  };

  const startCreate = () => {
    if (!confirmDiscard()) return;
    const next = emptyDraft(provider);
    setSelectedName(null);
    setOriginalName(undefined);
    setDraft(next);
    setSavedSignature("");
    setError("");
    setNotice("");
  };

  const remove = async () => {
    if (!document || !originalName || !window.confirm(t("mcp.confirmDelete", { name: originalName }))) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.remove({ ...requestTarget(), name: originalName, expectedVersion: document.version });
      if (result.status === "conflict") {
        setError(t("mcp.conflict"));
        return;
      }
      setDocument(result.document);
      selectServer(result.document.servers[0]);
      setNotice(t("mcp.removed"));
      onCommitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const copyServer = async () => {
    if (!document || !originalName || dirty || (provider !== "codex" && provider !== "opencode")) return;
    const destinationProvider: McpProvider = provider === "codex" ? "opencode" : "codex";
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const destination = await api.list(targetFor(destinationProvider, scope));
      const result = await api.copy({
        source: requestTarget(), name: originalName,
        expectedSourceVersion: document.version,
        expectedDestinationVersion: destination.version
      });
      if (result.status === "conflict") { setError(t("mcp.conflict")); return; }
      if (result.status === "exists") { setError(t("mcp.copyExists", { name: originalName })); return; }
      setProvider(destinationProvider);
      setQuery("");
      setDocument(result.document);
      selectServer(result.document.servers.find(server => server.name === result.serverName));
      setNotice(t(result.permissionsCopied ? "mcp.copiedWithPermissions" : "mcp.copied",
        { provider: destinationProvider === "codex" ? "Codex" : "OpenCode" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const reveal = async (field: "url" | "args" | "env" | "headers", key?: string) => {
    if (!document || !originalName || !draft) return;
    setError("");
    try {
      const result = await api.reveal({ ...requestTarget(), name: originalName, field, key, expectedVersion: document.version });
      if (result.status === "conflict") {
        setError(t("mcp.conflict"));
        return;
      }
      const nextDraft = field === "url" ? { ...draft, url: result.value, urlMasked: false }
        : field === "args" ? { ...draft, args: JSON.parse(result.value) as string[], argsMasked: false } : {
        ...draft,
        [field]: draft[field].map((entry) => entry.key === key ? { ...entry, value: result.value, masked: false } : entry)
      };
      setDraft(nextDraft);
      if (!dirty) setSavedSignature(draftSignature(nextDraft));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const filteredServers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return document?.servers || [];
    return (document?.servers || []).filter((server) => `${server.name}\n${server.command}\n${server.url}`.toLocaleLowerCase().includes(normalized));
  }, [document, query]);

  const scopes: Array<{ value: McpScope; label: string; project: boolean }> = provider !== "codebuddy"
    ? [{ value: "user", label: t("mcp.scopeUser"), project: false }, { value: "project", label: t("mcp.scopeProject"), project: true }]
    : [
      { value: "user", label: t("mcp.scopeUser"), project: false },
      { value: "project-local", label: t("mcp.scopeProjectLocal"), project: true },
      { value: "project", label: t("mcp.scopeProjectShared"), project: true }
    ];

  return (
    <main className="mcp-page">
      <header className="mcp-header">
        <div>
          <Cable aria-hidden="true" />
          <div><h1>{t("mcp.title")}</h1><p>{t("mcp.description")}</p></div>
        </div>
        <div className="mcp-header-actions">
          {!embeddedCodex && !embeddedCodeBuddy && originalName && (provider === "codex" || provider === "opencode") &&
            <button className="mcp-copy" type="button" disabled={saving || dirty || loading} onClick={() => void copyServer()}>
              <Copy aria-hidden="true" />{t("mcp.copyTo", { provider: provider === "codex" ? "OpenCode" : "Codex" })}
            </button>}
          {originalName && <button className="mcp-delete" type="button" disabled={saving} onClick={() => void remove()}><Trash2 aria-hidden="true" />{t("common.delete")}</button>}
          <button className="mcp-save" type="button" disabled={!dirty || saving} onClick={() => void save()}><Save aria-hidden="true" />{saving ? t("mcp.saving") : t("common.save")}</button>
        </div>
      </header>

      {!embeddedCodex && !embeddedCodeBuddy && <SessionStatusMcpPanel />}
      {!embeddedCodex && !embeddedCodeBuddy && <div className="mcp-provider-tabs" role="tablist" aria-label={t("mcp.provider")}>
        <button type="button" role="tab" aria-selected={provider === "codex"} className={provider === "codex" ? "active" : ""} onClick={() => switchTarget("codex", "user")}>Codex</button>
        <button type="button" role="tab" aria-selected={provider === "opencode"} className={provider === "opencode" ? "active" : ""} onClick={() => switchTarget("opencode", "user")}>OpenCode</button>
        <button type="button" role="tab" aria-selected={provider === "codebuddy"} className={provider === "codebuddy" ? "active" : ""} onClick={() => switchTarget("codebuddy", "user")}>CodeBuddy</button>
      </div>}
      <div className="mcp-scope-tabs" role="tablist" aria-label={t("mcp.scope")}>
        {scopes.map((item) => (
          <button key={item.value} type="button" role="tab" aria-selected={scope === item.value} className={scope === item.value ? "active" : ""} disabled={item.project && !projectAvailable} title={item.project && !projectAvailable ? t("mcp.projectUnavailable") : undefined} onClick={() => switchTarget(provider, item.value)}>
            {item.label}
          </button>
        ))}
      </div>

      <div className="mcp-workspace">
        <aside className="mcp-sidebar">
          <div className="mcp-list-toolbar">
            <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("mcp.search")} aria-label={t("mcp.search")} /></label>
            <button className="icon-button" type="button" disabled={loading} title={t("common.refresh")} aria-label={t("common.refresh")} onClick={() => { if (confirmDiscard()) void load(provider, scope, selectedName || undefined); }}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" /></button>
            <button className="icon-button" type="button" title={t("mcp.add")} aria-label={t("mcp.add")} onClick={startCreate}><Plus aria-hidden="true" /></button>
          </div>
          {document && <p className="mcp-config-path" title={document.path}>{document.path}</p>}
          {scope === "project" && <p className="mcp-shared-warning">{t("mcp.sharedWarning")}</p>}
          <div className="mcp-list">
            {loading ? <p className="mcp-list-state">{t("common.loading")}</p> : filteredServers.length === 0 ? <div className="mcp-empty"><Cable aria-hidden="true" /><strong>{query ? t("mcp.noMatches") : t("mcp.empty")}</strong></div> : filteredServers.map((server) => (
              <button className={`mcp-list-item${selectedName === server.name ? " active" : ""}`} type="button" key={server.id} onClick={() => { if (confirmDiscard()) selectServer(server); }}>
                <span><strong>{server.name}</strong><i className={server.enabled ? "enabled" : "disabled"}>{server.enabled ? t("mcp.enabled") : t("mcp.disabled")}</i></span>
                <small>{server.transport.toUpperCase()} · {server.command || server.url || t("mcp.masked")}{runtimeStatuses.find(item => item.name === server.name) ? ` · ${runtimeStatuses.find(item => item.name === server.name)?.status}` : ""}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="mcp-editor-panel">
          {error && <div className="mcp-error" role="alert">{error}</div>}
          {notice && <div className="mcp-notice" role="status">{notice}</div>}
          {!draft ? <div className="mcp-editor-state">{loading ? t("common.loading") : t("mcp.selectHint")}</div> : (
            <div className="mcp-form">
              <div className="mcp-form-heading">
                <div><h2>{originalName || t("mcp.newServer")}{dirty && <span> *</span>}</h2><p>{embeddedCodeBuddy ? "配置保存后需重启当前 CodeBuddy 会话生效。" : embeddedCodex ? "保存后会请求当前 Codex 会话重载 MCP。" : t("mcp.restartHint")}</p></div>
                <label className="mcp-enabled-toggle"><input type="checkbox" checked={draft.enabled} disabled={saving} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>{t("mcp.enabled")}</span></label>
              </div>
              <div className="mcp-form-grid">
                <label><span>{t("mcp.name")}</span><input value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label><span>{t("mcp.transport")}</span><select value={draft.transport} disabled={saving} onChange={(event) => setDraft({ ...draft, transport: event.target.value as McpServerDraft["transport"] })}>
                  <option value="stdio">stdio</option><option value="http">HTTP</option>{provider === "codebuddy" && <option value="sse">SSE</option>}
                </select></label>
              </div>

              {draft.transport === "stdio" ? (
                <>
                  <label className="mcp-field"><span>{t("mcp.command")}</span><input value={draft.command} disabled={saving} onChange={(event) => setDraft({ ...draft, command: event.target.value })} /></label>
                  <label className="mcp-field"><span>{t("mcp.args")}</span><div className="mcp-secret-input"><textarea value={draft.argsMasked ? "••••••••" : draft.args.join("\n")} disabled={saving || draft.argsMasked} placeholder={t("mcp.argsHint")} onChange={(event) => setDraft({ ...draft, args: event.target.value.split(/\r?\n/).filter((value) => value !== "") })} />{draft.argsMasked && <button className="icon-button" type="button" disabled={saving} title={t("mcp.reveal")} aria-label={t("mcp.reveal")} onClick={() => void reveal("args")}><Eye aria-hidden="true" /></button>}</div></label>
                  {provider !== "codebuddy" && <label className="mcp-field"><span>{t("mcp.cwd")}</span><input value={draft.cwd} disabled={saving} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} /></label>}
                  <fieldset><legend>{t("mcp.env")}</legend><SecretRows entries={draft.env} disabled={saving} keyLabel={t("mcp.envKey")} valueLabel={t("mcp.reveal")} onChange={(env) => setDraft({ ...draft, env })} onReveal={(key) => void reveal("env", key)} /></fieldset>
                </>
              ) : (
                <>
                  <label className="mcp-field"><span>{t("mcp.url")}</span><div className="mcp-secret-input"><input type={draft.urlMasked ? "password" : "text"} value={draft.urlMasked ? "••••••••" : draft.url} disabled={saving || draft.urlMasked} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />{draft.urlMasked && <button className="icon-button" type="button" disabled={saving} title={t("mcp.reveal")} onClick={() => void reveal("url")}><Eye aria-hidden="true" /></button>}</div></label>
                  {provider === "codex" && <label className="mcp-field"><span>{t("mcp.bearerEnv")}</span><input value={draft.bearerTokenEnvVar} disabled={saving} onChange={(event) => setDraft({ ...draft, bearerTokenEnvVar: event.target.value })} /></label>}
                  <fieldset><legend>{t("mcp.headers")}</legend><SecretRows entries={draft.headers} disabled={saving} keyLabel={t("mcp.headerKey")} valueLabel={t("mcp.reveal")} onChange={(headers) => setDraft({ ...draft, headers })} onReveal={(key) => void reveal("headers", key)} /></fieldset>
                </>
              )}
              {provider !== "codebuddy" && <div className="mcp-form-grid">
                <label><span>{t("mcp.startupTimeout")}</span><input type="number" min="0.1" step="0.1" value={draft.startupTimeoutSec ?? ""} disabled={saving} onChange={(event) => setDraft({ ...draft, startupTimeoutSec: event.target.value })} /></label>
                <label><span>{t("mcp.toolTimeout")}</span><input type="number" min="0.1" step="0.1" value={draft.toolTimeoutSec ?? ""} disabled={saving} onChange={(event) => setDraft({ ...draft, toolTimeoutSec: event.target.value })} /></label>
              </div>}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
