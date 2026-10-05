import { useEffect, useRef, useState } from "react";
import type { CodexAppDetail, CodexPluginDetail, CodexMcpResourceResult, CodexVersionState, CodexAccountState, CodexPluginCatalog, CodexReviewTarget, CodexSessionCapabilities, McpDocument, McpServerDraft, WorkspaceEntrySearchResponse } from "../../src/vite-env";
import type { GraphicalSnapshot } from "./types";
import type { CodexSheet, useGraphicalSession } from "./useGraphicalSession";

type Controller = ReturnType<typeof useGraphicalSession>;
export const codexSheetTitles: Record<CodexSheet, string> = { version: "Codex 版本", capabilities: "Skills、Apps 和 MCP", plugins: "插件管理", goal: "目标管理", review: "代码审查", terminals: "后台终端", account: "Codex 账号", sandbox: "Windows 沙箱初始化", workspace: "工作区文件", "mcp-config": "MCP 配置" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const pluginValue = (plugin: Record<string, unknown>, ...keys: string[]) => String(keys.map(key => plugin[key]).find(value => typeof value === "string" && value) || "");
const emptyDraft = (): McpServerDraft => ({ name: "", enabled: true, transport: "stdio", command: "", args: [], argsMasked: false, cwd: "", url: "", urlMasked: false, bearerTokenEnvVar: "", env: [], headers: [] });

export function CodexAdvancedSheet({ sheet, snapshot, controller }: { sheet: CodexSheet; snapshot: GraphicalSnapshot; controller: Controller }) {
  const { codexRequest: request, insertReference } = controller;
  const [version, setVersion] = useState<CodexVersionState | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [caps, setCaps] = useState<CodexSessionCapabilities | null>(null);
  const [tab, setTab] = useState<"skills" | "apps" | "mcp">(controller.capabilityTab);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<unknown>(null);
  const [catalog, setCatalog] = useState<CodexPluginCatalog | null>(null);
  const [scope, setScope] = useState<"user" | "project">("project");
  const [source, setSource] = useState("");
  const [objective, setObjective] = useState(snapshot.goal?.objective || "");
  const [budget, setBudget] = useState(snapshot.goal?.tokenBudget == null ? "" : String(snapshot.goal.tokenBudget));
  const [reviewType, setReviewType] = useState<CodexReviewTarget["type"]>("uncommittedChanges");
  const [reviewValue, setReviewValue] = useState("");
  const [terminals, setTerminals] = useState<Array<{ processId: string; itemId: string; command: string; cwd: string; osPid?: number | null; cpuPercent?: number | null; rssKb?: number | null }>>([]);
  const [account, setAccount] = useState<CodexAccountState | null>(snapshot.account || null);
  const [files, setFiles] = useState<WorkspaceEntrySearchResponse | null>(null);
  const [doc, setDoc] = useState<McpDocument | null>(null);
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [originalName, setOriginalName] = useState<string | undefined>();
  const [secretEnv, setSecretEnv] = useState("");
  const [secretHeaders, setSecretHeaders] = useState("");
  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await work(); } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const update = <T,>(setter: (value: T) => void, value: T) => { if (mounted.current) setter(value); };
  async function load(refresh = false) {
    if (sheet === "version") update(setVersion, await request<CodexVersionState>("version", { force: refresh }));
    if (sheet === "capabilities") update(setCaps, await request<CodexSessionCapabilities>("capabilities", { refresh }));
    if (sheet === "plugins") update(setCatalog, await request<CodexPluginCatalog>("plugins"));
    if (sheet === "goal") {
      const next = await request<GraphicalSnapshot>("goal.read");
      if (mounted.current) { setObjective(next.goal?.objective || ""); setBudget(next.goal?.tokenBudget == null ? "" : String(next.goal.tokenBudget)); }
    }
    if (sheet === "terminals") update(setTerminals, await request<typeof terminals>("terminals"));
    if (sheet === "account") update(setAccount, await request<CodexAccountState>("account.read"));
    if (sheet === "workspace") update(setFiles, await request<WorkspaceEntrySearchResponse>("workspace-search", { query }));
    if (sheet === "mcp-config") update(setDoc, await request<McpDocument>("mcp-config", { scope }));
  }
  useEffect(() => { mounted.current = true; void run(() => load()); return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (snapshot.account) setAccount(snapshot.account); }, [snapshot.account]);
  const matches = (name: string, description = "") => `${name} ${description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const idleDisabled = !snapshot.threadId || snapshot.busy || snapshot.archived || snapshot.signedOut || snapshot.sandboxSettingUp || busy;
  const confirm = (text: string) => window.confirm(text);
  return <div className="codex-mobile-advanced" aria-busy={busy}>
    {busy && <p role="status">正在处理…</p>}
    {error && <p role="alert">{error}<button type="button" disabled={busy} onClick={() => void run(() => load(true))}>重新加载</button></p>}
    {notice && <p role="status">{notice}</p>}
    {(sheet === "capabilities" || sheet === "plugins" || sheet === "workspace") && <form onSubmit={event => { event.preventDefault(); if (sheet === "workspace") void run(() => load()); }}>
      <label>搜索<input value={query} onChange={event => setQuery(event.target.value)} /></label>
      {sheet === "workspace" && <button disabled={busy}>搜索文件</button>}
    </form>}
    {sheet === "capabilities" && <>
      <div className="graphical-actions" role="tablist">{(["skills", "apps", "mcp"] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} onClick={() => { setTab(value); setDetail(null); }}>{value === "skills" ? "Skills" : value === "apps" ? "Apps" : "MCP"}</button>)}
        <button disabled={busy} onClick={() => void run(() => load(true))}>刷新能力</button></div>
      {caps?.errors[tab] && <p role="alert">{caps.errors[tab]}</p>}
      {tab === "skills" && caps?.skills.filter(skill => matches(skill.name, skill.description)).map(skill => <article key={skill.path}>
        <button disabled={!skill.enabled} onClick={() => insertReference(`$${skill.name}`, { kind: "skill", name: skill.name, path: skill.path, token: `$${skill.name}` })}>{skill.name}{!skill.enabled ? " · 已停用" : ""}</button><p>{skill.description}</p><small>{skill.scope}</small></article>)}
      {tab === "apps" && caps?.apps.filter(app => matches(app.name, app.description)).map(app => <article key={app.id}>
        <button disabled={!app.accessible || !app.enabled || !app.callable} onClick={() => insertReference(`$${app.id}`, { kind: "app", name: app.name, path: `app://${app.id}`, token: `$${app.id}` })}>{app.name}</button><p>{app.description}</p>
        <button disabled={busy} onClick={() => void run(async () => update(setDetail, await request("app-detail", { appId: app.id })))}>查看 App 详情</button></article>)}
      {tab === "mcp" && <><div className="graphical-actions"><button disabled={busy} onClick={() => void run(async () => { await request("mcp-reload"); await load(true); })}>重载 MCP</button><button onClick={() => controller.setActiveSheet("mcp-config")}>MCP 配置</button></div>
        {snapshot.mcpReload?.status === "queued" && <p>重载已排队，等待当前操作结束。</p>}{snapshot.mcpReload?.error && <p role="alert">{snapshot.mcpReload.error}</p>}
        {caps?.mcp.filter(server => matches(server.name)).map(server => <article key={server.name}><strong>{server.name}</strong><p>{snapshot.mcpRuntime?.find(value => value.name === server.name)?.status || server.status} · {server.authStatus}</p>
          {(server.error || server.toolsError) && <p role="alert">{server.error || server.toolsError}</p>}
          <button disabled={busy} onClick={() => void run(async () => { const value = await request<{ authorizationUrl: string }>("mcp-login", { name: server.name }); update(setDetail, { authorizationUrl: value.authorizationUrl }); })}>授权 / 重新连接</button>
          {server.tools.map(tool => <button key={tool.name} disabled={server.status !== "connected"} onClick={() => insertReference(`请使用 MCP 工具 mcp__${server.name}__${tool.name}`)}>{tool.name}<small>{tool.description}</small></button>)}
          {server.resources.map(resource => <button key={resource.uri} disabled={busy} onClick={() => void run(async () => update(setDetail, await request("mcp-resource", { server: server.name, uri: resource.uri })))}>读取资源：{resource.name}</button>)}
          {server.resourceTemplates.map(template => <p key={template.uriTemplate}>{template.name}：{template.uriTemplate}</p>)}
        </article>)}</>}
      {caps && !caps[tab].length && <p>暂无可用能力</p>}
    </>}
    {sheet === "version" && <><p>当前版本：{version?.currentVersion || "未知"} · 最新版本：{version?.latestVersion || "未知"}</p><p>{version?.environment}</p>{version?.error && <p role="alert">{version.error}</p>}{version?.guidance && <p>{version.guidance}</p>}{version?.progress && <pre>{version.progress.output}</pre>}{version?.restartRequired && <p>更新后需要重新连接会话。</p>}<button disabled={busy} onClick={() => void run(() => load(true))}>检查更新</button><button disabled={idleDisabled || version?.status !== "available"} onClick={() => { if (confirm("更新宿主环境中的 Codex CLI？")) void run(async () => update(setVersion, await request<CodexVersionState>("version-update"))); }}>更新 Codex</button></>}
    {sheet === "goal" && <form onSubmit={event => { event.preventDefault(); void run(async () => {
      if (snapshot.goal && objective.trim() !== snapshot.goal.objective && !confirm("替换当前目标？")) return;
      const changes = !snapshot.goal || objective.trim() !== snapshot.goal.objective ? { objective: objective.trim(), status: "active", tokenBudget: budget.trim() ? Number(budget) : null } : { tokenBudget: budget.trim() ? Number(budget) : null };
      await request("goal.set", { changes }); setNotice("目标已保存。");
    }); }}>
      {snapshot.goal && <p>{snapshot.goal.status} · 已用 {snapshot.goal.tokensUsed || 0} Token · 用时 {Math.round(snapshot.goal.timeUsedSeconds || 0)} 秒</p>}
      {snapshot.goalError && <p role="alert">{snapshot.goalError}</p>}
      <label>目标内容<textarea maxLength={4000} value={objective} onChange={event => setObjective(event.target.value)} /></label>
      <label>Token 预算（留空不限）<input type="number" min="1" step="1" value={budget} onChange={event => setBudget(event.target.value)} /></label>
      <button disabled={busy || !objective.trim() || Boolean(budget.trim() && (!Number.isSafeInteger(Number(budget)) || Number(budget) <= 0))}>保存目标</button>
      {snapshot.goal && <><button type="button" disabled={busy} onClick={() => void run(async () => { await request("goal.set", { changes: { status: snapshot.goal?.status === "paused" ? "active" : "paused" } }); })}>{snapshot.goal.status === "paused" ? "恢复目标" : "暂停目标"}</button>
        <button type="button" disabled={busy} onClick={() => { if (confirm("清除当前目标？")) void run(async () => { await request("goal.clear"); setObjective(""); setBudget(""); }); }}>清除目标</button></>}
      <button type="button" disabled={busy} onClick={() => void run(() => load())}>刷新目标</button>
    </form>}
    {sheet === "review" && <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const target: CodexReviewTarget = reviewType === "baseBranch" ? { type: reviewType, branch: reviewValue.trim() } : reviewType === "commit" ? { type: reviewType, sha: reviewValue.trim() } : reviewType === "custom" ? { type: reviewType, instructions: reviewValue.trim() } : { type: reviewType };
      await request("review", { target }); controller.setActiveSheet(null);
    }); }}><p>审查结果显示在当前会话中。</p><label>审查目标<select value={reviewType} onChange={event => { setReviewType(event.target.value as CodexReviewTarget["type"]); setReviewValue(""); }}>
      <option value="uncommittedChanges">未提交修改</option><option value="baseBranch">对比分支</option><option value="commit">指定提交</option><option value="custom">自定义审查要求</option></select></label>
      {reviewType !== "uncommittedChanges" && <label>{reviewType === "baseBranch" ? "基准分支" : reviewType === "commit" ? "提交 SHA" : "审查要求"}<textarea value={reviewValue} onChange={event => setReviewValue(event.target.value)} /></label>}
      <button disabled={idleDisabled || reviewType !== "uncommittedChanges" && !reviewValue.trim()}>开始审查</button></form>}
    {sheet === "terminals" && <><div className="graphical-actions"><button disabled={busy} onClick={() => void run(() => load())}>刷新终端</button><button disabled={busy} onClick={() => { if (confirm("停止并清理所有后台终端？")) void run(async () => { await request("terminals-clean"); await load(); }); }}>清理全部</button></div>
      {!terminals.length && <p>暂无后台终端</p>}{terminals.map(terminal => <article key={terminal.processId}><pre>{terminal.command}</pre><p>{terminal.cwd}</p><small>PID {terminal.osPid ?? "未知"} · CPU {terminal.cpuPercent ?? "未知"}% · 内存 {terminal.rssKb ?? "未知"} KB</small>
        <button disabled={busy} onClick={() => { if (confirm("停止此后台终端？")) void run(async () => { await request("terminal-stop", { processId: terminal.processId }); await load(); }); }}>停止终端</button></article>)}</>}
    {sheet === "account" && <><p>{account?.account?.email || account?.status || "正在读取账号"} {account?.account?.planType}</p>{account?.error && <p role="alert">{account.error}</p>}
      {account?.login && <><p>{account.login.userCode}</p>{account.login.url && <SafeLink url={account.login.url} label="打开登录页面" />}<button disabled={busy} onClick={() => void run(async () => update(setAccount, await request<CodexAccountState>("account.cancel")))}>取消登录</button></>}
      <button disabled={busy} onClick={() => void run(() => load())}>刷新账号</button>
      <button disabled={busy || snapshot.busy} onClick={() => void run(async () => update(setAccount, await request<CodexAccountState>("account.login", { type: "chatgptDeviceCode" })))}>设备码登录</button>
      <button disabled={busy || snapshot.busy} onClick={() => void run(async () => update(setAccount, await request<CodexAccountState>("account.login", { type: "chatgpt" })))}>浏览器登录</button>
      <button disabled={idleDisabled} onClick={() => { if (confirm("退出宿主的 Codex 账号？")) void run(async () => update(setAccount, await request<CodexAccountState>("account.logout"))); }}>退出登录</button></>}
    {sheet === "sandbox" && <><p>在 Windows 宿主初始化沙箱。管理员授权需在电脑上完成。</p><p>{snapshot.windowsSandboxSetup?.status}</p>{snapshot.windowsSandboxSetup?.error && <p role="alert">{snapshot.windowsSandboxSetup.error}</p>}
      {(["elevated", "unelevated"] as const).map(mode => <button key={mode} disabled={busy || snapshot.sandboxSettingUp || snapshot.busy} onClick={() => { if (confirm("在电脑上初始化 Windows 沙箱？")) void run(async () => { await request("sandbox", { mode }); }); }}>{mode === "elevated" ? "管理员初始化" : "普通权限初始化"}</button>)}</>}
    {sheet === "workspace" && <>{files?.results.map(file => <button key={file.path} onClick={() => insertReference(`@${file.relativePath || file.path}`)}>{file.relativePath || file.path}</button>)}{files?.results.length === 0 && <p>没有匹配的文件</p>}</>}
    {sheet === "plugins" && <>
      <label>启停范围<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="project">当前项目</option><option value="user">用户</option></select></label>
      {catalog?.errors?.map((value, i) => <p key={i} role="alert">{value}</p>)}
      <button disabled={busy} onClick={() => void run(() => load())}>刷新插件</button>
      {(["installed", "available"] as const).map(kind => <section key={kind}><h3>{kind === "installed" ? "已安装" : "可安装"}</h3>{catalog?.[kind].filter(plugin => matches(pluginValue(plugin, "name", "pluginName", "plugin_name"))).map((plugin, i) => {
        const name = pluginValue(plugin, "name", "pluginName", "plugin_name"), marketplace = pluginValue(plugin, "marketplaceName", "marketplace", "marketplace_name");
        return <article key={`${name}-${i}`}><strong>{name}</strong><p>{pluginValue(plugin, "description", "summary")}</p><small>{marketplace}</small>
          <button disabled={busy} onClick={() => void run(async () => update(setDetail, await request("plugin-detail", { plugin: name, marketplace })))}>详情</button>
          <button disabled={busy} onClick={() => { if (confirm(`${kind === "installed" ? "卸载" : "安装"}插件 ${name}？`)) void run(async () => { await request(kind === "installed" ? "plugin-uninstall" : "plugin-install", { plugin: name, marketplace }); await load(); setNotice("插件已更新，请新建 Codex 会话加载变更。"); }); }}>{kind === "installed" ? "卸载" : "安装"}</button>
          {kind === "installed" && <button disabled={busy} onClick={() => void run(async () => { await request("plugin-enable", { plugin: name, marketplace, enabled: plugin.enabled === false, scope }); await load(); setNotice("启停设置已更新，请新建 Codex 会话加载变更。"); })}>{plugin.enabled === false ? "启用" : "停用"}</button>}
        </article>;
      })}</section>)}
      <form onSubmit={event => { event.preventDefault(); void run(async () => { await request("marketplace-add", { source }); await load(); setSource(""); }); }}><label>插件市场来源<input value={source} onChange={event => setSource(event.target.value)} /></label><button disabled={busy || !source.trim()}>添加市场</button></form>
      {catalog?.marketplaces.map((marketplace, i) => { const name = pluginValue(marketplace, "name", "marketplaceName", "marketplace_name"); return <article key={i}><strong>{name}</strong><button disabled={busy} onClick={() => void run(async () => { await request("marketplace-refresh", { name }); await load(); })}>刷新市场</button><button disabled={busy} onClick={() => { if (confirm(`移除市场 ${name}？`)) void run(async () => { await request("marketplace-remove", { name }); await load(); }); }}>移除市场</button></article>; })}
    </>}
    {sheet === "mcp-config" && <>
      <label>配置范围<select disabled={busy} value={scope} onChange={event => { const next = event.target.value as typeof scope; setScope(next); setDraft(null); void run(async () => update(setDoc, await request<McpDocument>("mcp-config", { scope: next }))); }}><option value="project">当前项目</option><option value="user">用户</option></select></label>
      <button disabled={busy} onClick={() => void run(() => load())}>刷新配置</button><button disabled={busy} onClick={() => { setDraft(emptyDraft()); setOriginalName(undefined); setSecretEnv(""); setSecretHeaders(""); }}>添加 MCP 服务</button>
      {doc?.servers.map(server => <article key={server.id}><strong>{server.name}</strong><p>{server.enabled ? "已配置 · 启用" : "已配置 · 停用"}</p><button disabled={busy} onClick={() => { setDraft({ ...server }); setOriginalName(server.name); setSecretEnv(""); setSecretHeaders(""); }}>编辑</button><button disabled={busy} onClick={() => { if (confirm(`删除 MCP 配置 ${server.name}？`)) void run(async () => { const result = await request<{ status: string }>("mcp-remove", { scope, name: server.name, expectedVersion: doc.version }); if (result.status === "conflict") throw new Error("配置已变化，请刷新后重试。"); await request("mcp-reload"); await load(); }); }}>删除</button></article>)}
      {draft && <form onSubmit={event => { event.preventDefault(); void run(async () => {
        const parseEntries = (value: string) => value.split("\n").filter(line => line.trim()).map(line => { const index = line.indexOf("="); if (index <= 0) throw new Error("环境变量和请求头使用 KEY=VALUE 格式。"); return { key: line.slice(0, index).trim(), value: line.slice(index + 1), masked: false, hasValue: true }; });
        const next = { ...draft, env: [...draft.env.filter(entry => !parseEntries(secretEnv).some(value => value.key === entry.key)), ...parseEntries(secretEnv)], headers: [...draft.headers.filter(entry => !parseEntries(secretHeaders).some(value => value.key === entry.key)), ...parseEntries(secretHeaders)] };
        const result = await request<{ status: string }>("mcp-save", { scope, draft: next, originalName, expectedVersion: doc?.version });
        if (result.status === "conflict") throw new Error("配置已变化，请刷新后重试。");
        setDraft(null); setSecretEnv(""); setSecretHeaders(""); await request("mcp-reload"); await load(); setNotice("配置已保存，已请求重载 MCP。");
      }); }}>
        <label>服务名称<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>传输<select value={draft.transport} onChange={event => setDraft({ ...draft, transport: event.target.value as McpServerDraft["transport"] })}><option value="stdio">stdio</option><option value="http">HTTP</option><option value="sse">SSE</option></select></label>
        {draft.transport === "stdio" ? <><label>命令<input value={draft.command} onChange={event => setDraft({ ...draft, command: event.target.value })} /></label><label>参数（每行一个）<textarea placeholder={draft.argsMasked ? "已有敏感参数，留空保留" : ""} value={draft.args.join("\n")} onChange={event => setDraft({ ...draft, args: event.target.value.split("\n").filter(Boolean), argsMasked: false })} /></label><label>工作目录<input value={draft.cwd} onChange={event => setDraft({ ...draft, cwd: event.target.value })} /></label></> : <><label>URL<input placeholder={draft.urlMasked ? "已有敏感 URL，留空保留" : ""} value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value, urlMasked: false })} /></label><label>Bearer Token 环境变量<input value={draft.bearerTokenEnvVar} onChange={event => setDraft({ ...draft, bearerTokenEnvVar: event.target.value })} /></label></>}
        <label><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用</label>
        <label>启动超时（秒）<input type="number" min="0" value={draft.startupTimeoutSec ?? ""} onChange={event => setDraft({ ...draft, startupTimeoutSec: event.target.value || undefined })} /></label><label>工具超时（秒）<input type="number" min="0" value={draft.toolTimeoutSec ?? ""} onChange={event => setDraft({ ...draft, toolTimeoutSec: event.target.value || undefined })} /></label>
        {(["env", "headers"] as const).map(kind => draft[kind].map((entry, index) => <div key={`${kind}:${entry.key}`}><span>{entry.key}：{entry.masked ? "已设置（隐藏）" : entry.value}</span><button type="button" disabled={busy} onClick={() => setDraft({ ...draft, [kind]: draft[kind].filter((_, i) => index !== i) })}>移除 {entry.key}</button></div>))}
        <p>现有敏感值保留；新增或替换使用每行 KEY=VALUE。</p><label>环境变量<textarea value={secretEnv} onChange={event => setSecretEnv(event.target.value)} /></label><label>请求头<textarea value={secretHeaders} onChange={event => setSecretHeaders(event.target.value)} /></label>
        <button disabled={busy || !draft.name.trim() || !doc}>保存并重载</button><button type="button" disabled={busy} onClick={() => setDraft(null)}>取消编辑</button>
      </form>}
    </>}
    {detail != null && <section className="codex-mobile-detail"><button onClick={() => setDetail(null)}>关闭详情</button><Detail value={detail} request={request} run={run} setDetail={setDetail} /></section>}
  </div>;
}
function SafeLink({ url, label }: { url: string; label: string }) {
  try { if (!["https:", "http:"].includes(new URL(url).protocol)) return <p>授权链接无效</p>; } catch { return <p>授权链接无效</p>; }
  return <a href={url} target="_blank" rel="noopener noreferrer">{label}</a>;
}
function Detail({ value, request, run, setDetail }: { value: unknown; request: Controller["codexRequest"]; run: (work: () => Promise<void>) => Promise<void>; setDetail: (value: unknown) => void }) {
  if (!value || typeof value !== "object") return <pre>{typeof value === "string" ? value : "暂无详情"}</pre>;
  const item = value as Record<string, unknown>;
  if (typeof item.authorizationUrl === "string") return <><p>请在授权页面完成连接，然后刷新 MCP 状态。</p><SafeLink url={item.authorizationUrl} label="打开授权页面" /></>;
  if (Array.isArray(item.skills)) {
    const plugin = value as CodexPluginDetail;
    return <><h3>{plugin.name}</h3><p>{plugin.description || "暂无说明"}</p><p>版本：{plugin.version || "未提供"} · {plugin.installed ? "已安装" : "未安装"} · {plugin.enabled ? "已启用" : "未启用"}</p>
      <h4>Skills</h4>{plugin.skills.map(skill => <article key={skill.name}><button disabled={!plugin.remotePluginId} onClick={() => void run(async () => setDetail(await request("plugin-skill", { plugin: plugin.name, marketplace: plugin.marketplaceName, skill: skill.name })))}>读取 Skill：{skill.name}</button><p>{skill.description}{!skill.enabled ? " · 已停用" : ""}</p></article>)}
      <h4>Apps</h4>{plugin.apps.map((app, index) => <p key={index}>{app.name}</p>)}<h4>MCP 服务</h4>{plugin.mcpServers.map(name => <p key={name}>{name}</p>)}
    </>;
  }
  if (Array.isArray(item.tools)) {
    const app = value as CodexAppDetail;
    return <><h3>{app.name}</h3><p>{app.description || "暂无说明"}</p><p>{app.accessible ? app.callable ? "可在会话中调用" : app.enabled ? "已启用，当前不可调用" : "未启用" : "当前账号不可访问"}</p><p>所属插件：{app.pluginDisplayNames.join("、") || "未提供"}</p>
      <h4>工具</h4>{app.tools.map(tool => <article key={tool.name}><strong>{tool.title}</strong><p>{tool.description || "暂无说明"}</p><small>{tool.readOnly ? "只读" : "可执行操作"} · {tool.enabled ? "已启用" : tool.disabledReason || "不可用"}</small></article>)}
    </>;
  }
  if (Array.isArray(item.contents)) {
    const resource = value as CodexMcpResourceResult;
    return <>{resource.contents.map((content, index) => <article key={index}><small>{content.uri} · {content.mimeType || "未知类型"}</small><pre>{content.binary ? "二进制资源，仅显示类型与地址。" : content.text || "（空内容）"}</pre>{content.truncated && <p>仅显示前 64 KiB。</p>}</article>)}{resource.truncated && <p>仅显示前 20 项资源内容。</p>}</>;
  }
  if (typeof item.contents === "string") return <><pre>{item.contents}</pre>{item.truncated === true && <p>仅显示前 64 KiB。</p>}</>;
  return <p>暂无可显示的详情。</p>;
}
