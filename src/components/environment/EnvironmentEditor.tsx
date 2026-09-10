import { useState } from "react";
import type { EnvironmentEntry } from "../../vite-env";

export function parseEnvironmentText(text: string): EnvironmentEntry[] {
  return text.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith("#")).map(line => {
    const split = line.indexOf("=");
    if (split < 1) throw new Error("每行应为 KEY=VALUE。");
    return { name: line.slice(0, split).trim(), value: line.slice(split + 1) };
  });
}

export function EnvironmentEditor({ value, onChange }: { value: EnvironmentEntry[]; onChange: (value: EnvironmentEntry[]) => void }) {
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  return <div className="environment-editor">
    <div className="environment-row"><span>变量名</span><span>值</span><span /></div>
    {value.map((entry, index) => <div className="environment-row" key={index}>
      <input className="modal-input" aria-label={`变量名 ${index + 1}`} value={entry.name} onChange={e => onChange(value.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} />
      <input className="modal-input" aria-label={`变量值 ${index + 1}`} value={entry.value} onChange={e => onChange(value.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} />
      <button type="button" className="btn" aria-label={`删除变量 ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>删除</button>
    </div>)}
    <button type="button" className="btn" onClick={() => onChange([...value, { name: "", value: "" }])}>添加变量</button>
    <details><summary>批量粘贴 KEY=VALUE</summary>
      <textarea className="modal-input" aria-label="批量环境变量" rows={4} placeholder={"HTTP_PROXY=http://127.0.0.1:7892\nFEATURE_ENABLED=true"} value={paste} onChange={e => setPaste(e.target.value)} />
      <button type="button" className="btn" onClick={() => { try { onChange([...value, ...parseEnvironmentText(paste)]); setPaste(""); setError(""); } catch (e) { setError(String(e)); } }}>追加到表格</button>
      {error && <div role="alert" className="modal-error">{error}</div>}
    </details>
  </div>;
}
