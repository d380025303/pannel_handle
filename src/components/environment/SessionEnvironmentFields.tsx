import { useEffect, useState } from "react";
import type { EnvironmentProfile, EnvironmentSelection, EnvironmentPreview } from "../../vite-env";
import { EnvironmentEditor } from "./EnvironmentEditor";

type Props = { value: EnvironmentSelection; onChange: (value: EnvironmentSelection) => void; type: string; agentProvider?: string; agentLocation?: string };
export function SessionEnvironmentFields({ value, onChange, type, agentProvider, agentLocation }: Props) {
  const [profiles, setProfiles] = useState<EnvironmentProfile[]>([]);
  const [preview, setPreview] = useState<EnvironmentPreview[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { window.environmentApi?.list().then(setProfiles).catch(e => setError(String(e))); }, []);
  useEffect(() => {
    let disposed = false;
    window.environmentApi?.preview({ ...value, type, agentProvider, agentLocation }).then(result => { if (!disposed) { setPreview(result); setError(""); } }).catch(e => { if (!disposed) { setPreview([]); setError(String(e)); } });
    return () => { disposed = true; };
  }, [value, type, agentProvider, agentLocation]);
  return <details className="environment-settings"><summary>环境变量{value.environmentProfileId || value.environmentOverrides?.length ? "（已配置）" : ""}</summary>
    <p>在设置中维护配置组；会话变量覆盖组内同名变量。下次启动生效。</p>
    <label className="modal-field"><span>配置组</span><select className="modal-input" value={value.environmentProfileId || ""} onChange={e => onChange({ ...value, environmentProfileId: e.target.value || null })}><option value="">不使用配置组</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <EnvironmentEditor value={value.environmentOverrides || []} onChange={environmentOverrides => onChange({ ...value, environmentOverrides })} />
    {error && <div role="alert" className="modal-error">{error}</div>}
    {preview.length > 0 && <><p>待注入配置（不含系统继承值）</p><table className="environment-preview"><thead><tr><th>变量</th><th>值</th><th>来源</th></tr></thead><tbody>{preview.map(e => <tr key={e.name}><td>{e.name}</td><td>{e.value === "" ? "（空字符串）" : e.value}</td><td>{e.source}</td></tr>)}</tbody></table></>}
    <p>应用运行变量及模型服务注入的同名变量优先；Shell 启动脚本可继续修改环境。仅保存普通配置，不支持密钥。</p>
    {type === "ssh" && <p>{agentProvider && agentLocation === "local" ? "注入本地 Agent 进程。" : "远端注入仅支持 Linux / Bash，不影响 SFTP 和独立后台命令。"}</p>}
  </details>;
}
