import { useCallback, useEffect, useState } from "react";
import type { AppTheme } from "../themes";
import type { QqBotNotifyStatus, QqBotPublicConfig, QqBotStatus, ThemeId } from "../vite-env";

type SettingsModalProps = {
  autoRestore: boolean;
  debugMode: boolean;
  themeId: ThemeId;
  themes: AppTheme[];
  onToggleAutoRestore: () => void;
  onToggleDebugMode: () => void;
  onThemeChange: (themeId: ThemeId) => void;
  onCancel: () => void;
};

const defaultQqBotConfig: QqBotPublicConfig = {
  enabled: false,
  appId: "",
  clientSecretSet: false,
  targetOpenid: "",
  notifyStatuses: ["waiting_for_permission", "completed", "failed", "ended"],
  queueWhenUnavailable: true
};

const notifyStatusOptions: Array<{ value: QqBotNotifyStatus; label: string }> = [
  { value: "waiting_for_permission", label: "等待确认" },
  { value: "failed", label: "失败" },
  { value: "completed", label: "完成" },
  { value: "ended", label: "结束" }
];

function formatStatusTime(timestamp?: number) {
  if (!timestamp) return "无";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getQqStatusText(status: QqBotStatus | null) {
  if (!status?.enabled) return "未启用";
  if (status.connected) return "已连接";
  if (status.lastError) return "连接异常";
  return "等待连接";
}

export function SettingsModal({
  autoRestore,
  debugMode,
  themeId,
  themes,
  onToggleAutoRestore,
  onToggleDebugMode,
  onThemeChange,
  onCancel
}: SettingsModalProps) {
  const [qqConfig, setQqConfig] = useState<QqBotPublicConfig>(defaultQqBotConfig);
  const [qqStatus, setQqStatus] = useState<QqBotStatus | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  const [qqMessage, setQqMessage] = useState("");
  const [isSavingQq, setIsSavingQq] = useState(false);
  const [isTestingQq, setIsTestingQq] = useState(false);

  const refreshQqStatus = useCallback(async () => {
    const status = await window.qqBotApi.getStatus();
    setQqStatus(status);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  useEffect(() => {
    let isDisposed = false;
    Promise.all([
      window.qqBotApi.getConfig(),
      window.qqBotApi.getStatus()
    ]).then(([config, status]) => {
      if (isDisposed) return;
      setQqConfig(config);
      setQqStatus(status);
    });
    const timer = window.setInterval(() => {
      void refreshQqStatus();
    }, 3000);
    return () => {
      isDisposed = true;
      window.clearInterval(timer);
    };
  }, [refreshQqStatus]);

  const setQqField = useCallback(<K extends keyof QqBotPublicConfig>(key: K, value: QqBotPublicConfig[K]) => {
    setQqConfig((current) => ({ ...current, [key]: value }));
  }, []);

  const toggleNotifyStatus = useCallback((status: QqBotNotifyStatus) => {
    setQqConfig((current) => {
      const exists = current.notifyStatuses.includes(status);
      const notifyStatuses = exists
        ? current.notifyStatuses.filter((item) => item !== status)
        : [...current.notifyStatuses, status];
      return {
        ...current,
        notifyStatuses: notifyStatuses.length > 0 ? notifyStatuses : current.notifyStatuses
      };
    });
  }, []);

  const saveQqConfig = useCallback(async () => {
    setIsSavingQq(true);
    setQqMessage("");
    const result = await window.qqBotApi.setConfig({
      enabled: qqConfig.enabled,
      appId: qqConfig.appId,
      targetOpenid: qqConfig.targetOpenid,
      notifyStatuses: qqConfig.notifyStatuses,
      queueWhenUnavailable: qqConfig.queueWhenUnavailable,
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {})
    });
    setIsSavingQq(false);
    setQqConfig(result.config);
    setClientSecret("");
    await refreshQqStatus();
    setQqMessage(result.ok ? "QQ 机器人配置已保存" : result.error);
  }, [clientSecret, qqConfig, refreshQqStatus]);

  const clearQqSecret = useCallback(async () => {
    setIsSavingQq(true);
    setQqMessage("");
    const result = await window.qqBotApi.setConfig({ clearClientSecret: true });
    setIsSavingQq(false);
    setQqConfig(result.config);
    setClientSecret("");
    await refreshQqStatus();
    setQqMessage(result.ok ? "Client Secret 已清除" : result.error);
  }, [refreshQqStatus]);

  const testQqNotification = useCallback(async () => {
    setIsTestingQq(true);
    setQqMessage("");
    const result = await window.qqBotApi.testSend();
    setIsTestingQq(false);
    if (result.status) setQqStatus(result.status);
    setQqMessage(result.ok ? "测试消息已发送" : result.error);
  }, []);

  return (
    <div className="modal-overlay">
      <div className="modal-dialog settings-dialog">
        <div className="modal-header">
          <h3>设置</h3>
        </div>
        <div className="modal-body settings-body">
          <section className="settings-section">
            <label className="auto-restore-label">
              <input
                type="checkbox"
                className="auto-restore-checkbox"
                checked={autoRestore}
                onChange={onToggleAutoRestore}
              />
              <span className="auto-restore-track" />
              <span className="auto-restore-text">启动时自动恢复</span>
            </label>
            <label className="auto-restore-label">
              <input
                type="checkbox"
                className="auto-restore-checkbox"
                checked={debugMode}
                onChange={onToggleDebugMode}
              />
              <span className="auto-restore-track" />
              <span className="auto-restore-text">Debug 模式</span>
            </label>
            <label className="settings-field">
              <span className="modal-label">主题</span>
              <select
                className="modal-input settings-theme-select"
                value={themeId}
                onChange={(event) => onThemeChange(event.target.value as ThemeId)}
              >
                {themes.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="settings-section qq-bot-settings">
            <div className="settings-section-header">
              <label className="auto-restore-label">
                <input
                  type="checkbox"
                  className="auto-restore-checkbox"
                  checked={qqConfig.enabled}
                  onChange={(event) => setQqField("enabled", event.target.checked)}
                />
                <span className="auto-restore-track" />
                <span className="auto-restore-text">QQ 机器人通知</span>
              </label>
              <span>{getQqStatusText(qqStatus)}</span>
            </div>

            {qqConfig.enabled && (
              <>
                <div className="settings-grid two">
                  <label className="settings-field">
                    <span className="modal-label">AppID</span>
                    <input
                      className="modal-input"
                      value={qqConfig.appId}
                      onChange={(event) => setQqField("appId", event.target.value)}
                      placeholder="QQ 机器人 AppID"
                    />
                  </label>
                  <label className="settings-field">
                    <span className="modal-label">目标 openid</span>
                    <input
                      className="modal-input"
                      value={qqConfig.targetOpenid}
                      onChange={(event) => setQqField("targetOpenid", event.target.value)}
                      placeholder="可先留空，收到私聊后自动使用"
                    />
                  </label>
                </div>

                <label className="settings-field">
                  <span className="modal-label">Client Secret</span>
                  <input
                    className="modal-input"
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    placeholder={qqConfig.clientSecretSet ? "已保存；留空表示不修改" : "QQ 机器人 Client Secret"}
                  />
                </label>

                <div className="settings-check-list">
                  {notifyStatusOptions.map((option) => (
                    <label className="modal-checkbox-field" key={option.value}>
                      <input
                        type="checkbox"
                        checked={qqConfig.notifyStatuses.includes(option.value)}
                        onChange={() => toggleNotifyStatus(option.value)}
                      />
                      {option.label}
                    </label>
                  ))}
                  <label className="modal-checkbox-field">
                    <input
                      type="checkbox"
                      checked={qqConfig.queueWhenUnavailable}
                      onChange={(event) => setQqField("queueWhenUnavailable", event.target.checked)}
                    />
                    回复窗口不可用时排队
                  </label>
                </div>

                <div className="qq-bot-status">
                  <span>队列 {qqStatus?.queuedCount ?? 0}</span>
                  <span>丢弃 {qqStatus?.droppedCount ?? 0}</span>
                  <span>最近唤醒 {formatStatusTime(qqStatus?.lastInboundAt)}</span>
                  <span>最近发送 {formatStatusTime(qqStatus?.lastSentAt)}</span>
                </div>
                {qqStatus?.targetOpenid && (
                  <div className="qq-bot-openid-display">
                    <span className="modal-label">当前 openid</span>
                    <code>{qqStatus.targetOpenid}</code>
                    <button
                      className="modal-button copy-openid-btn"
                      type="button"
                      title="复制 openid 到剪贴板"
                      onClick={() => {
                        void window.clipboardApi.writeText(qqStatus.targetOpenid ?? "");
                        setQqMessage("openid 已复制到剪贴板");
                      }}
                    >
                      复制
                    </button>
                  </div>
                )}
                {qqStatus?.lastError && <div className="hook-install-error">{qqStatus.lastError}</div>}
                {qqMessage && <div className="hook-install-note">{qqMessage}</div>}

                <div className="settings-actions">
                  <button className="modal-button" type="button" onClick={clearQqSecret} disabled={isSavingQq || !qqConfig.clientSecretSet}>
                    清除 Secret
                  </button>
                  <button className="modal-button" type="button" onClick={testQqNotification} disabled={isTestingQq || isSavingQq}>
                    {isTestingQq ? "测试中" : "测试发送"}
                  </button>
                  <button className="modal-button primary" type="button" onClick={saveQqConfig} disabled={isSavingQq || isTestingQq}>
                    {isSavingQq ? "保存中" : "保存 QQ 配置"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
        <div className="modal-footer">
          <button className="modal-button primary" type="button" onClick={onCancel}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
