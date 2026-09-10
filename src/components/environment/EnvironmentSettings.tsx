import { useEffect, useState } from "react";
import type { EnvironmentEntry, EnvironmentProfile } from "../../vite-env";
import { EnvironmentEditor } from "./EnvironmentEditor";

export function EnvironmentSettings() {
  const [profiles, setProfiles] = useState<EnvironmentProfile[]>([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [entries, setEntries] = useState<EnvironmentEntry[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.environmentApi?.list().then(setProfiles).catch(e => setMessage(String(e))); }, []);
  const select = (next: string) => {
    const profile = profiles.find(p => p.id === next);
    setId(next); setName(profile?.name || ""); setEntries(profile?.entries || []); setMessage("");
  };
  const run = async (remove = false) => {
    setBusy(true); setMessage("");
    try {
      const next = remove ? await window.environmentApi.delete(id) : await window.environmentApi.save({ id: id || undefined, name, entries });
      setProfiles(next);
      if (remove) { setId(""); setName(""); setEntries([]); }
      else setId(next.find(p => p.name === name.trim())?.id || "");
      setMessage(remove ? "已删除" : "已保存，下次启动会话生效。");
    } catch (e) { setMessage(String(e)); } finally { setBusy(false); }
  };
  const references = profiles.find(p => p.id === id)?.references || [];
  return <details className="settings-section environment-settings"><summary>环境变量配置组</summary>
    <p>普通配置以明文保存在本机，请勿填写密钥。修改后下次启动会话生效。</p>
    <fieldset disabled={busy}>
      <label className="modal-field"><span>配置组</span><select className="modal-input" value={id} onChange={e => select(e.target.value)}><option value="">新建配置组</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="modal-field"><span>配置组名称</span><input className="modal-input" value={name} onChange={e => setName(e.target.value)} /></label>
      <EnvironmentEditor value={entries} onChange={setEntries} />
      {references.length > 0 && <p>引用会话：{[...new Set(references)].join("、")}</p>}
      <div className="environment-actions">
        <button type="button" className="btn" onClick={() => void run()}>保存配置组</button>
        <button type="button" className="btn" disabled={!id} onClick={() => { setId(""); setName(`${name} - 副本`); setMessage(""); }}>复制为新组</button>
        <button type="button" className="btn" disabled={!id || references.length > 0} onClick={() => void run(true)}>删除配置组</button>
      </div>
    </fieldset>
    {message && <p role="status">{message}</p>}
  </details>;
}
