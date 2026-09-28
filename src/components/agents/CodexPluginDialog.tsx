import { useEffect, useMemo, useState } from "react";
import { Package, Plus, RefreshCw, X } from "lucide-react";
import type { CodexPluginCatalog, CodexPluginScope, TerminalSession } from "../../vite-env";
import { McpManager } from "../mcp/McpManager";

type Plugin = Record<string, unknown>;
const value = (item: Plugin, ...keys: string[]) => keys.map(key => item[key]).find(entry => typeof entry === "string" && entry) as string | undefined;
const nameOf = (item: Plugin) => value(item, "name", "pluginName", "plugin_name") || "";
const marketplaceOf = (item: Plugin) => value(item, "marketplaceName", "marketplace", "marketplace_name") || "";
const descriptionOf = (item: Plugin) => value(item, "description", "summary") || "";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CodexPluginDialog({ sessionId, session, onClose, onChanged }: { sessionId: string; session?: TerminalSession; onClose: () => void; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<CodexPluginCatalog | null>(null);
  const [tab, setTab] = useState<"plugins" | "mcp">("plugins");
  const [showAvailable, setShowAvailable] = useState(false);
  const [mcpState, setMcpState] = useState<{ sessionId: string; statuses: Array<{ name: string; status: string }> | null; error: string }>({ sessionId, statuses: null, error: "" });
  const [mcpRefresh, setMcpRefresh] = useState(0);
  const [mcpDirty, setMcpDirty] = useState(false);
  const [scope, setScope] = useState<CodexPluginScope>("project");
  const [overrides, setOverrides] = useState<Record<string, { enabled?: boolean }>>({});
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true); setOverrides({});
    void window.codexPluginApi.list(sessionId)
      .then(next => { if (active) { setCatalog(next); setError(""); } })
      .catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [sessionId]);
  useEffect(() => {
    let active = true;
    void window.codexPluginApi.readConfig(sessionId, scope)
      .then(config => { if (active) setOverrides(config.overrides || {}); })
      .catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [sessionId, scope]);
  useEffect(() => {
    let active = true;
    setMcpState({ sessionId, statuses: null, error: "" });
    void window.codexAppServerApi.listCapabilities(sessionId)
      .then(result => { if (active) setMcpState(result.errors?.mcp
        ? { sessionId, statuses: null, error: result.errors.mcp }
        : { sessionId, statuses: result.mcp.map(item => ({ name: item.name, status: item.status })), error: "" }); })
      .catch(cause => { if (active) setMcpState({ sessionId, statuses: null, error: errorText(cause) }); });
    return () => { active = false; };
  }, [sessionId, mcpRefresh]);
  const mcpStatuses = mcpState.sessionId === sessionId ? mcpState.statuses : null;
  const mcpError = mcpState.sessionId === sessionId ? mcpState.error : "";
  const installed = useMemo(() => (catalog?.installed || []).filter(item => `${nameOf(item)} ${marketplaceOf(item)} ${descriptionOf(item)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [catalog, query]);
  const available = useMemo(() => (catalog?.available || []).filter(item => `${nameOf(item)} ${marketplaceOf(item)} ${descriptionOf(item)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [catalog, query]);
  async function act(action: () => Promise<CodexPluginCatalog | { overrides: Record<string, { enabled?: boolean }> }>, changed = true) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      if ("installed" in result) setCatalog(result);
      else setOverrides(result.overrides || {});
      if (changed) { setNotice("setupRequired" in result && Array.isArray(result.setupRequired) && result.setupRequired.length
        ? `插件已安装，还需连接：${result.setupRequired.join("、")}。请开启新的 Codex 会话以加载变更。`
        : "插件状态已更新。请开启新的 Codex 会话以加载变更。"); onChanged(); }
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  function pluginRow(item: Plugin, isInstalled: boolean) {
    const name = nameOf(item); const marketplace = marketplaceOf(item);
    const key = `${name}@${marketplace}`;
    const override = overrides[key]?.enabled;
    const effective = override ?? item.enabled === true;
    const displayName = value(item, "displayName", "name") || name;
    const unavailable = item.availability && item.availability !== "AVAILABLE";
    const managed = item.installPolicy === "INSTALLED_BY_DEFAULT";
    return <article className="codex-plugin-row" key={key}>
      <div className="codex-plugin-identity"><span className="codex-plugin-icon"><Package aria-hidden="true" /></span><span><strong>{displayName || "未知插件"}</strong><small>{descriptionOf(item) || marketplace || "未知来源"}</small></span></div>
      <div className="codex-plugin-row-actions">
        {isInstalled && <button className="codex-plugin-toggle" type="button" role="switch" aria-label={`${displayName} ${effective ? "停用" : "启用"}`} aria-checked={effective} disabled={busy || !name || !marketplace || Boolean(unavailable) || managed} title={managed ? "由 Codex 管理的默认插件" : unavailable ? String(item.disabledReason || "当前账号或工作区不可用") : undefined}
          onClick={() => void act(() => window.codexPluginApi.setEnabled(sessionId, scope, { plugin: name, marketplace, enabled: !effective }))}>
          <span /></button>}
        {!isInstalled && <button type="button" disabled={busy || !name || !marketplace || Boolean(unavailable) || item.installPolicy === "NOT_AVAILABLE"} title={unavailable ? String(item.disabledReason || "当前账号或工作区不可用") : undefined}
          onClick={() => void act(() => window.codexPluginApi.install(sessionId, name, marketplace))}>安装</button>}
        {isInstalled && !managed && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`确定卸载“${displayName}”吗？`)) void act(() => window.codexPluginApi.uninstall(sessionId, name, marketplace)); }}>卸载</button>}
      </div>
    </article>;
  }
  function close() { if (!mcpDirty || window.confirm("MCP 配置有未保存修改，确定关闭吗？")) onClose(); }
  return <div className="codex-plugin-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="codex-plugin-dialog" role="dialog" aria-modal="true" aria-label="Codex 插件管理" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
    }}>
      <header><div><strong>插件</strong><small>管理插件、技能和 MCP · {catalog?.environment || "当前会话"}</small></div>
        <button type="button" aria-label="关闭插件管理" onClick={close}><X aria-hidden="true" /></button></header>
      <div className="codex-plugin-tabs" role="tablist" aria-label="插件管理分页">
        <button type="button" role="tab" aria-selected={tab === "plugins"} onClick={() => { if (!mcpDirty || window.confirm("MCP 配置有未保存修改，确定放弃吗？")) setTab("plugins"); }}>插件 {catalog?.installed.length ?? "…"}</button>
        <button type="button" role="tab" aria-selected={tab === "mcp"} onClick={() => setTab("mcp")}>MCP {mcpStatuses?.length ?? "…"}</button>
      </div>
      {tab === "plugins" ? <><div className="codex-plugin-toolbar">
        <input autoFocus type="search" aria-label="搜索插件" placeholder="搜索插件" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" aria-label="刷新插件列表" disabled={busy} onClick={() => void act(() => window.codexPluginApi.list(sessionId), false)}><RefreshCw aria-hidden="true" /></button>
        <button type="button" onClick={() => setShowAvailable(value => !value)}><Plus aria-hidden="true" />添加</button>
      </div>
      <div className="codex-plugin-scope">启停范围：
        <label><input type="radio" name="codex-plugin-scope" checked={scope === "project"} onChange={() => setScope("project")} />当前项目</label>
        <label><input type="radio" name="codex-plugin-scope" checked={scope === "user"} onChange={() => setScope("user")} />该环境所有项目</label>
      </div>
      {error && <p className="codex-plugin-error" role="alert">{error}</p>}
      {notice && <p className="codex-plugin-notice" role="status">{notice}</p>}
      {catalog?.errors?.length ? <p className="codex-plugin-error" role="alert">{catalog.errors.join("；")}</p> : null}
      <div className="codex-plugin-content">
        <section><h3>已安装</h3>{installed.length ? installed.map(item => pluginRow(item, true)) : <p>{busy ? "正在加载插件…" : error && !catalog ? "读取失败，请刷新重试。" : "没有已安装的插件。"}</p>}</section>
        {showAvailable && <><section><h3>可安装</h3>{available.length ? available.slice(0, 100).map(item => pluginRow(item, false)) : <p>当前账号没有可安装的插件。</p>}{available.length > 100 && <p>显示前 100 项，请搜索插件名称以缩小范围。</p>}</section>
        <section><h3>插件来源</h3>{(catalog?.marketplaces || []).map(item => {
          const name = nameOf(item); const managedSource = ["openai-bundled", "openai-primary-runtime", "openai-curated-remote"].includes(name);
          return <div className="codex-plugin-marketplace" key={name}>
            <span><strong>{name}</strong><small>{value(item, "root", "source", "path", "url")}</small></span>
            <button type="button" disabled={busy || !name || !item.path || managedSource} onClick={() => void act(() => window.codexPluginApi.refreshMarketplace(sessionId, name), false)}>刷新</button>
            <button type="button" disabled={busy || !name || !item.path || managedSource} onClick={() => { if (window.confirm(`确定删除插件来源“${name}”吗？`)) void act(() => window.codexPluginApi.removeMarketplace(sessionId, name)); }}>删除</button>
          </div>;
        })}
          <form onSubmit={event => { event.preventDefault(); if (source.trim()) void act(async () => { const result = await window.codexPluginApi.addMarketplace(sessionId, source.trim()); setSource(""); return result; }, false); }}>
            <input aria-label="插件来源地址" placeholder="本地目录、owner/repo 或 Git URL" value={source} onChange={event => setSource(event.target.value)} />
            <button type="submit" disabled={busy || !source.trim()}>添加来源</button>
          </form>
        </section></>}
      </div></> : <div className="codex-plugin-mcp">
        <section className="codex-plugin-mcp-runtime" aria-label="当前会话 MCP">
          <div className="codex-plugin-mcp-runtime-heading"><div><h3>当前会话 MCP</h3><p>当前图形会话已发现的服务；配置修改需开启新会话后加载。</p></div>
            <button type="button" aria-label="刷新当前会话 MCP" onClick={() => setMcpRefresh(value => value + 1)}><RefreshCw aria-hidden="true" />刷新</button></div>
          {mcpError ? <p role="alert">读取当前会话 MCP 失败：{mcpError}</p>
            : mcpStatuses === null ? <p>正在读取当前会话 MCP…</p>
              : mcpStatuses.length ? <ul>{mcpStatuses.map(item => <li key={item.name}><strong>{item.name}</strong><span>{item.status}</span></li>)}</ul>
                : <p>当前会话没有 MCP 服务。</p>}
        </section>
        <div className="codex-plugin-mcp-config"><h3>配置文件</h3><p>按用户级或项目级查看和编辑配置。此处仅显示所选作用域中的服务。</p></div>
        {session ? <McpManager key={sessionId} session={session} embeddedCodex runtimeStatuses={mcpStatuses || []}
          onDirtyChange={setMcpDirty} onRegisterSave={() => undefined} /> : <p>当前会话信息不可用。</p>}
      </div>}
    </section>
  </div>;
}
