import { GraphicalIcon } from "./GraphicalIcon";
import { canSwitchMode, graphicalProviders, modelLabel, modelOptions, permissionLabel, permissions, providerLabel } from "./GraphicalPresentation";
import { type useGraphicalSession } from "./useGraphicalSession";
import type { GraphicalSnapshot, RuntimeSession } from "./types";

type Controller = ReturnType<typeof useGraphicalSession>;
export function GraphicalActionSheet({ snapshot, session, controller }: {
  snapshot: GraphicalSnapshot; session: RuntimeSession; controller: Controller;
}) {
  const { activeSheet, setActiveSheet, selectedProvider, setSelectedProvider, error, setError,
    history, historyLoading, changingMode, changingModel, attachments, switchingTo, sheetRef,
    action, changeModel, addFiles, changeMode, changePermission, changeNativeMode, switchAgent,
    loadHistory, openHistory, isSending } = controller;
  if (!activeSheet) return null;
  const effectivePlan = snapshot.mode === "plan";
  const addFileDisabled = !snapshot.threadId || snapshot.archived || isSending || attachments.length >= 10
    || (snapshot.busy && snapshot.provider !== "codex");
  const modelDisabled = !modelOptions(snapshot).length || snapshot.busy || snapshot.archived || changingModel || attachments.length > 0;
  const agentDisabled = snapshot.busy || Boolean(snapshot.approvals.length || snapshot.questions.length || snapshot.pendingPlan || switchingTo);
  const currentModel = snapshot.provider === "codex" ? snapshot.model || snapshot.effectiveModel || ""
    : String(snapshot.acpOptions?.find(option => option.id === "model")?.currentValue || "");
  return (<div className="graphical-sheet-backdrop" onClick={() => setActiveSheet(null)}>
      <div ref={sheetRef} className="graphical-sheet" role="dialog" aria-modal="true"
        aria-label={activeSheet === "menu" ? "更多操作" : activeSheet === "agent" ? "切换 Agent"
          : activeSheet === "agent-confirm" ? "确认切换 Agent" : activeSheet === "model" ? "切换模型"
            : activeSheet === "permission" ? "执行权限" : activeSheet === "native-mode" ? "切换模式" : "历史对话"}
        tabIndex={-1} onClick={event => event.stopPropagation()}>
        <header><strong>{activeSheet === "menu" ? "更多操作" : activeSheet === "agent" ? "切换 Agent"
          : activeSheet === "agent-confirm" ? "确认切换 Agent" : activeSheet === "model" ? "切换模型"
            : activeSheet === "permission" ? "执行权限" : activeSheet === "native-mode" ? "切换模式" : "历史对话"}</strong>
          <button type="button" className="graphical-sheet-close" aria-label="关闭弹层" onClick={() => setActiveSheet(null)}><GraphicalIcon name="close" /></button></header>
        {error && <p className="graphical-sheet-error" role="alert">{error}</p>}
        {activeSheet === "menu" && <div className="graphical-sheet-list">
          {(snapshot.provider === "codex" || snapshot.provider === "codebuddy" || snapshot.provider === "claude") && <div className="graphical-menu-mode" role="group" aria-label="会话模式">
            <span>会话模式</span>
            <div className="graphical-mode-switch">
              <button type="button" aria-pressed={effectivePlan}
                disabled={snapshot.busy || snapshot.archived || changingMode || !!snapshot.pendingPlan || !canSwitchMode(snapshot, "plan")}
                onClick={() => changeMode("plan")}><GraphicalIcon name="mode" />Plan</button>
              <button type="button" aria-pressed={snapshot.provider === "codebuddy" ? snapshot.executionPermission === "fullAccess" : snapshot.mode === "default"}
                disabled={snapshot.busy || snapshot.archived || changingMode || !!snapshot.pendingPlan || !canSwitchMode(snapshot, "default")}
                onClick={() => changeMode("default")}><GraphicalIcon name="mode" />{snapshot.provider === "codebuddy" ? "Full Access" : "Exec"}</button>
            </div>
          </div>}
          {snapshot.provider === "codex"
            ? <button type="button" disabled={!snapshot.threadId || snapshot.busy || snapshot.archived || changingMode || snapshot.capabilities?.permissions === false}
              onClick={() => { setError(""); setActiveSheet("permission"); }}><span><GraphicalIcon name="shield" />执行权限</span><small>{permissionLabel(snapshot.executionPermission) || "未提供"}</small></button>
            : snapshot.nativeModes?.length ? <button type="button" disabled={!snapshot.threadId || snapshot.busy || snapshot.archived || changingMode}
              onClick={() => { setError(""); setActiveSheet("native-mode"); }}><span><GraphicalIcon name="mode" />切换模式</span><small>{snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "未提供"}</small></button> : null}
          <button type="button" disabled={modelDisabled} onClick={() => setActiveSheet("model")}><span><GraphicalIcon name="model" />切换模型</span><small>{modelLabel(snapshot)}</small></button>
          <button type="button" disabled={agentDisabled} onClick={() => setActiveSheet("agent")}><span><GraphicalIcon name="agent" />切换 Agent</span><small>{providerLabel(snapshot.provider)}</small></button>
          <button type="button" disabled={snapshot.busy || snapshot.capabilities?.history === false} onClick={openHistory}><span><GraphicalIcon name="history" />历史记录</span><small>查看并恢复对话</small></button>
          <button type="button" disabled={snapshot.busy} onClick={() => { if (action({ type: "graphical.new-thread" })) setActiveSheet(null); }}><span><GraphicalIcon name="new" />新对话</span></button>
          <label className={`graphical-file-picker${addFileDisabled ? " is-disabled" : ""}`}>
            <span><GraphicalIcon name="file" />添加文件</span><small>{attachments.length}/10</small>
            <input aria-label="添加文件" type="file" multiple disabled={addFileDisabled}
              onChange={event => {
                if (event.currentTarget.files?.length) {
                  addFiles(event.currentTarget.files);
                  setActiveSheet(null);
                }
                event.currentTarget.value = "";
              }} />
          </label>
        </div>}
        {activeSheet === "agent" && <div className="graphical-sheet-list">
          {graphicalProviders.filter(provider => session.type !== "ssh" || provider !== "gemini" && provider !== "grok").map(provider => <button type="button" key={provider} disabled={agentDisabled || provider === snapshot.provider}
            aria-pressed={provider === snapshot.provider} onClick={() => { setSelectedProvider(provider); setActiveSheet("agent-confirm"); }}>
            <span>{providerLabel(provider)}</span>{provider === snapshot.provider && <small>当前使用</small>}
          </button>)}
        </div>}
        {activeSheet === "agent-confirm" && selectedProvider && <div className="graphical-sheet-confirm">
          <p>切换到 {providerLabel(selectedProvider)} 会关闭当前运行会话并启动新会话，是否继续？</p>
          <div><button type="button" onClick={() => setActiveSheet("agent")}><GraphicalIcon name="back" />返回</button>
            <button type="button" className="primary" disabled={agentDisabled} onClick={() => switchAgent(selectedProvider)}><GraphicalIcon name="check" />确认切换</button></div>
        </div>}
        {activeSheet === "model" && <div className="graphical-sheet-list">
          {modelOptions(snapshot).map(option => <button type="button" key={option.value} disabled={modelDisabled || option.value === currentModel}
            aria-pressed={option.value === currentModel} onClick={() => changeModel(option.value)}>
            <span>{option.name}</span>{option.value === currentModel && <small>当前使用</small>}
          </button>)}
        </div>}
        {activeSheet === "permission" && <div className="graphical-sheet-list">
          {permissions.map(option => <button type="button" key={option.value} aria-pressed={snapshot.executionPermission === option.value}
            disabled={changingMode || snapshot.busy || snapshot.archived || snapshot.executionPermission === option.value
              || Boolean(snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(option.value))}
            onClick={() => changePermission(option.value)}><span>{option.name}</span><small>{option.description}</small></button>)}
        </div>}
        {activeSheet === "native-mode" && <div className="graphical-sheet-list">
          {snapshot.nativeModes?.map(mode => <button type="button" key={mode.id} aria-pressed={snapshot.nativeMode === mode.id}
            disabled={changingMode || snapshot.busy || snapshot.archived || snapshot.nativeMode === mode.id}
            onClick={() => changeNativeMode(mode.id)}><span>{mode.name || mode.id}</span>{snapshot.nativeMode === mode.id && <small>当前使用</small>}</button>)}
        </div>}
        {activeSheet === "history" && <div className="graphical-sheet-list graphical-history-list">
          {history?.data.map(thread => <button type="button" key={thread.id} disabled={snapshot.busy || thread.archived || thread.id === snapshot.threadId}
            onClick={() => { if (action({ type: "graphical.resume", targetThreadId: thread.id })) setActiveSheet(null); }}>
            <span>{thread.title}</span><small>{new Date(thread.updatedAt * 1000).toLocaleString()}{thread.archived ? " · 已归档" : ""}</small>
          </button>)}
          {historyLoading && <p role="status">正在加载…</p>}
          {!historyLoading && history?.data.length === 0 && <p>暂无历史对话</p>}
          {history?.nextCursor && <button type="button" disabled={historyLoading} onClick={() => loadHistory(history.nextCursor)}>加载更多</button>}
        </div>}
      </div>
    </div>
  );
}
