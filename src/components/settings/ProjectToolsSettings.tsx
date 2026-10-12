import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { ProjectTool } from "../../vite-env";
import "./project-tools.css";

export function ProjectToolsSettings() {
  const { locale } = useI18n();
  const lang = locale === "en-US" ? "en-US" : "zh-CN";
  const label = (zh: string, en: string) => lang === "en-US" ? en : zh;
  const [tools, setTools] = useState<ProjectTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProjectTool | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => window.projectToolsApi.list()).then(value => { if (active) setTools(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (selected) closeButton.current?.focus(); }, [selected]);
  const close = () => { setSelected(null); trigger.current?.focus(); };
  const filtered = tools.filter(tool => `${tool.name} ${tool.summary[lang]} ${tool.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = { owners: label("模块负责人", "Module owners"), sessions: label("会话管理", "Session management"), remote: label("SSH 远程操作", "SSH remote operations") };
  const schema = selected?.inputSchema;
  const properties = (schema?.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (schema?.required || []) as string[];
  return <div className="project-tools">
    <p className="settings-help">{label("目录展示项目支持的工具，具体会话是否可用取决于环境、注入和授权。", "This catalog lists supported tools. Session availability depends on environment, injection and authorization.")}</p>
    <label className="project-tools-search"><span className="modal-label">{label("搜索工具", "Search tools")}</span><input className="modal-input" type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {loading && <p className="settings-help project-tools-status" role="status">{label("正在加载工具…", "Loading tools…")}</p>}
    {error && <p className="settings-result error" role="alert">{label("无法加载工具目录，请完整重启应用后重试：", "Unable to load tools. Restart the application and retry: ")}{error}</p>}
    {!loading && !error && !filtered.length && <p className="settings-help project-tools-status" role="status">{label("没有匹配的工具", "No matching tools")}</p>}
    {(Object.keys(groups) as Array<keyof typeof groups>).map(group => {
      const items = filtered.filter(tool => tool.group === group);
      return items.length > 0 && <section className="settings-section project-tools-group" key={group}><h4>{groups[group]} <span className="project-tools-count">{items.length}</span></h4>
        {items.map(tool => <div className="project-tools-row" key={tool.name}><div><code>{tool.name}</code><p>{tool.summary[lang]}</p></div>
          <span className="project-tools-access" data-read-only={tool.readOnly}>{tool.readOnly ? label("只读", "Read only") : label("写入 / 执行", "Write / execute")}</span>
          <button className="modal-button compact" type="button" aria-label={`${label("详情", "Details")} ${tool.name}`} onClick={event => { trigger.current = event.currentTarget; setSelected(tool); }}>{label("详情", "Details")}</button>
        </div>)}
      </section>;
    })}
    {selected && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal-dialog project-tools-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "Tab") {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, [tabindex="0"]'));
          if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
        }
      }}>
        <div className="project-tools-header"><h2 id={titleId}>{selected.name}</h2><button className="icon-button" type="button" ref={closeButton} aria-label={label("关闭详情", "Close details")} onClick={close}><X aria-hidden="true" /></button></div>
        <div className="project-tools-detail" tabIndex={0}>
          <h3>{label("用途", "Purpose")}</h3><p>{selected.summary[lang]} · {selected.readOnly ? label("只读", "Read only") : label("写入 / 执行", "Write / execute")}</p><p>{selected.description}</p>
          <h3>{label("调用入口与使用条件", "Access and requirements")}</h3><p>{selected.conditions[lang]}</p>
          <h3>{label("参数", "Parameters")}</h3>
          {Object.keys(properties).length ? <dl>{Object.entries(properties).map(([name, property]) => <div key={name}><dt><code>{name}</code> · {required.includes(name) ? label("必填", "Required") : label("可选", "Optional")}</dt><dd>{String(Array.isArray(property.type) ? property.type.join(" | ") : property.type || "object")}{property.description ? ` — ${property.description}` : ""}</dd></div>)}</dl> : <p>{label("无参数", "No parameters")}</p>}
          <h3>JSON Schema</h3><pre>{JSON.stringify(schema, null, 2)}</pre>
          <h3>{label("调用参数示例", "Example arguments")}</h3><pre>{JSON.stringify(selected.example, null, 2)}</pre>
          <h3>{label("返回说明与限制", "Results and limitations")}</h3><p>{selected.result[lang]}</p>
          <h3>{label("返回数据示例", "Example result")}</h3>
          <p>{label("以下为示意数据，展示工具返回的数据内容（不含传输层包装）。实际 ID、版本和状态以调用结果为准。", "Illustrative tool result data without transport wrappers. Actual IDs, versions and status depend on the call.")}</p>
          <pre>{JSON.stringify(selected.resultExample, null, 2)}</pre>
        </div>
      </div>
    </div>}
  </div>;
}
