import { useEffect, useRef, useState } from "react";
import type { CodexConfigurationView, CodexExecutionPermission } from "../../vite-env";

const labels: Record<string, string> = { readOnly: "只读", askApproval: "需要确认", fullAccess: "完全访问" };
const valueLabels: Record<string, string> = { model: "模型", model_provider: "模型提供方", model_reasoning_effort: "推理强度", approval_policy: "审批策略", sandbox_mode: "沙箱", service_tier: "服务等级", web_search: "网页搜索", features: "功能开关", permissions: "权限档", allowedApprovalPolicies: "允许的审批方式", allowedSandboxModes: "允许的沙箱模式", allowedApprovalsReviewers: "允许的审批审核方", allowedPermissionProfiles: "权限档限制", featureRequirements: "强制功能开关", network: "网络限制" };
function Values({ values }: { values: Record<string, unknown> }) {
  return <dl className="codex-configuration-values">{Object.entries(values).filter(([, value]) => value != null).map(([key, value]) => <div key={key}>
    <dt>{valueLabels[key] || key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
  </div>)}</dl>;
}
export function CodexConfigurationPanel({ sessionKey, locked, read, selectProfile, selectLegacy }: {
  sessionKey: string; locked: boolean;
  read: () => Promise<CodexConfigurationView>;
  selectProfile: (id: string) => Promise<unknown>;
  selectLegacy: (id: CodexExecutionPermission) => Promise<unknown>;
}) {
  const [view, setView] = useState<CodexConfigurationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const pending = useRef(false);
  const actions = useRef({ read, selectProfile, selectLegacy });
  actions.current = { read, selectProfile, selectLegacy };
  async function run(selection?: { profile: boolean; id: string }) {
    if (pending.current) return;
    pending.current = true;
    const requestId = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    try {
      if (selection) {
        if (selection.profile) await actions.current.selectProfile(selection.id);
        else await actions.current.selectLegacy(selection.id as CodexExecutionPermission);
        if (generation.current !== requestId) return;
        setNotice("已应用；有关联模板时，后续实例使用此默认权限。");
      }
      const result = await actions.current.read();
      if (generation.current === requestId) setView(result);
    } catch (cause) { if (generation.current === requestId) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation.current === requestId) { pending.current = false; setBusy(false); } }
  }
  useEffect(() => {
    setView(null); pending.current = false; void run();
    return () => { generation.current += 1; pending.current = false; };
  }, [sessionKey]);
  const disabled = busy || locked;
  return <section className="codex-configuration-panel" aria-label="Codex 配置与权限" aria-busy={busy}>
    <button type="button" className="modal-button" disabled={busy} onClick={() => void run()}>刷新配置</button>
    {busy && <p role="status">正在读取／应用…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {view && <>
      <p>工作区：{view.cwd}</p>
      {view.permissionError && <p role="alert">{view.permissionError}</p>}
      <h4>当前会话</h4>
      <p>模式：{view.runtime.mode} · 权限：{view.runtime.permissionProfileId || labels[view.runtime.executionPermission]}</p>
      <p>模型：{view.runtime.model || "未提供"} · 推理强度：{view.runtime.effort || "默认"}</p>
      <h4>磁盘有效配置</h4><p>以下为配置层合并结果，当前会话可另行覆盖。</p>
      {view.config?.status === "ready" && view.config.data ? <>
        <Values values={view.config.data.values} />
        <details><summary>配置层来源</summary>{view.config.data.layers.map((layer, index) => <div key={index}>
          <p>{layer.type || "未知来源"} {layer.path || ""}{layer.disabled ? "（未启用）" : ""}</p>
          <Values values={layer.values} />
        </div>)}</details>
      </> : <p>{view.config?.error || "有效配置未读取。"}</p>}
      <h4>管理员限制</h4>
      {view.requirements.status !== "ready" ? <p>{view.requirements.error || "无法读取管理员限制。"}</p>
        : view.requirements.data === null ? <p>未配置管理员限制。</p> : <Values values={view.requirements.data} />}
      <h4>执行权限</h4>
      <p>选择成功后保存到关联会话模板；其他已运行实例保持原权限。Plan 回合使用只读策略。</p>
      {view.legacy.map(option => <div key={option.id} className="codex-configuration-option">
        <button type="button" className="modal-button" disabled={disabled || !option.allowed} aria-pressed={!view.runtime.permissionProfileId && view.runtime.executionPermission === option.id}
          onClick={() => void run({ profile: false, id: option.id })}>{labels[option.id] || option.id}</button>
        {option.reason && <p>{option.reason}</p>}
      </div>)}
      <h4>命名权限档</h4>
      {view.profiles.status !== "ready" ? <p>{view.profiles.error || "无法读取权限档。"}</p>
        : !view.profiles.data?.length ? <p>没有可用的命名权限档。</p> : view.profiles.data.map(profile => <div key={profile.id} className="codex-configuration-option">
          <button type="button" className="modal-button" aria-pressed={view.runtime.permissionProfileId === profile.id} disabled={disabled || !profile.allowed}
            onClick={() => void run({ profile: true, id: profile.id })}>{profile.id}</button>
          {profile.description && <p>{profile.description}</p>}{profile.reason && <p>{profile.reason}</p>}
        </div>)}
      {locked && <p>请先完成当前回合或待处理操作，再切换权限。</p>}
    </>}
  </section>;
}
