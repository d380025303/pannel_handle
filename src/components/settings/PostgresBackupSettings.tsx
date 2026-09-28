import { useEffect, useState } from "react";
import type { AgentConversationMessage, PostgresBackupConfig } from "../../vite-env";
import { useI18n } from "../../i18n";

type Device = { id: string; name: string; last_seen_at: string };
type Snapshot = { id: string; device_id: string; created_at: string; session_count: number };
type Conversation = { source_key: string; conversation_ref: string; metadata: { title: string; provider: string; updatedAt: number } };

export function PostgresBackupSettings() {
  const { locale } = useI18n();
  const tr = (zh: string, en: string) => locale === "en-US" ? en : zh;
  const [config, setConfig] = useState<PostgresBackupConfig | null>(null);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<AgentConversationMessage[]>([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void window.postgresBackupApi.getConfig().then(setConfig).catch(error => setResult(String(error)));
    return window.postgresBackupApi.onChanged(setConfig);
  }, []);
  async function perform(work: () => Promise<unknown>, success: string) {
    setBusy(true); setResult("");
    try { const output = await work(); setResult(typeof output === "string" ? output : success); }
    catch (error) { setResult(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function loadDevices() {
    const items = await window.postgresBackupApi.listDevices();
    setDevices(items);
    const selected = items.some(item => item.id === deviceId) ? deviceId : items[0]?.id || "";
    setDeviceId(selected);
    if (selected !== deviceId) { setSelectedConversation(null); setMessages([]); setHasMoreMessages(false); }
    if (selected) {
      setSnapshots(await window.postgresBackupApi.listSnapshots(selected));
      const page = await window.postgresBackupApi.listConversations(selected);
      setConversations(page); setHasMoreConversations(page.length === 100);
    } else {
      setSnapshots([]); setConversations([]); setMessages([]);
    }
  }
  async function selectDevice(id: string) {
    setDeviceId(id); setMessages([]); setSelectedConversation(null); setConfirmDelete(false);
    setHasMoreMessages(false);
    await perform(async () => {
      const [nextSnapshots, nextConversations] = await Promise.all([
        window.postgresBackupApi.listSnapshots(id), window.postgresBackupApi.listConversations(id)
      ]);
      setSnapshots(nextSnapshots); setConversations(nextConversations);
      setHasMoreConversations(nextConversations.length === 100);
    }, tr("已载入备份", "Backup loaded"));
  }
  if (!config) return <section className="settings-section postgres-backup-settings"><p>{tr("正在读取 PostgreSQL 备份设置…", "Loading PostgreSQL backup settings…")}</p></section>;
  const change = (next: Partial<PostgresBackupConfig>) => setConfig({ ...config, ...next });
  return <section className="settings-section postgres-backup-settings">
    <div className="settings-card-header postgres-backup-intro"><div><h4>PostgreSQL {tr("备份", "backup")}</h4><p className="settings-help">{tr("本机数据继续保存在本地，启用后自动备份到数据库。会话库整体加密；统计和对话内容可由有数据库权限的人读取。", "Local data stays on this computer. Enabling backup copies it to PostgreSQL. Session snapshots are encrypted; database users can read statistics and conversations.")}</p></div></div>
    <label className="settings-field"><span className="modal-label">{tr("设备名称", "Device name")}</span><input className="modal-input" value={config.deviceName} onChange={event => change({ deviceName: event.target.value })} /></label>
    <p className="settings-help postgres-backup-device-id">{tr("设备 ID", "Device ID")}：{config.deviceId}</p>
    <div className="settings-choice-grid postgres-backup-fields">
      <label className="settings-field"><span className="modal-label">{tr("主机", "Host")}</span><input className="modal-input" value={config.host} onChange={event => change({ host: event.target.value })} /></label>
      <label className="settings-field"><span className="modal-label">{tr("端口", "Port")}</span><input className="modal-input" type="number" value={config.port} onChange={event => change({ port: Number(event.target.value) })} /></label>
      <label className="settings-field"><span className="modal-label">{tr("数据库", "Database")}</span><input className="modal-input" value={config.database} onChange={event => change({ database: event.target.value })} /></label>
      <label className="settings-field"><span className="modal-label">{tr("用户名", "User")}</span><input className="modal-input" value={config.user} onChange={event => change({ user: event.target.value })} /></label>
      <label className="settings-field"><span className="modal-label">{tr("密码", "Password")}</span><input className="modal-input" type="password" value={password} placeholder={config.hasPassword ? tr("已保存，留空则保留", "Saved; leave blank to keep") : tr("输入数据库密码", "Enter database password")} onChange={event => setPassword(event.target.value)} /></label>
      <label className="settings-field"><span className="modal-label">{tr("跨电脑备份口令", "Portable backup passphrase")}</span><input className="modal-input" type="password" value={passphrase} placeholder={config.hasPassphrase ? tr("已保存，留空则保留", "Saved; leave blank to keep") : tr("用于加密会话库", "Encrypts session snapshots")} onChange={event => setPassphrase(event.target.value)} /></label>
    </div>
    <label className="settings-toggle-row postgres-backup-toggle"><span><strong>{tr("验证服务器 TLS 证书", "Verify server TLS certificate")}</strong></span><input type="checkbox" checked={config.ssl} onChange={event => change({ ssl: event.target.checked })} /></label>
    <label className="settings-toggle-row postgres-backup-toggle"><span><strong>{tr("启用自动备份", "Enable automatic backup")}</strong></span><input type="checkbox" checked={config.enabled} onChange={event => change({ enabled: event.target.checked })} /></label>
    <div className="settings-actions postgres-backup-actions">
      <button className="modal-button" type="button" disabled={busy} onClick={() => void perform(async () => {
        const test = await window.postgresBackupApi.testConnection({ ...config, ...(password ? { password } : {}) });
        if (!test.ok) throw new Error(test.error);
      }, tr("连接成功", "Connection successful"))}>{tr("测试连接", "Test connection")}</button>
      <button className="modal-button primary" type="button" disabled={busy} onClick={() => void perform(async () => {
        setConfig(await window.postgresBackupApi.saveConfig({ ...config, password, passphrase }));
        setPassword(""); setPassphrase("");
      }, tr("设置已保存", "Settings saved"))}>{tr("保存设置", "Save settings")}</button>
      <button className="modal-button" type="button" disabled={busy || !config.enabled} onClick={() => void perform(async () => {
        const next = await window.postgresBackupApi.run();
        setConfig(next);
        await loadDevices();
        return next.lastError ? tr("部分备份失败，请查看错误", "Part of the backup failed; see the error")
          : next.pendingSources.length ? tr("备份完成，部分远程来源待同步", "Backup complete; some remote sources are pending")
            : tr("备份完成", "Backup complete");
      }, tr("备份完成", "Backup complete"))}>{tr("立即备份", "Back up now")}</button>
    </div>
    <div className="postgres-backup-status">
      <span className="postgres-backup-status-label">{tr("上次成功", "Last successful backup")}</span>
      <strong>{config.lastSuccessAt ? new Date(config.lastSuccessAt).toLocaleString() : tr("尚未完成", "None yet")}</strong>
      {config.running && <span className="postgres-backup-running">{tr("正在备份", "Running")}</span>}
    </div>
    {config.lastError && <p className="settings-result error" role="alert">{config.lastError}</p>}
    {config.pendingSources?.length > 0 && <details className="settings-result postgres-backup-pending">
      <summary>{tr(`${config.pendingSources.length} 个远程来源待重连后同步`, `${config.pendingSources.length} remote sources will sync after reconnecting`)}</summary>
      <ul>{config.pendingSources.map((source, index) => <li key={`${source}:${index}`}>{source}</li>)}</ul>
    </details>}
    {result && <p className="settings-result" role="status">{result}</p>}
    <hr className="postgres-backup-divider" />
    <div className="settings-card-header postgres-backup-browse-header"><div><h4>{tr("查看与恢复", "Browse and restore")}</h4><p className="settings-help">{tr("会话恢复会创建副本，不覆盖本机模板。", "Restoring sessions creates copies without replacing local templates.")}</p></div></div>
    <button className="modal-button postgres-backup-refresh" type="button" disabled={busy} onClick={() => void perform(loadDevices, tr("已载入设备", "Devices loaded"))}>{tr("刷新设备", "Refresh devices")}</button>
    {devices.length > 0 && <label className="settings-field"><span className="modal-label">{tr("来源电脑", "Source computer")}</span><select className="modal-input" value={deviceId} onChange={event => void selectDevice(event.target.value)}>{devices.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id.slice(0, 8)}</option>)}</select></label>}
    {snapshots.length > 0 && <div className="postgres-backup-list">{snapshots.map(item => <div className="settings-toggle-row postgres-backup-snapshot" key={item.id}><span>{new Date(item.created_at).toLocaleString()} · {item.session_count} {tr("个会话", "sessions")}</span><button className="modal-button compact" type="button" disabled={busy} onClick={() => void perform(async () => {
      const answer = await window.postgresBackupApi.restore(item.id, passphrase || undefined);
      await window.terminalApi.loadSavedSessions();
      return tr(`已恢复 ${answer.importedCount} 个会话，请重新打开会话库查看。`, `Restored ${answer.importedCount} sessions. Reopen the session library to view them.`);
    }, tr("恢复完成", "Restore complete"))}>{tr("作为副本恢复", "Restore as copies")}</button></div>)}</div>}
    {conversations.length > 0 && <div className="postgres-backup-conversations"><h4>{tr("已备份的 Agent 对话", "Backed up Agent conversations")}</h4><div className="postgres-backup-list">{conversations.map(item => <button className="settings-toggle-row postgres-backup-conversation" type="button" key={`${item.source_key}:${item.conversation_ref}`} onClick={() => void perform(async () => {
      setSelectedConversation(item);
      const page = await window.postgresBackupApi.getMessages(deviceId, item.source_key, item.conversation_ref);
      setMessages(page); setHasMoreMessages(page.length === 100);
    }, tr("已载入对话", "Conversation loaded"))}><span>{item.metadata.title} · {item.metadata.provider}</span></button>)}</div>
      {hasMoreConversations && <button className="modal-button" type="button" disabled={busy} onClick={() => void perform(async () => {
        const more = await window.postgresBackupApi.listConversations(deviceId, conversations.length);
        setConversations(current => [...current, ...more]); setHasMoreConversations(more.length === 100);
      }, tr("已载入更多对话", "More conversations loaded"))}>{tr("加载更多对话", "Load more conversations")}</button>}
      {selectedConversation && <div className="postgres-backup-messages"><h4>{selectedConversation.metadata.title}</h4>{messages.map(message => <p key={message.id}><strong>{message.kind}：</strong>{message.text}</p>)}
        {hasMoreMessages && <button className="modal-button" type="button" disabled={busy} onClick={() => void perform(async () => {
          const more = await window.postgresBackupApi.getMessages(deviceId, selectedConversation.source_key, selectedConversation.conversation_ref, messages.length);
          setMessages(current => [...current, ...more]); setHasMoreMessages(more.length === 100);
        }, tr("已载入更多消息", "More messages loaded"))}>{tr("加载更多消息", "Load more messages")}</button>}</div>}
    </div>}
    {deviceId && <button className="modal-button danger postgres-backup-delete" type="button" disabled={busy} onClick={() => {
      if (!confirmDelete) { setConfirmDelete(true); return; }
      void perform(async () => { await window.postgresBackupApi.deleteDevice(deviceId); setConfirmDelete(false); await loadDevices(); }, tr("远端设备备份已删除", "Remote device backup deleted"));
    }}>{confirmDelete ? tr("确认删除所选电脑的全部远端备份", "Confirm deletion of all backups from this computer") : tr("删除所选电脑的远端备份", "Delete this computer's remote backup")}</button>}
  </section>;
}
