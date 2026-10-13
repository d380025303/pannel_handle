import { useEffect, useRef, useState } from "react";
import type { WorkItemApi, WorkItem } from "../../vite-env";

export const BATCH_ACTIONS = { markCompleted: "标记完成", void: "作废", restore: "恢复", followUp: "标记需要后续处理", noFollowUp: "标记不需要后续处理" };
export type BatchOperation = keyof typeof BATCH_ACTIONS;
type Entry = { id: string; name: string; item?: WorkItem; state: "ready" | "skipped" | "failed" | "success"; reason: string };
export function batchSkip(item: WorkItem, operation: BatchOperation) {
  if (operation === "markCompleted" && !["pending", "failed", "stopped"].includes(item.status)) return "仅待执行、失败或中断任务可以标记完成";
  if (operation === "void" && ["creating", "running", "uncertain", "void"].includes(item.status)) return "活动、待核对或已作废任务不能作废";
  if (operation === "restore" && item.status !== "void") return "仅已作废任务可以恢复";
  if ((operation === "followUp" || operation === "noFollowUp") && item.needsFollowUp === (operation === "followUp")) return "已符合目标值";
  return "";
}
export function useWorkItemBatch(api: WorkItemApi, refresh: () => void) {
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [operation, setOperation] = useState<BatchOperation | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  function clear() { if (!lock.current) setSelected(new Map()); }
  function toggle(records: Pick<WorkItem, "id" | "taskName">[], checked: boolean) {
    if (lock.current || operation) return;
    setSelected(previous => { const next = new Map(previous); records.forEach(item => { if (checked) next.set(item.id, item.taskName); else next.delete(item.id); }); return next; });
  }
  async function open(action: BatchOperation) {
    if (lock.current || !selected.size) return;
    lock.current = true; setBusy(true); setDone(false); setReason(""); setOperation(action); setEntries([]);
    const token = ++generation.current;
    const targets = [...selected];
    const result: Entry[] = [];
    for (const [id, name] of targets) {
      try {
        const item = await api.get({ id });
        const skipped = batchSkip(item, action);
        result.push({ id, name: item.taskName, item, state: skipped ? "skipped" : "ready", reason: skipped });
      } catch (error) { result.push({ id, name, state: "failed", reason: String(error) }); }
      if (token !== generation.current) return;
      setEntries([...result]);
    }
    lock.current = false; setBusy(false);
  }
  async function submit() {
    if (lock.current || !operation || done) return;
    lock.current = true; setBusy(true);
    const token = generation.current;
    const result = entries.map(entry => ({ ...entry }));
    const succeeded: string[] = [];
    for (const entry of result) {
      if (entry.state !== "ready" || !entry.item) continue;
      const identity = { id: entry.id, version: entry.item.version };
      try {
        if (operation === "followUp" || operation === "noFollowUp") await api.setFollowUp({ ...identity, needsFollowUp: operation === "followUp" });
        else if (operation === "void") await api.void({ ...identity, reason });
        else await api[operation](identity);
        entry.state = "success"; succeeded.push(entry.id);
      } catch (error) { entry.state = "failed"; entry.reason = String(error); }
      if (token !== generation.current) return;
      setEntries(result.map(value => ({ ...value })));
    }
    setSelected(previous => { const next = new Map(previous); succeeded.forEach(id => next.delete(id)); return next; });
    setDone(true); lock.current = false; setBusy(false); refresh();
  }
  function close() { if (!lock.current) { setOperation(null); setEntries([]); } }
  function reset() { generation.current++; lock.current = false; setBusy(false); setOperation(null); setEntries([]); setSelected(new Map()); }
  return { selected, clear, toggle, operation, entries, busy, done, reason, setReason, open, submit, close, reset };
}
