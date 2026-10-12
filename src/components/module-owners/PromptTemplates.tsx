import { useEffect, useState } from "react";
import { OwnerDialog } from "./OwnerDialog";
import type { ModuleOwnerPromptTemplate, ModuleOwnerPromptPublish } from "../../vite-env";

function PromptDifference({ before, after }: { before: string; after: string }) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  const content = (value: string, label: string) => <pre>{value.slice(0, start)}{value.length - end > start && <mark aria-label={label}>{value.slice(start, value.length - end)}</mark>}{end > 0 && value.slice(value.length - end)}</pre>;
  return <div className="module-owners-prompt-diff"><section><strong>当前任务提示词</strong>{content(before, "将被替换的内容")}</section><section><strong>发布后提示词</strong>{content(after, "更新内容")}</section></div>;
}

export function PromptTemplates({ onClose }: { onClose: () => void }) {
  const [templates, setTemplates] = useState<ModuleOwnerPromptTemplate[]>([]);
  const [draft, setDraft] = useState<{ id?: string; version?: number; name: string; prompt: string } | null>(null);
  const [preview, setPreview] = useState<ModuleOwnerPromptPublish | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<ModuleOwnerPromptTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const key = (task: { templateId: string; taskId: string }) => JSON.stringify([task.templateId, task.taskId]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  useEffect(() => { let live = true; void window.moduleOwnerApi.listPromptTemplates().then(value => { if (live) setTemplates(value); }).catch(err => { if (live) setError(String(err)); }); return () => { live = false; }; }, []);
  function openPreview(source: ModuleOwnerPromptTemplate) {
    void run(async () => {
      const value = await window.moduleOwnerApi.previewPromptPublish({ id: source.id, version: source.version });
      setPreview(value); setSelected(value.tasks.filter(task => task.needsUpdate && !task.modified).map(key));
    });
  }
  return <OwnerDialog title="提示词模板" busy={busy} onClose={onClose} wide>
    <div className="module-owners-dialog-body module-owners-prompt-list">
      <p className="module-owners-prompt-hint">全局共享；保存模板后，通过发布更新所选自动任务。</p>
      {error && !draft && !preview && !deleting && <p role="alert" className="module-owners-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="module-owners-prompt-toolbar"><button type="button" disabled={busy} onClick={() => { setError(""); setDraft({ name: "", prompt: "" }); }}>新增提示词模板</button><button type="button" disabled={busy} onClick={() => void run(async () => { setTemplates(await window.moduleOwnerApi.listPromptTemplates()); })}>刷新模板列表</button></div>
      <div className="module-owners-prompt-scroll">
        <table className="module-owners-prompt-table" aria-label="提示词模板列表">
          <colgroup><col /><col className="module-owners-prompt-version-column" /><col className="module-owners-prompt-count-column" /><col className="module-owners-prompt-actions-column" /></colgroup>
          <thead><tr><th scope="col">模板名称</th><th scope="col">版本</th><th scope="col">引用数量</th><th scope="col">操作</th></tr></thead>
          <tbody>{templates.map(source => <tr key={source.id}>
            <td><strong>{source.name}</strong></td><td>{source.version}</td><td>{source.referenceCount} 个引用</td>
            <td><div className="module-owners-prompt-actions">
              <button type="button" disabled={busy} onClick={() => { setError(""); setDraft({ id: source.id, version: source.version, name: source.name, prompt: source.prompt }); }}>编辑模板</button>
              <button type="button" disabled={busy} onClick={() => openPreview(source)}>一键发布</button>
              <button type="button" className="module-owners-danger" disabled={busy || source.referenceCount > 0} title={source.referenceCount ? "请先解除任务引用" : "删除模板"} onClick={() => { setError(""); setDeleting(source); }}>删除模板</button>
            </div></td>
          </tr>)}</tbody>
        </table>
        {!templates.length && <p className="module-owners-empty">暂无提示词模板。</p>}
      </div>
    </div>
    <footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={onClose}>关闭</button></footer>
    {draft && <OwnerDialog title={draft.id ? "编辑提示词模板" : "新增提示词模板"} busy={busy} onClose={() => { setDraft(null); setError(""); }}>
      <form className="module-owners-prompt-editor" onSubmit={event => { event.preventDefault(); void run(async () => { setTemplates(await window.moduleOwnerApi.savePromptTemplate(draft)); setDraft(null); setNotice("模板已保存，引用任务尚未更新。"); }); }}>
        <div className="module-owners-dialog-body module-owners-form">
          {error && <p role="alert" className="module-owners-error">{error}</p>}
          <label>模板名称<input required maxLength={200} disabled={busy} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>模板提示词<textarea required rows={14} maxLength={100000} disabled={busy} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>
        </div>
        <footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={() => { setDraft(null); setError(""); }}>取消编辑</button><button type="submit" disabled={busy}>保存模板</button></footer>
      </form>
    </OwnerDialog>}
    {deleting && <OwnerDialog title="删除提示词模板" busy={busy} onClose={() => { setDeleting(null); setError(""); }}>
      <div className="module-owners-dialog-body">
        {error && <p role="alert" className="module-owners-error">{error}</p>}
        <p>确认删除“{deleting.name}”？</p>
      </div>
      <footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={() => { setDeleting(null); setError(""); }}>取消删除</button><button type="button" className="module-owners-danger" disabled={busy} onClick={() => void run(async () => { setTemplates(await window.moduleOwnerApi.deletePromptTemplate({ id: deleting.id, version: deleting.version })); setDeleting(null); setNotice("模板已删除。"); })}>确认删除模板</button></footer>
    </OwnerDialog>}
    {preview && <OwnerDialog title="发布提示词模板" busy={busy} onClose={() => { setPreview(null); setError(""); }} wide>
      <section className="module-owners-dialog-body module-owners-form" aria-label="发布预览">
        {error && <p role="alert" className="module-owners-error">{error}</p>}
        <h3>{preview.source.name} · 发布版本 {preview.source.version}</h3>
        <p>独立修改的任务默认不选；勾选后将覆盖该任务的独立修改。</p>
        <button type="button" disabled={busy} onClick={() => void run(async () => { const values = await window.moduleOwnerApi.listPromptTemplates(); setTemplates(values); const source = values.find(value => value.id === preview.source.id); if (!source) throw new Error("模板已删除。"); const value = await window.moduleOwnerApi.previewPromptPublish({ id: source.id, version: source.version }); setPreview(value); setSelected(value.tasks.filter(task => task.needsUpdate && !task.modified).map(key)); })}>刷新发布预览</button>
        {!preview.tasks.length && <p>暂无引用任务。</p>}
        {preview.tasks.map(task => <div key={key(task)} className="module-owners-prompt-row">
          <label className="module-owners-check"><input type="checkbox" disabled={busy || !task.needsUpdate} checked={selected.includes(key(task))} onChange={event => setSelected(event.target.checked ? [...selected, key(task)] : selected.filter(value => value !== key(task)))} />{task.templateTitle} / {task.ownerName} / {task.taskName}</label>
          <span>{task.modified ? "已独立修改，覆盖将丢失修改" : task.needsUpdate ? "模板有更新" : "已同步"}</span>
          <details><summary>查看提示词差异</summary><PromptDifference before={task.prompt} after={preview.source.prompt} /></details>
        </div>)}
      </section>
      <footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={() => { setPreview(null); setError(""); }}>取消发布</button><button type="button" disabled={busy || !selected.length} onClick={() => void run(async () => { const result = await window.moduleOwnerApi.publishPromptTemplate({ id: preview.source.id, version: preview.source.version, targets: preview.tasks.filter(task => selected.includes(key(task))).map(task => ({ templateId: task.templateId, taskId: task.taskId, fingerprint: task.fingerprint })) }); setPreview(null); setTemplates(await window.moduleOwnerApi.listPromptTemplates()); setNotice(`已更新 ${result.updatedCount} 个自动任务。`); })}>发布到选中任务（{selected.length}）</button>
      </footer>
    </OwnerDialog>}
  </OwnerDialog>;
}
