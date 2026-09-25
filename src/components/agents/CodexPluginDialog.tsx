import { useEffect, useMemo, useState } from "react";
import { Package, RefreshCw, X } from "lucide-react";
import type { CodexPluginCatalog, CodexPluginScope } from "../../vite-env";

type Plugin = Record<string, unknown>;
const value = (item: Plugin, ...keys: string[]) => keys.map(key => item[key]).find(entry => typeof entry === "string" && entry) as string | undefined;
const nameOf = (item: Plugin) => value(item, "name", "pluginName", "plugin_name") || "";
const marketplaceOf = (item: Plugin) => value(item, "marketplaceName", "marketplace", "marketplace_name") || "";
const descriptionOf = (item: Plugin) => value(item, "description", "summary") || "";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CodexPluginDialog({ sessionId, onClose, onChanged }: { sessionId: string; onClose: () => void; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<CodexPluginCatalog | null>(null);
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
    void Promise.all([window.codexPluginApi.list(sessionId), window.codexPluginApi.readConfig(sessionId, scope)])
      .then(([next, config]) => { if (active) { setCatalog(next); setOverrides(config.overrides || {}); setError(""); } })
      .catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [sessionId, scope]);
  const installed = useMemo(() => (catalog?.installed || []).filter(item => `${nameOf(item)} ${marketplaceOf(item)} ${descriptionOf(item)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [catalog, query]);
  const available = useMemo(() => (catalog?.available || []).filter(item => `${nameOf(item)} ${marketplaceOf(item)} ${descriptionOf(item)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [catalog, query]);
  async function act(action: () => Promise<CodexPluginCatalog | { overrides: Record<string, { enabled?: boolean }> }>, changed = true) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      if ("installed" in result) setCatalog(result);
      else setOverrides(result.overrides || {});
      if (changed) { setNotice("插件状态已更新。请开启新的 Codex 会话以加载变更。"); onChanged(); }
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  function pluginRow(item: Plugin, isInstalled: boolean) {
    const name = nameOf(item); const marketplace = marketplaceOf(item);
    const key = `${name}@${marketplace}`;
    const override = overrides[key]?.enabled;
    const effective = override ?? (item.enabled !== false);
    return <article className="codex-plugin-row" key={key}>
      <div><strong>{name || "未知插件"}</strong><small>{marketplace || "未知来源"}</small>
        {descriptionOf(item) && <p>{descriptionOf(item)}</p>}</div>
      <div className="codex-plugin-row-actions">
        {isInstalled && <button type="button" disabled={busy || !name || !marketplace} onClick={() => void act(() => window.codexPluginApi.setEnabled(sessionId, scope, { plugin: name, marketplace, enabled: !effective }))}>
          {effective ? "停用" : "启用"}（{scope === "project" ? "当前项目" : "所有项目"}）</button>}
        <button type="button" disabled={busy || !name || !marketplace || (!isInstalled && item.installPolicy === "NOT_AVAILABLE")} onClick={() => void act(() => isInstalled
          ? window.codexPluginApi.uninstall(sessionId, name, marketplace) : window.codexPluginApi.install(sessionId, name, marketplace))}>
          {isInstalled ? "卸载" : "安装"}</button>
      </div>
    </article>;
  }
  return <div className="codex-plugin-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="codex-plugin-dialog" role="dialog" aria-modal="true" aria-label="Codex 插件管理" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
      <header><div><Package aria-hidden="true" /><strong>Codex 插件</strong><small>{catalog?.environment}</small></div>
        <button type="button" aria-label="关闭插件管理" onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="codex-plugin-toolbar">
        <input autoFocus type="search" aria-label="搜索插件" placeholder="搜索插件" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" aria-label="刷新插件列表" disabled={busy} onClick={() => void act(() => window.codexPluginApi.list(sessionId), false)}><RefreshCw aria-hidden="true" /></button>
      </div>
      <div className="codex-plugin-scope">启停范围：
        <label><input type="radio" name="codex-plugin-scope" checked={scope === "project"} onChange={() => setScope("project")} />当前项目</label>
        <label><input type="radio" name="codex-plugin-scope" checked={scope === "user"} onChange={() => setScope("user")} />该环境所有项目</label>
      </div>
      {error && <p className="codex-plugin-error" role="alert">{error}</p>}
      {notice && <p className="codex-plugin-notice" role="status">{notice}</p>}
      <div className="codex-plugin-content">
        <section><h3>已安装</h3>{installed.length ? installed.map(item => pluginRow(item, true)) : <p>没有已安装的插件。</p>}</section>
        <section><h3>可安装</h3>{available.length ? available.map(item => pluginRow(item, false)) : <p>当前来源没有可安装的插件。</p>}</section>
        <section><h3>插件来源</h3>{(catalog?.marketplaces || []).map(item => {
          const name = nameOf(item); return <div className="codex-plugin-marketplace" key={name}>
            <span><strong>{name}</strong><small>{value(item, "root", "source", "path", "url")}</small></span>
            <button type="button" disabled={busy || !name} onClick={() => void act(() => window.codexPluginApi.refreshMarketplace(sessionId, name), false)}>刷新</button>
            <button type="button" disabled={busy || !name} onClick={() => void act(() => window.codexPluginApi.removeMarketplace(sessionId, name))}>删除</button>
          </div>;
        })}
          <form onSubmit={event => { event.preventDefault(); if (source.trim()) void act(async () => { const result = await window.codexPluginApi.addMarketplace(sessionId, source.trim()); setSource(""); return result; }, false); }}>
            <input aria-label="插件来源地址" placeholder="本地目录、owner/repo 或 Git URL" value={source} onChange={event => setSource(event.target.value)} />
            <button type="submit" disabled={busy || !source.trim()}>添加来源</button>
          </form>
        </section>
      </div>
    </section>
  </div>;
}
