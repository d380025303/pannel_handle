import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type { MobileAccessAuditEntry, MobileAccessState } from "../../vite-env";

export function MobileAccessSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<MobileAccessState | null>(null);
  const [interfaceName, setInterfaceName] = useState("");
  const [port, setPort] = useState("43123");
  const [password, setPasswordInput] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [audit, setAudit] = useState<MobileAccessAuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);

  const applyState = (next: MobileAccessState) => {
    setState(next);
    setInterfaceName(next.config.interfaceName || next.interfaces[0]?.name || "");
    setPort(String(next.config.port));
  };

  useEffect(() => {
    let disposed = false;
    window.mobileAccessApi.getState().then((next) => { if (!disposed) applyState(next); }).catch((err) => { if (!disposed) setError(err instanceof Error ? err.message : String(err)); });
    window.mobileAccessApi.listAudit().then((entries) => { if (!disposed) setAudit(entries); }).catch(() => undefined);
    const removeListener = window.mobileAccessApi.onStateChanged((next) => {
      if (disposed) return;
      applyState(next);
      void window.mobileAccessApi.listAudit().then((entries) => { if (!disposed) setAudit(entries); });
    });
    return () => { disposed = true; removeListener(); };
  }, []);

  const update = async (partial: Partial<MobileAccessState["config"]>) => {
    setBusy(true);
    setError("");
    try {
      applyState(await window.mobileAccessApi.updateConfig(partial));
      setAudit(await window.mobileAccessApi.listAudit());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveNetwork = () => void update({ interfaceName, port: Number(port) });
  const toggleEnabled = (enabled: boolean) => void update({ enabled, interfaceName, port: Number(port) });

  const savePassword = async () => {
    setBusy(true);
    setError("");
    setPasswordSaved(false);
    try {
      applyState(await window.mobileAccessApi.setPassword(password));
      setPasswordInput("");
      setPasswordSaved(true);
      setAudit(await window.mobileAccessApi.listAudit());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  return (
    <section className="settings-section mobile-access-settings">
      <div className="collapsible-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen((value) => !value); } }}>
        <span className={`collapsible-chevron${open ? "" : " collapsed"}`}>▾</span>
        <h4>{t("settings.mobileTitle")}</h4>
        <label className="auto-restore-label ding-talk-toggle" onClick={(event) => event.stopPropagation()}>
          <input type="checkbox" className="auto-restore-checkbox" checked={state.config.enabled} disabled={busy || !state.config.hasPassword} onChange={(event) => toggleEnabled(event.target.checked)} />
          <span className="auto-restore-track" />
          <span className="auto-restore-text">{state.running ? t("settings.mobileRunning") : t("settings.mobileStopped")}</span>
        </label>
      </div>
      {open && (
        <>
          <p className="mobile-access-warning">{t("settings.mobileHttpWarning")}</p>
          <div className="mobile-access-password">
            <label className="settings-field"><span className="modal-label">{t("settings.mobilePassword")}</span><input className="modal-input" type="password" autoComplete="new-password" value={password} disabled={busy} onChange={(event) => setPasswordInput(event.target.value)} /></label>
            <button className="modal-button" type="button" disabled={busy || password.length < 8} onClick={savePassword}>{state.config.hasPassword ? t("settings.mobileChangePassword") : t("settings.mobileSetPassword")}</button>
            <small>{state.config.hasPassword ? t("settings.mobilePasswordSet") : t("settings.mobilePasswordNeeded")}</small>
            {passwordSaved && <small>{t("settings.mobilePasswordSaved")}</small>}
          </div>
          <div className="mobile-access-grid">
            <label className="settings-field"><span className="modal-label">{t("settings.mobileInterface")}</span><select className="modal-input" value={interfaceName} disabled={busy} onChange={(event) => setInterfaceName(event.target.value)}>{state.interfaces.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.address}</option>)}</select></label>
            <label className="settings-field"><span className="modal-label">{t("settings.mobilePort")}</span><input className="modal-input" type="number" min="1024" max="65535" value={port} disabled={busy} onChange={(event) => setPort(event.target.value)} /></label>
          </div>
          <div className="ding-talk-actions"><button className="modal-button" type="button" disabled={busy || !interfaceName} onClick={saveNetwork}>{t("common.save")}</button></div>
          {state.running && <div className="mobile-access-addresses">{state.canonicalUrl && <code>{state.canonicalUrl}</code>}{state.fallbackUrl && <code>{state.fallbackUrl}</code>}<code>{state.localUrl}</code></div>}
          {state.running && <p className="settings-help">{state.fallbackUrl ? t("settings.mobileOpenHint") : t("settings.mobileLocalOpenHint")}</p>}
          {state.lastError && <p className="ding-talk-result error">{state.lastError}</p>}
          {error && <p className="ding-talk-result error">{error}</p>}
          <div className="mobile-access-subsection">
            <h5>{t("settings.mobileActiveDevice")} ({state.activeConnections.length})</h5>
            {state.activeConnections.map((connection) => <div className="mobile-device-row" key={connection.id}><span><strong>{connection.name}</strong><small>{connection.remoteAddress}</small></span><button className="modal-button danger" type="button" onClick={() => void window.mobileAccessApi.disconnectConnection(connection.id)}>{t("settings.mobileDisconnect")}</button></div>)}
            {state.activeConnections.length === 0 && <p className="settings-help">{t("settings.mobileNoActiveDevice")}</p>}
          </div>
          <details className="mobile-audit"><summary>{t("settings.mobileAudit")} ({audit.length})</summary>{audit.slice(0, 30).map((entry) => <div key={entry.id}><time>{new Date(entry.at).toLocaleString()}</time><span>{entry.type}</span><span>{entry.deviceName || entry.reason || ""}</span></div>)}</details>
        </>
      )}
    </section>
  );
}
