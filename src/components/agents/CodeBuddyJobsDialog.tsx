import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { CodeBuddyJob, CodeBuddyJobDispatch, CodeBuddyJobDispatchContext, CodeBuddyResumableJob, CodexAppServerSnapshot } from "../../vite-env";
import { MarkdownBlock } from "../shared/MarkdownBlock";

type Props = { sessionId: string; cwd: string; snapshot: CodexAppServerSnapshot; onClose: () => void };
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const sameCwd = (left: string, right: string) => left.replace(/\//g, "\\").toLowerCase() === right.replace(/\//g, "\\").toLowerCase();
const jobLabel = (job: CodeBuddyJob) => job.name || job.prompt?.slice(0, 80) || job.id;
const stateLabel = (job: CodeBuddyJob) => job.status === "waiting" ? "等待回复" : job.status === "busy" || job.tempo === "active" ? "执行中"
  : job.state === "done" ? "已完成" : job.state === "failed" ? "失败" : job.state === "stopped" ? "已停止" : job.state || job.status || "未知";
type Update = Record<string, unknown>;
function updateText(value: Update): { key: string; text: string; kind: string } | null {
  const update = (value.update && typeof value.update === "object" ? value.update : value) as Update;
  const kind = String(update.sessionUpdate || "");
  if (!["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(kind)) return null;
  if (kind.startsWith("tool_call")) {
    const content = Array.isArray(update.content) ? update.content.map(item => {
      const block = item as { text?: string; content?: { text?: string } };
      return block.text || block.content?.text || "";
    }).filter(Boolean).join("\n") : "";
    return { key: String(update.toolCallId || ""), kind: "tool", text: `${String(update.title || "工具调用")} · ${String(update.status || "")}${content ? `\n${content}` : ""}` };
  }
  const content = update.content as { text?: string } | undefined;
  if (!content?.text) return null;
  return { key: String(update.messageId || ""), kind: kind === "user_message_chunk" ? "user" : kind === "agent_thought_chunk" ? "thought" : "agent", text: content.text };
}

export function CodeBuddyJobsDialog({ sessionId, cwd, snapshot, onClose }: Props) {
  const [jobs, setJobs] = useState<CodeBuddyJob[]>([]);
  const [context, setContext] = useState<CodeBuddyJobDispatchContext | null>(null);
  const [resumable, setResumable] = useState<CodeBuddyResumableJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [permissionMode, setPermissionMode] = useState("");
  const [bgIsolation, setBgIsolation] = useState("");
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  async function refresh() {
    const [jobRows, dispatchContext] = await Promise.all([
      window.codexAppServerApi.listJobs(sessionId), window.codexAppServerApi.jobDispatchContext(sessionId)
    ]);
    setJobs(jobRows); setContext(dispatchContext);
  }
  async function refreshHistory() {
    setResumable(await window.codexAppServerApi.listResumableJobs(sessionId));
  }
  useEffect(() => {
    let active = true;
    void refresh().catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    const offJobs = window.codexAppServerApi.onJobsEvent(event => {
      if (active && sameCwd(event.cwd, cwd)) void refresh().catch(cause => setError(errorText(cause)));
    });
    const offTranscript = window.codexAppServerApi.onJobTranscript(event => {
      if (!active || !sameCwd(event.cwd, cwd) || event.jobId !== selectedRef.current) return;
      if (event.reset) { setUpdates([]); return; }
      if (event.error) { setError(event.error); return; }
      if (event.event) setUpdates(previous => [...previous, event.event!].slice(-1000));
    });
    return () => { active = false; offJobs(); offTranscript(); };
  }, [sessionId, cwd]);
  useEffect(() => {
    if (!selected) { setUpdates([]); return; }
    setUpdates([]);
    void window.codexAppServerApi.watchJob(sessionId, selected).catch(cause => setError(errorText(cause)));
    return () => { void window.codexAppServerApi.unwatchJob(sessionId, selected).catch(() => {}); };
  }, [sessionId, selected]);
  async function run(label: string, operation: () => Promise<unknown>) {
    if (pending) return;
    setPending(label); setError("");
    try { await operation(); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setPending(""); }
  }
  const chosen = jobs.find(job => job.id === selected);
  const modelOptions = snapshot.acpOptions?.find(option => option.id === "model" && option.type === "select")?.options || [];
  const agents = context?.agents || [];
  const permissionOptions = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-dialog codebuddy-jobs-dialog" role="dialog" aria-modal="true" aria-label="CodeBuddy 后台智能体" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className="codex-app-server-history-header"><h2>后台智能体</h2><button type="button" aria-label="关闭后台智能体" onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="codebuddy-jobs-toolbar"><span>项目：{cwd}</span><div><button type="button" onClick={() => setSelected(null)}>派发新任务</button><button type="button" disabled={Boolean(pending)} onClick={() => void run("refresh", refresh)}><RefreshCw aria-hidden="true" />刷新</button></div></div>
      {error && <p role="alert" className="codex-app-server-history-error">{error}</p>}
      <div className="codebuddy-jobs-body">
        <section className="codebuddy-jobs-list" aria-label="后台智能体列表">
          {loading && <p>正在加载后台智能体…</p>}
          {!loading && jobs.length === 0 && <p>当前项目没有后台智能体。</p>}
          {jobs.map(job => <button key={job.id} type="button" className={selected === job.id ? "selected" : ""} onClick={() => setSelected(job.id)}>
            <strong>{jobLabel(job)}</strong><span>{stateLabel(job)} · {job.id}</span>
          </button>)}
        </section>
        <section className="codebuddy-jobs-detail" aria-label="后台智能体详情">
          {chosen ? <>
            <h3>{jobLabel(chosen)}</h3><p>{stateLabel(chosen)} · {chosen.alive ? "进程运行中" : "进程已退出"}</p>
            <div className="codebuddy-jobs-actions">
              {chosen.status === "waiting" && <form onSubmit={event => { event.preventDefault(); void run("reply", async () => { await window.codexAppServerApi.jobAction(sessionId, chosen.id, "reply", { text: reply }); setReply(""); }); }}>
                <input aria-label="回复后台智能体" value={reply} onChange={event => setReply(event.target.value)} /><button disabled={!reply.trim() || Boolean(pending)}>回复</button>
              </form>}
              {chosen.alive && <button disabled={Boolean(pending)} onClick={() => void run("stop", () => window.codexAppServerApi.jobAction(sessionId, chosen.id, "stop"))}>停止</button>}
              <button disabled={Boolean(pending)} onClick={() => void run("respawn", () => window.codexAppServerApi.jobAction(sessionId, chosen.id, "respawn"))}>重启</button>
              <button disabled={Boolean(pending)} onClick={() => { const value = window.prompt("后台智能体名称", chosen.name || ""); if (value?.trim()) void run("rename", () => window.codexAppServerApi.jobAction(sessionId, chosen.id, "rename", { name: value })); }}>重命名</button>
              <button disabled={Boolean(pending)} onClick={() => { if (window.confirm(`删除后台智能体“${jobLabel(chosen)}”？`)) void run("delete", async () => { await window.codexAppServerApi.jobAction(sessionId, chosen.id, "delete"); setSelected(null); }); }}>删除</button>
            </div>
            <div className="codebuddy-jobs-transcript" aria-label="后台智能体对话">
              {updates.length === 0 && <p>暂无对话输出。</p>}
              {updates.map((value, index) => {
                const message = updateText(value);
                return message && <div className={`codebuddy-jobs-message ${message.kind}`} key={`${message.key}:${index}`}><strong>{message.kind === "user" ? "用户" : message.kind === "tool" ? "工具" : message.kind === "thought" ? "思考" : "CodeBuddy"}</strong><MarkdownBlock content={message.text} /></div>;
              })}
            </div>
          </> : <>
            <h3>派发后台智能体</h3>
            <form className="codebuddy-jobs-form" onSubmit={event => {
              event.preventDefault();
              const input: CodeBuddyJobDispatch = { prompt, name: name || undefined, agent: agent || undefined, model: model || undefined,
                effort: effort as CodeBuddyJobDispatch["effort"] || undefined,
                permissionMode: permissionMode as CodeBuddyJobDispatch["permissionMode"] || undefined,
                bgIsolation: bgIsolation as CodeBuddyJobDispatch["bgIsolation"] || undefined };
              void run("dispatch", async () => { await window.codexAppServerApi.dispatchJob(sessionId, input); setPrompt(""); setName(""); });
            }}>
              <textarea aria-label="任务内容" placeholder="描述后台任务" value={prompt} onChange={event => setPrompt(event.target.value)} required />
              <input aria-label="实例名称" placeholder="名称（可选）" value={name} onChange={event => setName(event.target.value)} />
              <label>主 Agent <select value={agent} onChange={event => setAgent(event.target.value)}><option value="">默认：{context?.defaultAgentName || "CodeBuddy"}</option>{agents.map(item => {
                const id = item.name || item.id || ""; return id && <option key={id} value={id}>{id}</option>;
              })}</select></label>
              <label>模型 <select value={model} onChange={event => setModel(event.target.value)}><option value="">默认模型</option>{modelOptions.map(item => <option key={item.value} value={item.value}>{item.name || item.value}</option>)}</select></label>
              <label>思考强度 <select value={effort} onChange={event => setEffort(event.target.value)}><option value="">默认</option>{["minimal", "low", "medium", "high", "xhigh", "max"].map(value => <option key={value}>{value}</option>)}</select></label>
              <label>权限 <select value={permissionMode} onChange={event => setPermissionMode(event.target.value)}><option value="">默认：{context?.permissionMode || "default"}</option>{permissionOptions.map(value => <option key={value}>{value}</option>)}</select></label>
              <label>写入隔离 <select value={bgIsolation} onChange={event => setBgIsolation(event.target.value)}><option value="">跟随全局配置</option><option value="none">无</option><option value="worktree">独立 Worktree</option></select></label>
              <button type="submit" disabled={!prompt.trim() || Boolean(pending)}>派发</button>
            </form>
            <div className="codebuddy-jobs-history"><button disabled={Boolean(pending)} onClick={() => { setShowHistory(!showHistory); if (!showHistory) void refreshHistory().catch(cause => setError(errorText(cause))); }}>从历史恢复</button>
              {showHistory && resumable.map(item => <div key={item.sessionId}><span>{item.title || item.sessionId}</span><button disabled={Boolean(pending)} onClick={() => void run("resume", async () => { await window.codexAppServerApi.resumeJob(sessionId, item.sessionId); await refreshHistory(); })}>恢复为实例</button></div>)}
              {showHistory && resumable.length === 0 && <p>当前项目没有可恢复的历史对话。</p>}
            </div>
          </>}
        </section>
      </div>
    </div>
  </div>;
}
