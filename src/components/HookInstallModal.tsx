import { useEffect, useMemo, useState } from "react";
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

const providers: HookProvider[] = ["claude", "codex"];

const statusLabels = {
  not_installed: "未安装",
  installed: "已安装",
  needs_repair: "需要修复"
};

export function HookInstallModal({ session, onCancel }: HookInstallModalProps) {
  const [projectPath, setProjectPath] = useState(session.cwd === "~" ? "" : session.cwd);
  const [selectedProviders, setSelectedProviders] = useState<HookProvider[]>(providers);
  const [result, setResult] = useState<HookInspectionResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const target = useMemo<HookInstallTarget | null>(() => {
    const value = projectPath.trim();
    if (!value) return null;
    if (session.type === "wsl" && session.wslDistro) {
      return { type: "wsl", path: value, wslDistro: session.wslDistro };
    }
    if (session.type === "windows") {
      return { type: "windows", path: value };
    }
    return null;
  }, [projectPath, session.type, session.wslDistro]);

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
      window.hookConfigApi.inspect(target, providers).then(setResult);
    }, session.type === "wsl" ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [session.type, target]);

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

  return (
    <div className="modal-overlay">
      <div className="modal-dialog hook-install-dialog">
        <div className="modal-header">
          <h3>安装项目 Hook</h3>
          <p className="modal-subtitle">{session.title} · {session.type === "wsl" ? session.wslDistro : "Windows"}</p>
        </div>
        <div className="modal-body hook-install-body">
          <label className="modal-field">
            <span className="modal-label">项目目录</span>
            <div className="hook-path-row">
              <input
                className="modal-input"
                value={projectPath}
                readOnly={session.type === "windows"}
                placeholder={session.type === "wsl" ? "/home/user/project" : "选择 Windows 项目目录"}
                onChange={(event) => setProjectPath(event.target.value)}
              />
              {session.type === "windows" && (
                <button className="modal-button" type="button" onClick={chooseWindowsDirectory}>
                  选择
                </button>
              )}
            </div>
          </label>

          <div className="hook-provider-list">
            {providers.map((provider) => {
              const inspection = result?.providers[provider];
              return (
                <label className="hook-provider-row" key={provider}>
                  <input
                    type="checkbox"
                    checked={selectedProviders.includes(provider)}
                    onChange={() => toggleProvider(provider)}
                  />
                  <span className="hook-provider-name">{provider === "claude" ? "Claude Code" : "Codex"}</span>
                  <span className={`hook-install-status ${inspection?.status || "unknown"}`}>
                    {inspection ? statusLabels[inspection.status] : "待检查"}
                  </span>
                </label>
              );
            })}
          </div>

          {result && !result.ok && <div className="hook-install-error">{result.error}</div>}
          {result?.ok && result.providers.codex?.status === "installed" && (
            <div className="hook-install-note">Codex 首次使用项目 Hook 时，仍需在 Codex 的 /hooks 中确认信任。</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" disabled={isBusy} onClick={onCancel}>关闭</button>
          <button
            className="modal-button primary"
            type="button"
            disabled={isBusy || !target || selectedProviders.length === 0}
            onClick={install}
          >
            {isBusy ? "安装中..." : "安装或修复"}
          </button>
        </div>
      </div>
    </div>
  );
}
