import { useEffect, useRef, useState } from "react";
import type { WorkItemApi, WorkItemQuickPrompt, WorkItemQuickPromptMutation } from "../../vite-env";
import type { OwnerDialog } from "../module-owners/OwnerDialog";

export function WorkItemQuickPrompts({ api, disabled, onAppend, Dialog }: { api: WorkItemApi; disabled: boolean; onAppend: (text: string) => void; Dialog: typeof OwnerDialog }) {
  const [records, setRecords] = useState<WorkItemQuickPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [manage, setManage] = useState(false);
  const [draft, setDraft] = useState<Partial<WorkItemQuickPrompt> | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    let request = 0;
    async function load() {
      const current = ++request;
      setLoading(true);
      try {
        const values = await api.listQuickPrompts();
        if (live && current === request) { setRecords(values); setError(""); }
      } catch (err) { if (live && current === request) setError(String(err)); }
      finally { if (live && current === request) setLoading(false); }
    }
    void load();
    const off = api.onChanged(() => void load());
    return () => { live = false; off(); };
  }, [api, reload]);
  async function mutate(input: WorkItemQuickPromptMutation) {
    if (submitting.current || disabled) return;
    submitting.current = true; setBusy(true); setError("");
    try { setRecords(await api.mutateQuickPrompt(input)); setDraft(null); }
    catch (err) { setError(String(err)); }
    finally { submitting.current = false; setBusy(false); }
  }
  const locked = disabled || busy;
  return <>
    <section className="work-items-quick-prompts" aria-label="常用提示词">
      <strong>常用提示词</strong>
      {records.map(record => <button type="button" key={record.id} title={record.prompt} disabled={locked || loading} onClick={() => onAppend(record.prompt)}>{record.name}</button>)}
      <button type="button" disabled={locked} onClick={() => setManage(true)}>管理常用提示词</button>
      {loading && <span role="status">正在加载常用提示词…</span>}
      {!manage && error && <><p role="alert">{error}</p><button type="button" disabled={locked} onClick={() => setReload(value => value + 1)}>刷新常用提示词</button></>}
    </section>
    {manage && <Dialog title="管理常用提示词" busy={locked} onClose={() => { setManage(false); setDraft(null); }}>
      <div className="module-owners-dialog-body work-items-quick-manager">
        {error && <p role="alert">{error}</p>}
        <div className="work-items-quick-actions"><button type="button" disabled={locked} onClick={() => setDraft({ name: "", prompt: "" })}>新增常用提示词</button><button type="button" disabled={locked || loading} onClick={() => setReload(value => value + 1)}>刷新常用提示词</button></div>
        {!records.length && !loading && <p>暂无常用提示词。</p>}
        {records.map(record => <div className="work-items-quick-row" key={record.id}><span title={record.prompt}>{record.name}</span><button type="button" disabled={locked} onClick={() => setDraft({ ...record })}>编辑</button><button type="button" disabled={locked} onClick={() => void mutate({ operation: "delete", id: record.id, version: record.version })}>删除</button></div>)}
        {draft && <div className="work-items-quick-form">
          <label>按钮名称<input aria-label="按钮名称" maxLength={100} value={draft.name || ""} disabled={locked} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>常用提示词正文<textarea aria-label="常用提示词正文" rows={6} maxLength={100000} value={draft.prompt || ""} disabled={locked} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>
          <div className="work-items-quick-actions"><button type="button" disabled={locked || !draft.name?.trim() || !draft.prompt?.trim()} onClick={() => void mutate(draft.id ? { operation: "update", id: draft.id, version: draft.version!, name: draft.name!, prompt: draft.prompt! } : { operation: "add", name: draft.name!, prompt: draft.prompt! })}>保存常用提示词</button><button type="button" disabled={locked} onClick={() => setDraft(null)}>取消编辑</button></div>
        </div>}
      </div>
    </Dialog>}
  </>;
}
