import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type {
  HookInspectionResult,
  HookInstallTarget,
  HookProvider,
  TerminalSession
} from "../vite-env";

type HookInstallModalProps = {
  session: TerminalSession;
  onCancel: () => void;
};

const localProviders: HookProvider[] = ["claude", "codex", "opencode", "qoder"];
const sshProviders: HookProvider[] = ["claude", "codex", "qoder"];

const providerNames: Record<HookProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  qoder: "Qoder"
};

function getInitialProjectPath(session: TerminalSession) {
  if (session.type === "ssh") {
    const cwd = String(session.cwd || "").trim();
    return cwd && cwd !== "~" && cwd.startsWith("/") ? cwd : "";
  }
  return session.cwd === "~" ? "" : session.cwd;
}

export function HookInstallModal({ session, onCancel }: HookInstallModalProps) {
  const { t } = useI18n();
  const [projectPath, setProjectPath] = useState(getInitialProjectPath(session));
  const availableProviders = session.type === "ssh" ? sshProviders : localProviders;
  const [selectedProviders, setSelectedProviders] = useState<HookProvider[]>(availableProviders);
  const [result, setResult] = useState<HookInspectionResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const statusLabels = {
    not_installed: t("hooks.notInstalled"),
    installed: t("hooks.installed"),
    needs_repair: t("hooks.needsRepair")
  };

  const target = useMemo<HookInstallTarget | null>(() => {
    const value = projectPath.trim();
    if (!value) return null;
    if (session.type === "ssh") {
      return { type: "ssh", sessionId: session.id, path: value };
    }
    if (session.type === "wsl" && session.wslDistro) {
      return { type: "wsl", path: value, wslDistro: session.wslDistro };
    }
    if (session.type === "windows") {
      return { type: "windows", path: value };
    }
    return null;
  }, [projectPath, session.id, session.type, session.wslDistro]);

  useEffect(() => {
    setProjectPath(getInitialProjectPath(session));
    setSelectedProviders(session.type === "ssh" ? sshProviders : localProviders);
    setResult(null);
  }, [session]);

  useEffect(() => {
    if (session.type !== "ssh" || projectPath.trim()) return;
    let cancelled = false;
    window.remoteFileApi.getHome(session.id)
      .then((home) => {
        if (!cancelled && home) setProjectPath(home);
      })
      .catch(() => {
        // The user can still type the remote project path manually.
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, session.id, session.type]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isBusy) onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isBusy, onCancel]);

  useEffect(() => {
    setResult(null);
    if (!target) return;
    const timer = window.setTimeout(() => {
      window.hookConfigApi.inspect(target, availableProviders).then(setResult);
    }, session.type === "wsl" ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [availableProviders, session.type, target]);

  const toggleProvider = (provider: HookProvider) => {
    setSelectedProviders((current) => current.includes(provider)
      ? current.filter(item => item !== provider)
      : [...current, provider]);
  };

  const chooseWindowsDirectory = async () => {
    const selection = await window.hookConfigApi.selectProjectDirectory(projectPath || session.cwd);
    if (!selection.canceled) setProjectPath(selection.path);
  };

  const install = async () => {
    if (!target || selectedProviders.length === 0) return;
    setIsBusy(true);
    try {
      setResult(await window.hookConfigApi.install(target, selectedProviders));
    } finally {
      setIsBusy(false);
    }
  };

  const environmentLabel = session.type === "ssh"
    ? `SSH: ${session.sshConfig?.username ? `${session.sshConfig.username}@` : ""}${session.sshConfig?.host || session.title}`
    : session.type === "wsl"
      ? `WSL: ${session.wslDistro}`
      : "Windows";

  return (
    <div className="modal-overlay">
      <div className="modal-dialog hook-install-dialog">
        <div className="modal-header">
          <h3>{t("hooks.title")}</h3>
          <p className="modal-subtitle">{session.title} - {environmentLabel}</p>
        </div>
        <div className="modal-body hook-install-body">
          <label className="modal-field">
            <span className="modal-label">{session.type === "ssh" ? t("hooks.remoteProjectDirectory") : t("hooks.localProjectDirectory")}</span>
            <div className="hook-path-row">
              <input
                className="modal-input"
                value={projectPath}
                readOnly={session.type === "windows"}
                placeholder={session.type === "ssh" ? "/home/user/project" : session.type === "wsl" ? "/home/user/project" : t("hooks.chooseWindowsPlaceholder")}
                onChange={(event) => setProjectPath(event.target.value)}
              />
              {session.type === "windows" && (
                <button className="modal-button" type="button" onClick={chooseWindowsDirectory}>
                  {t("common.select")}
                </button>
              )}
            </div>
          </label>

          {session.type === "ssh" && (
            <div className="hook-install-note">
              {t("hooks.sshNote")}
            </div>
          )}

          <div className="hook-provider-list">
            {availableProviders.map((provider) => {
              const inspection = result?.providers[provider];
              return (
                <label className="hook-provider-row" key={provider}>
                  <input
                    type="checkbox"
                    checked={selectedProviders.includes(provider)}
                    onChange={() => toggleProvider(provider)}
                  />
                  <span className="hook-provider-name">{providerNames[provider]}</span>
                  <span className={`hook-install-status ${inspection?.status || "unknown"}`}>
                    {inspection ? statusLabels[inspection.status] : t("hooks.pendingCheck")}
                  </span>
                </label>
              );
            })}
          </div>

          {result && !result.ok && <div className="hook-install-error">{result.error}</div>}
          {result?.ok && result.providers.codex?.status === "installed" && (
            <div className="hook-install-note">{t("hooks.codexTrustNote")}</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" disabled={isBusy} onClick={onCancel}>{t("common.close")}</button>
          <button
            className="modal-button primary"
            type="button"
            disabled={isBusy || !target || selectedProviders.length === 0}
            onClick={install}
          >
            {isBusy ? t("hooks.installing") : t("hooks.installOrRepair")}
          </button>
        </div>
      </div>
    </div>
  );
}
