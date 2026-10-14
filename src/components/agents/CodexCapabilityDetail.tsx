import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CodexAppDetail, CodexMcpResourceResult, CodexPluginDetail, CodexSessionCapabilities } from "../../vite-env";

export type CapabilityDetailTarget =
  | { kind: "plugin"; name: string; marketplace: string }
  | { kind: "app"; id: string }
  | { kind: "mcp"; server: CodexSessionCapabilities["mcp"][number] };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CodexCapabilityDetail({ sessionId, target, onClose }: { sessionId: string; target: CapabilityDetailTarget; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);
  const [plugin, setPlugin] = useState<CodexPluginDetail | null>(null);
  const [app, setApp] = useState<CodexAppDetail | null>(null);
  const [loading, setLoading] = useState(target.kind !== "mcp");
  const [error, setError] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [skillTruncated, setSkillTruncated] = useState(false);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [resourceContent, setResourceContent] = useState<CodexMcpResourceResult | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [itemError, setItemError] = useState("");
  const targetKey = target.kind === "plugin" ? `plugin:${target.marketplace}:${target.name}`
    : target.kind === "app" ? `app:${target.id}` : `mcp:${target.server.name}`;
  useEffect(() => {
    let active = true;
    setPlugin(null); setApp(null); setError(""); setLoading(target.kind !== "mcp");
    const load = target.kind === "plugin" ? window.codexAppServerApi.readPluginDetail(sessionId, target.name, target.marketplace)
      : target.kind === "app" ? window.codexAppServerApi.readAppDetail(sessionId, target.id) : null;
    if (load) void load.then(value => { if (active) {
      if (target.kind === "plugin") setPlugin(value as CodexPluginDetail); else setApp(value as CodexAppDetail);
    } }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, targetKey]);
  async function readSkill(name: string) {
    if (target.kind !== "plugin") return;
    setSelectedSkill(name); setSkillContent(null); setSkillTruncated(false); setItemError(""); setItemLoading(true);
    try { const result = await window.codexAppServerApi.readPluginSkill(sessionId, target.name, target.marketplace, name);
      setSkillContent(result.contents || "此技能没有可读取的正文。"); setSkillTruncated(result.truncated); }
    catch (cause) { setItemError(errorText(cause)); }
    finally { setItemLoading(false); }
  }
  async function readResource(uri: string) {
    if (target.kind !== "mcp") return;
    setSelectedResource(uri); setResourceContent(null); setItemError(""); setItemLoading(true);
    try { setResourceContent(await window.codexAppServerApi.readMcpResource(sessionId, target.server.name, uri)); }
    catch (cause) { setItemError(errorText(cause)); }
    finally { setItemLoading(false); }
  }
  const title = target.kind === "plugin" ? target.name : target.kind === "app" ? app?.name || target.id : target.server.name;
  return <div className="codex-capability-detail-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="codex-capability-detail" role="dialog" aria-modal="true" aria-label={`${title} 详情`} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        event.stopPropagation();
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          "button, input, textarea, select, a[href], [tabindex]"
        )).filter(element => element.tabIndex >= 0 && !element.matches(":disabled")
          && !element.closest('[hidden], [inert], [aria-hidden="true"]')
          && element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible");
        if (!elements.length) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
      }
    }}>
      <header><strong>{title} 详情</strong><button ref={closeButton} type="button" aria-label="关闭详情" onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="codex-capability-detail-body">
        {loading && <p>正在读取详情…</p>}{error && <p role="alert">读取详情失败：{error}</p>}
        {plugin && <>
          <p>{plugin.description || "暂无说明"}</p>
          <dl><dt>来源</dt><dd>{plugin.marketplaceName} · {plugin.source?.type || "未知"}</dd><dt>版本</dt><dd>{plugin.version || "未提供"}</dd>
            <dt>状态</dt><dd>{plugin.installed ? plugin.enabled ? "已安装并启用" : "已安装，未启用" : "未安装"}</dd></dl>
          {plugin.shareUrl?.startsWith("https://") && <button type="button" onClick={() => void window.externalLinkApi.open(plugin.shareUrl!).catch(cause => setItemError(errorText(cause)))}>查看插件页面</button>}
          <h4>Skills</h4>{plugin.skills.length ? <ul>{plugin.skills.map(skill => <li key={skill.name}>
            <button type="button" disabled={!plugin.remotePluginId || itemLoading} onClick={() => void readSkill(skill.name)}>{skill.name}</button>
            <span>{skill.description}{!skill.enabled ? " · 未启用" : ""}</span></li>)}</ul> : <p>没有附带 Skills。</p>}
          <h4>Apps</h4>{plugin.apps.length ? <ul>{plugin.apps.map((item, index) => <li key={`${item.name}-${index}`}>{item.name}</li>)}</ul> : <p>没有附带 Apps。</p>}
          <h4>MCP 服务</h4>{plugin.mcpServers.length ? <ul>{plugin.mcpServers.map(name => <li key={name}>{name}</li>)}</ul> : <p>没有附带 MCP 服务。</p>}
        </>}
        {app && <><p>{app.description || "暂无说明"}</p><dl><dt>状态</dt><dd>{app.accessible ? app.callable ? "可在会话中调用" : app.enabled ? "已启用，当前不可调用" : "未启用" : "当前账号不可访问"}</dd>
          <dt>分发渠道</dt><dd>{app.distributionChannel || "未提供"}</dd><dt>所属插件</dt><dd>{app.pluginDisplayNames.join("、") || "未提供"}</dd></dl>
          <h4>工具</h4>{app.tools.length ? <ul>{app.tools.map(tool => <li key={tool.name}><strong>{tool.title}</strong> · {tool.name}
            <span>{tool.description || "暂无说明"} · {tool.readOnly ? "只读" : "可执行操作"} · {tool.enabled ? "已启用" : tool.disabledReason || "不可用"}</span></li>)}</ul> : <p>没有公开的工具摘要。</p>}
        </>}
        {target.kind === "mcp" && <><dl><dt>状态</dt><dd>{target.server.status}</dd><dt>认证</dt><dd>{target.server.authStatus}</dd>
          <dt>来源</dt><dd>{target.server.pluginId || target.server.httpOrigin || "当前会话配置"}</dd>
          <dt>服务版本</dt><dd>{target.server.serverInfo?.version || "未提供"}</dd></dl>
          {target.server.toolsError && <p role="alert">工具列表：{target.server.toolsError}</p>}
          <h4>工具</h4>{target.server.tools.length ? <ul>{target.server.tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong><span>{tool.description}</span></li>)}</ul> : <p>没有可用工具。</p>}
          <h4>资源</h4>{target.server.resources.length ? <ul>{target.server.resources.map(resource => <li key={resource.uri}>
            <button type="button" disabled={itemLoading} onClick={() => void readResource(resource.uri)}>{resource.name}</button>
            <span>{resource.description || resource.uri}{resource.mimeType ? ` · ${resource.mimeType}` : ""}</span></li>)}</ul> : <p>没有可列出的资源。</p>}
          {target.server.resourceTemplates.length > 0 && <><h4>资源模板</h4><ul>{target.server.resourceTemplates.map(template =>
            <li key={template.uriTemplate}><strong>{template.name}</strong><span>{template.uriTemplate}</span></li>)}</ul></>}
        </>}
        {selectedSkill && <h4>{selectedSkill} 正文</h4>}{selectedResource && <h4>{selectedResource} 内容</h4>}
        {itemLoading && <p>正在读取…</p>}{itemError && <p role="alert">读取失败：{itemError}</p>}
        {skillContent && <pre>{skillContent}{skillTruncated ? "\n\n（只显示前 64 KiB）" : ""}</pre>}
        {resourceContent && (resourceContent.contents.length ? resourceContent.contents.map((content, index) =>
          <div key={`${content.uri}-${index}`}><small>{content.uri} · {content.mimeType || "未知类型"}</small>
            <pre>{content.binary ? "二进制资源，当前仅显示类型与 URI。" : content.text || "（空内容）"}{content.truncated ? "\n\n（只显示前 64 KiB）" : ""}</pre></div>) : <p>资源没有返回内容。</p>)}
        {resourceContent?.truncated && <p>只显示前 20 项资源内容。</p>}
      </div>
    </section>
  </div>;
}
