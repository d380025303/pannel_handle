import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useI18n } from "../i18n";
import type { AgentProvider, ListenerAgent, ListenerAgentRun, ListenerAgentState, ListenerAgentTrigger, ListenerTriggerEvent, TerminalSession } from "../vite-env";

type Props = { session: TerminalSession };

function MarkdownBlock({ content, className }: { content: string; className?: string }) {
  if (!content || content === "-") {
    return <div className={className}>{content || "-"}</div>;
  }
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

const uid = () => crypto.randomUUID();
const newTrigger = (): ListenerAgentTrigger => ({
  id: uid(), name: "文件变化", type: "file", enabled: true,
  prompt: "请检查以下文件变化并给出简洁结论：\n{{changedFiles}}",
  include: ["**/*"], exclude: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/release/**"],
  events: ["add", "change", "unlink"], debounceMs: 1000
});
const newAgent = (): ListenerAgent => ({
  id: uid(), name: "监听 Agent", provider: "codex", enabled: true,
  permission: "read-only", timeoutMinutes: 30, ignoreOwnChanges: true,
  triggers: [newTrigger()]
});

export function ListenerAgentPanel({ session }: Props) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const text = useMemo(() => zh ? {
    title: "监听 Agent", dormant: "对应会话运行时自动监听", add: "新增 Agent", empty: "尚未配置监听 Agent。",
    active: "运行中", inactive: "未运行", edit: "编辑", remove: "删除", run: "立即运行", cancel: "取消运行",
    history: "运行历史", clear: "清空历史", noHistory: "暂无运行记录", save: "保存", close: "关闭", name: "名称",
    cli: "CLI", permission: "权限", read: "只读", write: "可写", timeout: "超时（分钟）", enabled: "启用",
    own: "忽略自身运行造成的文件变化", triggers: "触发器", addTrigger: "添加触发器", type: "类型", file: "文件变化",
    interval: "固定间隔", cron: "Cron", prompt: "提示词", include: "包含 Glob（每行一个）", exclude: "排除 Glob（每行一个）",
    minutes: "间隔分钟数", cronExpr: "5 段 Cron", details: "查看结果", stdout: "标准输出", stderr: "错误输出",
    failed: "操作失败", selectCli: "-- 选择 CLI 配置 --",
    noCliTemplate: "提示：请先在会话库中为模板设置 Agent CLI。"
  } : {
    title: "Listener Agents", dormant: "Runs while the matching session is open", add: "Add agent", empty: "No listener agents configured.",
    active: "Active", inactive: "Inactive", edit: "Edit", remove: "Delete", run: "Run now", cancel: "Cancel",
    history: "Run history", clear: "Clear history", noHistory: "No runs yet", save: "Save", close: "Close", name: "Name",
    cli: "CLI", permission: "Permission", read: "Read only", write: "Workspace write", timeout: "Timeout (minutes)", enabled: "Enabled",
    own: "Ignore file changes caused by this agent", triggers: "Triggers", addTrigger: "Add trigger", type: "Type", file: "File changes",
    interval: "Interval", cron: "Cron", prompt: "Prompt", include: "Include globs (one per line)", exclude: "Exclude globs (one per line)",
    minutes: "Interval minutes", cronExpr: "5-field cron", details: "View result", stdout: "stdout", stderr: "stderr",
    failed: "Operation failed", selectCli: "-- Select CLI config --",
    noCliTemplate: "Tip: Set Agent CLI for a template in the session library first."
  }, [zh]);
  const templateId = session.templateId || session.id;
  const [state, setState] = useState<ListenerAgentState | null>(null);
  const [editing, setEditing] = useState<ListenerAgent | null>(null);
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const [history, setHistory] = useState<ListenerAgentRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<ListenerAgentRun | null>(null);
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>( {} );
  const [error, setError] = useState("");
  const [latestStdout, setLatestStdout] = useState<Record<string, string>>({});
  const [cliTemplates, setCliTemplates] = useState<TerminalSession[]>([]);
  const prevRunningRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    setState(null); setHistoryAgentId(null); setSelectedRun(null); setLiveOutput({}); setLatestStdout({});
    prevRunningRef.current = {};
    window.listenerAgentApi.getState(templateId).then(setState).catch(err => setError(String(err)));
    const removeChanged = window.listenerAgentApi.onChanged(next => { if (next.templateId === templateId) setState(next); });
    const removeOutput = window.listenerAgentApi.onOutput(payload => {
      if (payload.templateId !== templateId) return;
      setLiveOutput(current => ({ ...current, [payload.agentId]: `${current[payload.agentId] || ""}${payload.chunk}`.slice(-20000) }));
    });
    return () => { removeChanged(); removeOutput(); };
  }, [templateId]);

  useEffect(() => {
    window.terminalApi.loadSavedSessions()
      .then(sessions => setCliTemplates(sessions.filter(s => s.agentProvider)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!historyAgentId || state?.agents.find(agent => agent.id === historyAgentId)?.running) return;
    window.listenerAgentApi.history(templateId, historyAgentId).then(setHistory).catch(() => {});
  }, [historyAgentId, state, templateId]);

  useEffect(() => {
    if (!state) return;
    const prevRunning = prevRunningRef.current;
    const toFetch: string[] = [];
    for (const agent of state.agents) {
      if (!agent.running) {
        const wasRunning = prevRunning[agent.id] === true;
        const firstSeen = prevRunning[agent.id] === undefined;
        if (wasRunning || firstSeen) toFetch.push(agent.id);
      }
    }
    for (const agentId of toFetch) {
      window.listenerAgentApi.history(templateId, agentId)
        .then(runs => {
          if (runs.length > 0) {
            const stdout = runs[0].stdout;
            setLatestStdout(prev => ({ ...prev, [agentId]: stdout.length > 5000 ? stdout.slice(-5000) : stdout }));
          }
        })
        .catch(() => {});
    }
    prevRunningRef.current = Object.fromEntries(state.agents.map(a => [a.id, !!a.running]));
  }, [state, templateId]);

  useEffect(() => {
    if (!editing) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditing(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editing]);

  async function act(task: () => Promise<ListenerAgentState>) {
    try {
      setError("");
      setState(await task());
      return true;
    } catch (err) {
      setError(`${text.failed}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async function openHistory(agentId: string) {
    setHistoryAgentId(agentId); setSelectedRun(null);
    try { setHistory(await window.listenerAgentApi.history(templateId, agentId)); } catch (err) { setError(String(err)); }
  }

  const updateTrigger = (index: number, updates: Partial<ListenerAgentTrigger>) => {
    if (!editing) return;
    setEditing({ ...editing, triggers: editing.triggers.map((trigger, i) => i === index ? { ...trigger, ...updates } : trigger) });
  };

  return <section className="listener-agent-panel">
    <header className="listener-agent-header">
      <div><h2>{text.title}</h2><small>{state?.active ? text.active : text.dormant}</small></div>
      <button type="button" className="secondary-button" onClick={() => { setError(""); setEditing(newAgent()); }}>{text.add}</button>
    </header>
    {error && <div className="listener-agent-error">{error}</div>}
    {!state ? <div className="listener-agent-empty">…</div> : state.agents.length === 0 ? <div className="listener-agent-empty">{text.empty}</div> :
      <div className="listener-agent-list">{state.agents.map(agent => <article className="listener-agent-card" key={agent.id}>
        <div className="listener-agent-card-title"><strong>{agent.name}</strong><span>{agent.provider}</span><span className={agent.running ? "running" : ""}>{agent.running ? text.active : text.inactive}</span></div>
        <div className="listener-agent-actions">
          <button type="button" onClick={() => { setError(""); setEditing(structuredClone(agent)); }}>{text.edit}</button>
          <button type="button" onClick={() => openHistory(agent.id)}>{text.history}</button>
          <button type="button" onClick={() => act(async () => {
            const triggers = agent.triggers.filter(t => t.enabled);
            if (triggers.length === 0) return state!;
            let result: ListenerAgentState = state!;
            for (const t of triggers) result = await window.listenerAgentApi.run(templateId, agent.id, t.id);
            return result;
          })}>{text.run}</button>
          {agent.running ? <button type="button" onClick={() => act(() => window.listenerAgentApi.cancel(templateId, agent.id))}>{text.cancel}</button> : null}
          <button type="button" className="danger" onClick={() => window.confirm(`${text.remove} ${agent.name}?`) && act(() => window.listenerAgentApi.delete(templateId, agent.id))}>{text.remove}</button>
        </div>
        {agent.running
              ? (liveOutput[agent.id] && <MarkdownBlock className="listener-live-output" content={liveOutput[agent.id]} />)
              : (latestStdout[agent.id] && <MarkdownBlock className="listener-live-output" content={latestStdout[agent.id]} />)}
      </article>)}</div>}

    {editing && createPortal(<div className="modal-overlay" onMouseDown={() => setEditing(null)}>
      <div className="modal-dialog listener-agent-dialog" role="dialog" aria-modal="true" aria-label={text.title} onMouseDown={event => event.stopPropagation()}>
        <div className="modal-header">
          <h3>{text.title}</h3>
        </div>
        <div className="modal-body listener-agent-modal-body">
          {error && <div className="modal-error">{error}</div>}
          <label className="modal-field">
            <span className="modal-label">{text.name}</span>
            <input autoFocus className="modal-input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />
          </label>
          <div className="modal-grid listener-agent-settings-grid">
            <label className="modal-field">
              <span className="modal-label">{text.cli}</span>
              <select className="modal-input" value={editing.provider} onChange={e => setEditing({ ...editing, provider: e.target.value as AgentProvider })}><option value="claude">Claude</option><option value="codex">Codex</option><option value="opencode">OpenCode</option><option value="qoder">Qoder</option></select>
            </label>
            <label className="modal-field">
              <span className="modal-label">{text.permission}</span>
              <select className="modal-input" value={editing.permission} onChange={e => setEditing({ ...editing, permission: e.target.value as ListenerAgent["permission"] })}><option value="read-only">{text.read}</option><option value="write">{text.write}</option></select>
            </label>
            <label className="modal-field">
              <span className="modal-label">{text.timeout}</span>
              <input className="modal-input" type="number" min="1" max="120" value={editing.timeoutMinutes} onChange={e => setEditing({ ...editing, timeoutMinutes: Number(e.target.value) })} />
            </label>
          </div>
          <div className="listener-agent-option-row">
            <label className="modal-checkbox-field"><input type="checkbox" checked={editing.enabled} onChange={e => setEditing({ ...editing, enabled: e.target.checked })} /><span>{text.enabled}</span></label>
            <label className="modal-checkbox-field"><input type="checkbox" checked={editing.ignoreOwnChanges} onChange={e => setEditing({ ...editing, ignoreOwnChanges: e.target.checked })} /><span>{text.own}</span></label>
          </div>
          <div className="listener-agent-section-header"><span className="modal-label">{text.triggers}</span><button className="listener-agent-add-trigger-btn" type="button" onClick={() => setEditing({ ...editing, triggers: [...editing.triggers, newTrigger()] })}>{text.addTrigger}</button></div>
          {editing.triggers.map((trigger, index) => <fieldset className="listener-trigger-editor" key={trigger.id}>
            <button className="mini-action danger listener-trigger-remove" type="button" onClick={() => setEditing({ ...editing, triggers: editing.triggers.filter((_, i) => i !== index) })}>×</button>
            <label className="modal-checkbox-field"><input type="checkbox" checked={trigger.enabled} onChange={e => updateTrigger(index, { enabled: e.target.checked })} /><span>{text.enabled}</span></label>
            <div className="modal-grid two">
              <label className="modal-field"><span className="modal-label">{text.name}</span><input className="modal-input" value={trigger.name} onChange={e => updateTrigger(index, { name: e.target.value })} /></label>
              <label className="modal-field"><span className="modal-label">{text.type}</span><select className="modal-input" value={trigger.type} onChange={e => {
                const type = e.target.value as ListenerAgentTrigger["type"];
                updateTrigger(index, type === "file" ? { type, include: ["**/*"], exclude: ["**/.git/**", "**/node_modules/**"], events: ["add", "change", "unlink"] } : type === "interval" ? { type, intervalMinutes: 30 } : { type, cron: "0 * * * *" });
              }}><option value="file">{text.file}</option><option value="interval">{text.interval}</option><option value="cron">{text.cron}</option></select></label>
            </div>
            {trigger.type === "file" && <><label className="modal-field"><span className="modal-label">{text.include}</span><textarea className="modal-input modal-textarea listener-agent-pattern-input" rows={2} value={(trigger.include || []).join("\n")} onChange={e => updateTrigger(index, { include: e.target.value.split("\n") })} /></label><label className="modal-field"><span className="modal-label">{text.exclude}</span><textarea className="modal-input modal-textarea listener-agent-pattern-input" rows={3} value={(trigger.exclude || []).join("\n")} onChange={e => updateTrigger(index, { exclude: e.target.value.split("\n") })} /></label><div className="listener-event-checks">{(["add", "change", "unlink"] as ListenerTriggerEvent[]).map(event => <label className="modal-checkbox-field" key={event}><input type="checkbox" checked={(trigger.events || []).includes(event)} onChange={e => updateTrigger(index, { events: e.target.checked ? [...(trigger.events || []), event] : (trigger.events || []).filter(item => item !== event) })} /><span>{event}</span></label>)}</div></>}
            {trigger.type === "interval" && <label className="modal-field"><span className="modal-label">{text.minutes}</span><input className="modal-input" type="number" min="1" value={trigger.intervalMinutes || 30} onChange={e => updateTrigger(index, { intervalMinutes: Number(e.target.value) })} /></label>}
            {trigger.type === "cron" && <label className="modal-field"><span className="modal-label">{text.cronExpr}</span><input className="modal-input" value={trigger.cron || "0 * * * *"} onChange={e => updateTrigger(index, { cron: e.target.value })} /></label>}
            <label className="modal-field"><span className="modal-label">{text.prompt}</span><textarea className="modal-input modal-textarea" rows={5} value={trigger.prompt} onChange={e => updateTrigger(index, { prompt: e.target.value })} /></label>
          </fieldset>)}
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" onClick={() => setEditing(null)}>{text.close}</button>
          <button className="modal-button primary" type="button" onClick={async () => { if (await act(() => window.listenerAgentApi.save(templateId, editing))) setEditing(null); }}>{text.save}</button>
        </div>
      </div>
    </div>, document.body)}

    {historyAgentId && <div className="listener-agent-editor">
      <div className="listener-agent-editor-bar"><strong>{text.history}</strong><div><button type="button" onClick={async () => { setHistory(await window.listenerAgentApi.clearHistory(templateId, historyAgentId)); setSelectedRun(null); }}>{text.clear}</button><button type="button" onClick={() => setHistoryAgentId(null)}>{text.close}</button></div></div>
      {history.length === 0 ? <div className="listener-agent-empty">{text.noHistory}</div> : history.map(run => <button type="button" className="listener-run-row" key={run.id} onClick={() => setSelectedRun(run)}><span>{run.triggerName}</span><span className={run.status}>{run.status}</span><time>{new Date(run.startedAt).toLocaleString()}</time></button>)}
      {selectedRun && <div className="listener-run-detail"><h3>{selectedRun.triggerName}</h3>
        <strong>{text.stdout}</strong>
        <MarkdownBlock className="listener-run-detail-output" content={selectedRun.stdout || "-"} />
        <strong>{text.stderr}</strong>
        <MarkdownBlock className="listener-run-detail-output" content={selectedRun.stderr || "-"} />
      </div>}
    </div>}
  </section>;
}
