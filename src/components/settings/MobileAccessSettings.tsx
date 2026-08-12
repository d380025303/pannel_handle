import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type { MobileAccessAuditEntry, MobileAccessState, MobilePairingInfo } from "../../vite-env";

export function MobileAccessSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<MobileAccessState | null>(null);
  const [interfaceName, setInterfaceName] = useState("");
  const [port, setPort] = useState("43123");
  const [pairing, setPairing] = useState<MobilePairingInfo | null>(null);
  const [audit, setAudit] = useState<MobileAccessAuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

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

  const createPairing = async () => {
    setBusy(true);
    setError("");
    try {
      setPairing(await window.mobileAccessApi.createPairing());
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
          <input type="checkbox" className="auto-restore-checkbox" checked={state.config.enabled} disabled={busy} onChange={(event) => toggleEnabled(event.target.checked)} />
          <span className="auto-restore-track" />
          <span className="auto-restore-text">{state.running ? t("settings.mobileRunning") : t("settings.mobileStopped")}</span>
        </label>
      </div>
      {open && (
        <>
          <p className="mobile-access-warning">{t("settings.mobileHttpWarning")}</p>
          <div className="mobile-access-grid">
            <label className="settings-field"><span className="modal-label">{t("settings.mobileInterface")}</span><select className="modal-input" value={interfaceName} disabled={busy} onChange={(event) => setInterfaceName(event.target.value)}>{state.interfaces.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.address}</option>)}</select></label>
            <label className="settings-field"><span className="modal-label">{t("settings.mobilePort")}</span><input className="modal-input" type="number" min="1024" max="65535" value={port} disabled={busy} onChange={(event) => setPort(event.target.value)} /></label>
          </div>
          <div className="ding-talk-actions"><button className="modal-button" type="button" disabled={busy || !interfaceName} onClick={saveNetwork}>{t("common.save")}</button><button className="modal-button primary" type="button" disabled={busy || !state.running} onClick={createPairing}>{t("settings.mobilePair")}</button></div>
          {state.running && <div className="mobile-access-addresses"><code>{state.canonicalUrl}</code><code>{state.fallbackUrl}</code></div>}
          {state.lastError && <p className="ding-talk-result error">{state.lastError}</p>}
          {error && <p className="ding-talk-result error">{error}</p>}
          {pairing && (
            <div className="mobile-pairing-card">
              <img src={pairing.qrDataUrl} alt={t("settings.mobilePairQr")} />
              <div><strong>{t("settings.mobilePairHint")}</strong><code>{pairing.url}</code><small>{t("settings.mobilePairExpiry")}</small></div>
            </div>
          )}
          <div className="mobile-access-subsection">
            <h5>{t("settings.mobileActiveDevice")}</h5>
            {state.activeDevice ? <div className="mobile-device-row"><span><strong>{state.activeDevice.name}</strong><small>{state.activeDevice.connected ? t("settings.mobileConnected") : t("settings.mobileReconnectGrace")}</small></span><button className="modal-button danger" type="button" onClick={() => void window.mobileAccessApi.disconnectDevice()}>{t("settings.mobileDisconnect")}</button></div> : <p className="settings-help">{t("settings.mobileNoActiveDevice")}</p>}
          </div>
          <div className="mobile-access-subsection">
            <h5>{t("settings.mobileTrustedDevices")}</h5>
            {state.devices.map((device) => <div className="mobile-device-row" key={device.id}><span><strong>{device.name}</strong><small>{new Date(device.lastSeenAt).toLocaleString()}</small></span><button className="modal-button danger" type="button" onClick={() => void window.mobileAccessApi.revokeDevice(device.id)}>{t("settings.mobileRevoke")}</button></div>)}
            {state.devices.length === 0 && <p className="settings-help">{t("settings.mobileNoTrustedDevices")}</p>}
          </div>
          <details className="mobile-audit"><summary>{t("settings.mobileAudit")} ({audit.length})</summary>{audit.slice(0, 30).map((entry) => <div key={entry.id}><time>{new Date(entry.at).toLocaleString()}</time><span>{entry.type}</span><span>{entry.deviceName || entry.reason || ""}</span></div>)}</details>
        </>
      )}
    </section>
  );
}
