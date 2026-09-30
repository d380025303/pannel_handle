import { useEffect, useMemo, useState } from "react";
import { Package, RefreshCw, X } from "lucide-react";
import type { CodeBuddyPluginCatalog, CodeBuddyPluginScope } from "../../vite-env";

const scopeNames: Record<CodeBuddyPluginScope, string> = { user: "用户", project: "项目", local: "本地" };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CodeBuddyPluginDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [catalog, setCatalog] = useState<CodeBuddyPluginCatalog | null>(null);
  const [tab, setTab] = useState<"installed" | "available" | "marketplaces">("installed");
  const [scope, setScope] = useState<CodeBuddyPluginScope>("user");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [marketName, setMarketName] = useState("");
  const [marketAutoUpdate, setMarketAutoUpdate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    void window.codeBuddyPluginApi.list(sessionId)
      .then(value => { if (active) setCatalog(value); })
      .catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [sessionId]);
  const search = query.trim().toLocaleLowerCase();
  const installed = useMemo(() => (catalog?.installed || []).filter(item =>
    `${item.name} ${item.marketplaceName} ${item.scope}`.toLocaleLowerCase().includes(search)), [catalog, search]);
  const available = useMemo(() => (catalog?.available || []).filter(item =>
    !catalog?.installed.some(installedItem => installedItem.id === `${item.name}@${item.marketplaceName}` && installedItem.scope === scope)
    && `${item.name} ${item.marketplaceName} ${item.description || ""}`.toLocaleLowerCase().includes(search)), [catalog, scope, search]);
  async function act(operation: () => Promise<CodeBuddyPluginCatalog>, success: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await operation();
      setCatalog(next);
      setNotice(next.reloadError ? `${success}，但当前会话重载失败：${next.reloadError}` : success);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const api = window.codeBuddyPluginApi;
  return <div className="codex-plugin-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="codex-plugin-dialog" role="dialog" aria-modal="true" aria-label="CodeBuddy 插件管理"
      onKeyDown={event => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}>
      <header><div><strong>CodeBuddy 插件</strong><small>管理当前 Windows 环境的插件和市场</small></div>
        <button type="button" aria-label="关闭插件管理" disabled={busy} onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="codex-plugin-tabs" role="tablist" aria-label="插件管理分页">
        {(["installed", "available", "marketplaces"] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value}
          onClick={() => setTab(value)}>{value === "installed" ? `已安装 ${catalog?.installed.length ?? "…"}` : value === "available" ? "可安装" : "插件市场"}</button>)}
      </div>
      <div className="codex-plugin-toolbar">
        <input type="search" aria-label="搜索插件" placeholder="搜索插件" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" disabled={busy} aria-label="刷新插件列表" onClick={() => void act(() => api.list(sessionId), "列表已刷新。")}><RefreshCw aria-hidden="true" /></button>
        <button type="button" disabled={busy} onClick={() => void act(() => api.reload(sessionId), "当前会话已重载插件。")}>重载插件</button>
      </div>
      {tab === "available" && <div className="codex-plugin-scope">安装范围：{(Object.keys(scopeNames) as CodeBuddyPluginScope[]).map(value =>
        <label key={value}><input type="radio" name="codebuddy-plugin-scope" checked={scope === value} onChange={() => setScope(value)} />{scopeNames[value]}</label>)}
        <small>项目范围可与仓库协作者共享；本地范围仅在当前项目的本机生效。</small></div>}
      {error && <p className="codex-plugin-error" role="alert">{error}</p>}
      {notice && <p className={catalog?.reloadError ? "codex-plugin-error" : "codex-plugin-notice"} role={catalog?.reloadError ? "alert" : "status"}>{notice}</p>}
      {catalog?.errors.length ? <p className="codex-plugin-error" role="alert">市场浏览失败：{catalog.errors.join("；")}</p> : null}
      <div className="codex-plugin-content">
        {tab === "installed" && <section><h3>已安装</h3>{installed.length ? installed.map(item => {
          const installedScope = item.scope === "managed" ? null : item.scope;
          return <article className="codex-plugin-row" key={`${item.id}:${item.scope}`}>
          <div className="codex-plugin-identity"><span className="codex-plugin-icon"><Package aria-hidden="true" /></span><span>
            <strong>{item.name}</strong><small>{item.marketplaceName} · {installedScope ? `${scopeNames[installedScope]}范围` : "托管"} · {item.version || "版本未知"}</small>
            {item.dependencyErrors.length > 0 && <small role="alert">{item.dependencyErrors.join("；")}</small>}
          </span></div>
          {installedScope && <div className="codex-plugin-row-actions">
            <button type="button" disabled={busy} onClick={() => void act(() => item.enabled
              ? api.disable(sessionId, item.name, item.marketplaceName, installedScope)
              : api.enable(sessionId, item.name, item.marketplaceName, installedScope), `插件已${item.enabled ? "停用" : "启用"}。`)}>{item.enabled ? "停用" : "启用"}</button>
            <button type="button" disabled={busy} onClick={() => void act(() => api.update(sessionId, item.name, item.marketplaceName, installedScope), "插件已更新。")}>更新</button>
            <button type="button" disabled={busy} onClick={() => { if (window.confirm(`卸载“${item.name}”的${scopeNames[installedScope]}范围安装？最后一个安装范围卸载后，CodeBuddy 可能删除该插件的数据。`))
              void act(() => api.uninstall(sessionId, item.name, item.marketplaceName, installedScope), "插件已卸载。"); }}>卸载</button>
          </div>}
        </article>; }) : <p>{busy ? "正在读取插件…" : "当前没有匹配的已安装插件。"}</p>}</section>}
        {tab === "available" && <section><h3>可安装</h3>{available.length ? available.slice(0, 100).map(item => <article className="codex-plugin-row" key={`${item.name}@${item.marketplaceName}`}>
          <div className="codex-plugin-identity"><span className="codex-plugin-icon"><Package aria-hidden="true" /></span><span>
            <strong>{item.name}</strong><small>{item.marketplaceName}{item.description ? ` · ${item.description}` : ""}</small>
          </span></div>
          <div className="codex-plugin-row-actions"><button type="button" disabled={busy} onClick={() => void act(() => api.install(sessionId, item.name, item.marketplaceName, scope), `插件已安装到${scopeNames[scope]}范围。`)}>安装</button></div>
        </article>) : <p>{busy ? "正在读取市场…" : "当前范围没有可安装的插件。"}</p>}{available.length > 100 && <p>显示前 100 项，请搜索插件名称。</p>}</section>}
        {tab === "marketplaces" && <section><h3>插件市场</h3>{(catalog?.marketplaces || []).map(item => <div className="codex-plugin-marketplace" key={item.name}>
          <span><strong>{item.name}{item.isBuiltIn ? " · 内置" : ""}</strong><small>{item.description || (typeof item.source === "string" ? item.source : item.source ? JSON.stringify(item.source) : "")}</small></span>
          <div className="codex-plugin-row-actions">
            <button type="button" disabled={busy} onClick={() => void act(() => api.setAutoUpdate(sessionId, item.name, !item.autoUpdate), `市场自动更新已${item.autoUpdate ? "关闭" : "开启"}。`)}>自动更新：{item.autoUpdate ? "开" : "关"}</button>
            <button type="button" disabled={busy} onClick={() => void act(() => api.refreshMarketplace(sessionId, item.name), "市场已刷新。")}>刷新</button>
            {!item.isBuiltIn && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`删除市场“${item.name}”？CodeBuddy 可能同时卸载该市场的插件。`))
              void act(() => api.removeMarketplace(sessionId, item.name), "市场已删除。"); }}>删除</button>}
          </div>
        </div>)}
          <form className="codebuddy-marketplace-form" onSubmit={event => { event.preventDefault(); if (!source.trim() || !marketName.trim()) return;
            void act(async () => { const result = await api.addMarketplace(sessionId, source.trim(), marketName.trim(), marketAutoUpdate);
              setSource(""); setMarketName(""); return result; }, "市场已添加。"); }}>
            <input aria-label="市场名称" placeholder="市场名称" value={marketName} onChange={event => setMarketName(event.target.value)} />
            <input aria-label="插件来源地址" placeholder="本地目录、owner/repo 或 Git URL" value={source} onChange={event => setSource(event.target.value)} />
            <label><input type="checkbox" checked={marketAutoUpdate} onChange={event => setMarketAutoUpdate(event.target.checked)} />自动更新</label>
            <button type="submit" disabled={busy || !source.trim() || !marketName.trim()}>添加市场</button>
          </form>
        </section>}
      </div>
    </section>
  </div>;
}
