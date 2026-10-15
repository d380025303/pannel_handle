import { useEffect, useState } from "react";
import type { WorkItemAutomationRule, WorkItemAutomationState, WorkItemCondition, WorkItemPage } from "../../vite-env";
import { OwnerDialog } from "../module-owners/OwnerDialog";

const fields = { templateId: "来源模板", ownerId: "负责人", taskName: "任务名称", output: "回复全文", needsFollowUp: "需后续处理" };
const operators = { equals: "等于", notEquals: "不等于", contains: "包含", notContains: "不包含" };
const leaf = (): WorkItemCondition => ({ kind: "condition", field: "output", operator: "contains", value: "" });
function ConditionEditor({ node, onChange, data, depth = 1 }: { node: WorkItemCondition; onChange: (node: WorkItemCondition) => void; data: WorkItemPage; depth?: number }) {
  if (node.kind === "group") return <fieldset className="work-items-automation-group"><legend>条件组</legend>
    <select aria-label="条件组合" value={node.operator} onChange={event => onChange({ ...node, operator: event.target.value as "and" | "or" })}><option value="and">全部满足（且）</option><option value="or">任一满足（或）</option></select>
    {node.children.map((child, index) => <div className="work-items-automation-node" key={index}>
      <ConditionEditor node={child} data={data} depth={depth + 1} onChange={value => onChange({ ...node, children: node.children.map((entry, i) => i === index ? value : entry) })} />
      <button type="button" aria-label="删除条件" onClick={() => onChange({ ...node, children: node.children.filter((_, i) => i !== index) })}>删除</button>
    </div>)}
    <button type="button" disabled={depth >= 5} onClick={() => onChange({ ...node, children: [...node.children, leaf()] })}>添加条件</button>
    <button type="button" disabled={depth >= 4} onClick={() => onChange({ ...node, children: [...node.children, { kind: "group", operator: "or", children: [leaf()] }] })}>添加条件组</button>
  </fieldset>;
  const options = node.field === "templateId" ? data.templates : node.field === "ownerId" ? data.owners : node.field === "needsFollowUp" ? [{ id: "true", name: "是" }, { id: "false", name: "否" }] : null;
  return <div className="work-items-automation-condition">
    <select aria-label="条件字段" value={node.field} onChange={event => onChange({ ...node, field: event.target.value as typeof node.field, operator: "equals", value: "" })}>{Object.entries(fields).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
    <select aria-label="匹配方式" value={node.operator} onChange={event => onChange({ ...node, operator: event.target.value as typeof node.operator })}>{Object.entries(operators).filter(([id]) => !options || ["equals", "notEquals"].includes(id)).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
    {options ? <select aria-label="条件值" value={node.value} onChange={event => onChange({ ...node, value: event.target.value })}><option value="">请选择</option>{options.map(value => <option key={value.id} value={value.id}>{value.name}{"templateId" in value ? ` · ${data.templates.find(template => template.id === value.templateId)?.name || value.templateId}` : ""}</option>)}</select> : <input aria-label="条件值" maxLength={1000} value={node.value} onChange={event => onChange({ ...node, value: event.target.value })} />}
  </div>;
}

export function WorkItemAutomation({ data, onClose }: { data: WorkItemPage; onClose: () => void }) {
  const [state, setState] = useState<WorkItemAutomationState>({ revision: 0, rules: [] });
  const [selected, setSelected] = useState(""); const [busy, setBusy] = useState(true); const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof window.workItemApi.previewAutomation>> | null>(null);
  useEffect(() => { let live = true; void window.workItemApi.getAutomation().then(value => { if (live) { setState(value); setSelected(value.rules[0]?.id || ""); } }).catch(err => { if (live) setError(String(err)); }).finally(() => { if (live) setBusy(false); }); return () => { live = false; }; }, []);
  const rule = state.rules.find(value => value.id === selected);
  const update = (value: WorkItemAutomationRule) => { setState(current => ({ ...current, rules: current.rules.map(entry => entry.id === value.id ? value : entry) })); setPreview(null); setSaved(false); };
  async function perform(save: boolean) {
    setBusy(true); setError("");
    try {
      if (save) { const result = await window.workItemApi.saveAutomation({ revision: state.revision, rules: state.rules }); setState(result); setSaved(true); }
      else if (rule) setPreview(await window.workItemApi.previewAutomation(rule));
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  function move(direction: number) {
    const index = state.rules.findIndex(value => value.id === selected); const next = index + direction;
    if (next < 0 || next >= state.rules.length) return;
    const rules = [...state.rules]; [rules[index], rules[next]] = [rules[next], rules[index]]; setState({ ...state, rules }); setSaved(false);
  }
  function addRule() {
    const value: WorkItemAutomationRule = { id: crypto.randomUUID(), name: "新规则", enabled: false, condition: { kind: "group", operator: "and", children: [leaf()] }, prompt: "" };
    setState({ ...state, rules: [...state.rules, value] }); setSelected(value.id); setPreview(null); setSaved(false);
  }
  function deleteRule() {
    setState({ ...state, rules: state.rules.filter(value => value.id !== selected) }); setSelected(""); setPreview(null); setSaved(false);
  }
  return <OwnerDialog title="自动化配置" wide busy={busy} onClose={onClose}>
    <div className="work-items-automation">
      <p>保存启用规则后，将自动处理匹配的历史及新待执行任务。按规则顺序首次命中，全局串行执行。</p>
      <p>仅自动关闭已完成且无错误的会话；曾发生错误的会话保留并提醒。</p>
      {state.waiting && <p role="status">{state.waiting}</p>}{error && <p role="alert" className="module-owners-error">{error}</p>}
      {saved && <p role="status">配置已保存</p>}
      <fieldset disabled={busy} className="work-items-automation-form">
        <div className="work-items-automation-actions"><select aria-label="选择规则" value={selected} onChange={event => { setSelected(event.target.value); setPreview(null); }}><option value="">选择规则</option>{state.rules.map((value, index) => <option key={value.id} value={value.id}>{index + 1}. {value.name}（{value.enabled ? "启用" : "停用"}）</option>)}</select>
          <button type="button" onClick={addRule}>新增规则</button>
          {rule && <><button type="button" disabled={state.rules[0]?.id === selected} onClick={() => move(-1)}>上移</button><button type="button" disabled={state.rules.at(-1)?.id === selected} onClick={() => move(1)}>下移</button><button type="button" onClick={deleteRule}>删除规则</button></>}
        </div>
        {rule && <><label>规则名称<input value={rule.name} maxLength={100} onChange={event => update({ ...rule, name: event.target.value })} /></label><label><input type="checkbox" checked={rule.enabled} onChange={event => update({ ...rule, enabled: event.target.checked })} />启用规则</label>
          <ConditionEditor node={rule.condition} data={data} onChange={condition => update({ ...rule, condition })} />
          <label>执行提示词（留空使用原始回复）<textarea rows={5} maxLength={100000} value={rule.prompt} onChange={event => update({ ...rule, prompt: event.target.value })} /></label>
          <div className="work-items-automation-actions">{["output", "taskName", "ownerName", "templateName"].map(variable => <button key={variable} type="button" onClick={() => update({ ...rule, prompt: rule.prompt + `{{${variable}}}` })}>插入 {variable}</button>)}<button type="button" onClick={() => void perform(false)}>预览匹配</button></div>
        </>}
      </fieldset>
      {preview && <div role="status"><p>匹配 {preview.total} 条待执行任务（预览当前规则，不扣除前序规则命中）</p>{preview.samples.map(value => <details key={value.id}><summary>{value.taskName}</summary><pre className="work-items-automation-preview">{value.prompt}</pre></details>)}</div>}
      <div className="work-items-automation-actions"><button type="button" disabled={busy} onClick={() => void perform(true)}>保存配置</button><button type="button" disabled={busy} onClick={onClose}>关闭</button></div>
    </div>
  </OwnerDialog>;
}
