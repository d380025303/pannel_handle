import { useEffect, useRef, useState } from "react";
import { OwnerDialog } from "./OwnerDialog";
import type { ModuleOwnerTask, ModuleOwnerTaskRun } from "../../vite-env";

const labels: Record<string, string> = { creating: "创建中", running: "运行中", uncertain: "结果待确认", completed: "已完成", failed: "失败", stopped: "已中断" };
export function TaskRunHistory({ templateId, task, onClose }: { templateId: string; task: ModuleOwnerTask; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ records: Omit<ModuleOwnerTaskRun, "input" | "output">[]; total: number }>({ records: [], total: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModuleOwnerTaskRun | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const queryVersion = useRef(0);
  const deletingNow = useRef(false);
  async function remove(id: string) {
    if (deletingNow.current) return;
    deletingNow.current = true; queryVersion.current++;
    setBusy(true); setError("");
    try {
      await window.moduleOwnerApi.deleteTaskRun(templateId, { taskId: task.id, id });
      setDeleting(null);
      if (selected === id) { setSelected(null); setDetail(null); }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { deletingNow.current = false; setBusy(false); setRefresh(value => value + 1); }
  }
  useEffect(() => {
    let live = true;
    setLoading(true); setDetail(null);
    async function load() {
      if (deletingNow.current) return;
      const version = ++queryVersion.current;
      try {
        const value = await window.moduleOwnerApi.listTaskRuns(templateId, { taskId: task.id, page });
        if (!live || version !== queryVersion.current) return;
        if (page > 0 && !value.records.length) { setPage(Math.max(0, Math.ceil(value.total / 20) - 1)); setSelected(null); return; }
        const record = selected ? await window.moduleOwnerApi.getTaskRun(templateId, { taskId: task.id, id: selected }) : null;
        if (live && version === queryVersion.current) { setResult(value); setDetail(record); }
      } catch (err) { if (live && version === queryVersion.current) setError(err instanceof Error ? err.message : String(err)); }
      finally { if (live && version === queryVersion.current) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [templateId, task.id, page, selected, refresh]);
  return <OwnerDialog title={`${task.name} · 调用历史`} busy={busy} wide onClose={onClose}>
    <div className="module-owners-dialog-body module-owners-form">
      {error && <p role="alert" className="module-owners-error">{error}</p>}
      {loading && <p role="status">加载中…</p>}
      {!loading && !error && !result.records.length && <p>暂无调用历史。仅开启“记录到历史记录”后的实际调用会保存。</p>}
      <div className="module-owners-table-scroll"><table><thead><tr><th>调用时间</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {result.records.map(record => <tr key={record.id}><td>{new Date(record.calledAt).toLocaleString()}</td><td>{labels[record.status] || record.status}</td><td><div className="module-owners-buttons">
          <button type="button" disabled={busy} onClick={() => setSelected(record.id)}>查看详情</button>
          {deleting === record.id ? <><span>确认删除此调用记录？</span><button type="button" className="module-owners-danger" disabled={busy} onClick={() => void remove(record.id)}>确认删除记录</button><button type="button" disabled={busy} onClick={() => setDeleting(null)}>取消</button></> :
            <button type="button" className="module-owners-danger" disabled={busy || !["completed", "failed", "stopped"].includes(record.status)} title={!["completed", "failed", "stopped"].includes(record.status) ? "调用尚未结束，不能删除历史记录" : "删除此调用记录"} onClick={() => setDeleting(record.id)}>删除</button>}
        </div></td></tr>)}
      </tbody></table></div>
      <div className="module-owners-buttons"><button type="button" disabled={page === 0 || loading || busy} onClick={() => { setPage(page - 1); setSelected(null); }}>上一页</button><span>第 {page + 1} 页 · 共 {result.total} 条</span><button type="button" disabled={(page + 1) * 20 >= result.total || loading || busy} onClick={() => { setPage(page + 1); setSelected(null); }}>下一页</button></div>
      {detail && <section className="module-owners-run-detail">
        <h3>调用详情</h3><p>{detail.taskName} · {new Date(detail.calledAt).toLocaleString()} · {labels[detail.status] || detail.status}</p>
        {detail.endedAt && <p>结束时间：{new Date(detail.endedAt).toLocaleString()}</p>}
        {detail.error && <p role="alert" className="module-owners-error">{detail.error}</p>}
        <h4>输入</h4><pre>{JSON.stringify(detail.input, null, 2)}</pre>
        <h4>最终回复</h4><pre>{detail.output || (["creating", "running", "uncertain"].includes(detail.status) ? "等待最终回复…" : "无最终回复")}</pre>
      </section>}
    </div>
    <footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={onClose}>关闭</button></footer>
  </OwnerDialog>;
}
