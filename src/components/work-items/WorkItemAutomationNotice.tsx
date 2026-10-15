import { useEffect, useState } from "react";
import type { WorkItemAutomationError } from "../../vite-env";

export function WorkItemAutomationNotice({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [errors, setErrors] = useState<WorkItemAutomationError[]>([]);
  useEffect(() => window.workItemApi?.onAutomationError?.(value => setErrors(current => [...current.slice(-19), value])), []);
  if (!errors.length) return null;
  return <aside className="work-items-automation-notice" role="alert" aria-label="自动任务错误提醒">
    {errors.map((value, index) => <div key={index}><strong>自动任务出错：{value.taskName}</strong>{value.sessionName && <p>会话：{value.sessionName}</p>}<p>{value.error}</p>{value.sessionId && <button type="button" onClick={() => onOpenSession(value.sessionId!)}>查看会话</button>}<button type="button" onClick={() => setErrors(current => current.filter((_, i) => i !== index))}>知道了</button></div>)}
  </aside>;
}
