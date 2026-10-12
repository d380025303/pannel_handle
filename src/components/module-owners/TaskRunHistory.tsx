import { useEffect, useState } from "react";
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
  useEffect(() => {
    let live = true;
    setLoading(true); setError(""); setDetail(null);
    async function load() {
      try {
        const value = await window.moduleOwnerApi.listTaskRuns(templateId, { taskId: task.id, page });
        const record = selected ? await window.moduleOwnerApi.getTaskRun(templateId, { taskId: task.id, id: selected }) : null;
        if (live) { setResult(value); setDetail(record); setError(""); }
      } catch (err) { if (live) setError(err instanceof Error ? err.message : String(err)); }
      finally { if (live) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [templateId, task.id, page, selected]);
  return <OwnerDialog title={`${task.name} · 调用历史`} busy={false} wide onClose={onClose}>
    <div className="module-owners-dialog-body module-owners-form">
      {error && <p role="alert" className="module-owners-error">{error}</p>}
      {loading && <p role="status">加载中…</p>}
      {!loading && !error && !result.records.length && <p>暂无调用历史。仅开启“记录到历史记录”后的实际调用会保存。</p>}
      <div className="module-owners-table-scroll"><table><thead><tr><th>调用时间</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {result.records.map(record => <tr key={record.id}><td>{new Date(record.calledAt).toLocaleString()}</td><td>{labels[record.status] || record.status}</td><td><button type="button" onClick={() => setSelected(record.id)}>查看详情</button></td></tr>)}
      </tbody></table></div>
      <div className="module-owners-buttons"><button type="button" disabled={page === 0 || loading} onClick={() => { setPage(page - 1); setSelected(null); }}>上一页</button><span>第 {page + 1} 页 · 共 {result.total} 条</span><button type="button" disabled={(page + 1) * 20 >= result.total || loading} onClick={() => { setPage(page + 1); setSelected(null); }}>下一页</button></div>
      {detail && <section className="module-owners-run-detail">
        <h3>调用详情</h3><p>{detail.taskName} · {new Date(detail.calledAt).toLocaleString()} · {labels[detail.status] || detail.status}</p>
        {detail.endedAt && <p>结束时间：{new Date(detail.endedAt).toLocaleString()}</p>}
        {detail.error && <p role="alert" className="module-owners-error">{detail.error}</p>}
        <h4>输入</h4><pre>{JSON.stringify(detail.input, null, 2)}</pre>
        <h4>最终回复</h4><pre>{detail.output || (["creating", "running", "uncertain"].includes(detail.status) ? "等待最终回复…" : "无最终回复")}</pre>
      </section>}
    </div>
    <footer className="module-owners-dialog-footer"><button type="button" onClick={onClose}>关闭</button></footer>
  </OwnerDialog>;
}
