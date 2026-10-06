import { CodeBuddyPanel } from "./CodeBuddyPanel";
import { copyMobileText } from "./clipboard";
import { CodexAdvancedSheet, codexSheetTitles } from "./CodexAdvancedSheet";
import type { CodexSheet } from "./useGraphicalSession";
import { GraphicalIcon } from "./GraphicalIcon";
import { canSwitchMode, effortLabel, openCodeEffortOption, graphicalProviders, modelLabel, modelOptions, permissionLabel, permissions, providerLabel } from "./GraphicalPresentation";
import { type useGraphicalSession } from "./useGraphicalSession";
import type { GraphicalSnapshot, RuntimeSession } from "./types";

type Controller = ReturnType<typeof useGraphicalSession>;
export function GraphicalActionSheet({ snapshot, session, controller }: {
  snapshot: GraphicalSnapshot; session: RuntimeSession; controller: Controller;
}) {
  const { activeSheet, setActiveSheet, selectedProvider, setSelectedProvider, error, setError,
    history, historyLoading, changingMode, changingPermission, changingModel, changingEffort, attachments, switchingTo, sheetRef,
    action, changeModel, changeEffort, addFiles, changeMode, changePermission, changeNativeMode, switchAgent,
    loadHistory, openHistory, isSending, historyMutation, mutateHistory } = controller;
  if (!activeSheet) return null;
  if (snapshot.provider === "codebuddy" && activeSheet.startsWith("buddy-")) return <CodeBuddyPanel key={`${session.id}:${snapshot.threadId}`} controller={controller} />;
  const advanced = activeSheet in codexSheetTitles ? activeSheet as CodexSheet : null;
  const title = advanced ? codexSheetTitles[advanced] : null;
  const effectivePlan = snapshot.mode === "plan";
  const addFileDisabled = !snapshot.threadId || snapshot.archived || isSending || attachments.length >= 10
    || (snapshot.busy && snapshot.provider !== "codex");
  const modelDisabled = (!modelOptions(snapshot).length && !(["codex", "codebuddy"].includes(snapshot.provider) && session.type !== "ssh")) || snapshot.busy || snapshot.archived || changingModel || changingEffort || attachments.length > 0 || Boolean(historyMutation);
  const effortOption = openCodeEffortOption(snapshot);
  const effortDisabled = !snapshot.threadId || !effortOption || snapshot.busy || snapshot.archived || isSending
    || changingModel || changingEffort || attachments.length > 0 || Boolean(historyMutation || snapshot.pendingPlan)
    || snapshot.approvals.length > 0 || snapshot.questions.length > 0;
  const agentDisabled = snapshot.busy || Boolean(snapshot.approvals.length || snapshot.questions.length || snapshot.pendingPlan || switchingTo || historyMutation);
  const historyDisabled = controller.codexPending || snapshot.busy || isSending || Boolean(historyMutation || snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions.length)
    || attachments.some(item => item.status === "uploading");
  const currentModel = snapshot.provider === "codex" ? snapshot.model || snapshot.effectiveModel || ""
    : snapshot.provider === "codebuddy" && snapshot.modelSource && snapshot.modelSource !== "native" ? "" : String(snapshot.acpOptions?.find(option => option.id === "model")?.currentValue || "");
  return (<div className="graphical-sheet-backdrop" onClick={() => setActiveSheet(null)}>
      <div ref={sheetRef} className="graphical-sheet" role="dialog" aria-modal="true"
        aria-label={title || (activeSheet === "menu" ? "更多操作" : activeSheet === "agent" ? "切换 Agent"
          : activeSheet === "agent-confirm" ? "确认切换 Agent" : activeSheet === "model" ? "切换模型"
            : activeSheet === "effort" ? "思考强度" : activeSheet === "permission" ? "执行权限" : activeSheet === "native-mode" ? "切换模式" : "历史对话")}
        tabIndex={-1} onClick={event => event.stopPropagation()}>
        <header><strong>{title || (activeSheet === "menu" ? "更多操作" : activeSheet === "agent" ? "切换 Agent"
          : activeSheet === "agent-confirm" ? "确认切换 Agent" : activeSheet === "model" ? "切换模型"
            : activeSheet === "effort" ? "思考强度" : activeSheet === "permission" ? "执行权限" : activeSheet === "native-mode" ? "切换模式" : "历史对话")}</strong>
          <button type="button" className="graphical-sheet-close" aria-label="关闭弹层" onClick={() => setActiveSheet(null)}><GraphicalIcon name="close" /></button></header>
        {advanced && <CodexAdvancedSheet key={`${advanced}:${snapshot.threadId}`} sheet={advanced} snapshot={snapshot} controller={controller} />}
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
            ? <button type="button"
              onClick={() => { setError(""); setActiveSheet("permission"); }}><span><GraphicalIcon name="shield" />执行权限</span><small>{permissionLabel(snapshot.executionPermission) || "未提供"}</small></button>
            : snapshot.nativeModes?.length ? <button type="button" disabled={!snapshot.threadId || snapshot.busy || snapshot.archived || changingMode}
              onClick={() => { setError(""); setActiveSheet("native-mode"); }}><span><GraphicalIcon name="mode" />切换模式</span><small>{snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "未提供"}</small></button> : null}
          <button type="button" disabled={modelDisabled} onClick={() => setActiveSheet("model")}><span><GraphicalIcon name="model" />切换模型</span><small>{modelLabel(snapshot)}</small></button>
          {snapshot.provider === "codebuddy" && snapshot.codeBuddyMobile && <>
            <button onClick={() => setActiveSheet("buddy-config")} disabled={!snapshot.threadId}>会话配置 · 主 Agent / Multitask / 上下文</button>
            <button onClick={() => setActiveSheet("buddy-goal")} disabled={!snapshot.threadId}>目标管理</button>
            {snapshot.capabilities?.sideQuestion && <button onClick={() => setActiveSheet("buddy-side")} disabled={!snapshot.threadId}>独立旁问</button>}
            <button onClick={() => setActiveSheet("buddy-version")} disabled={!snapshot.threadId}>CLI 版本</button>
            {session.type === "windows" && <><button onClick={() => setActiveSheet("buddy-plugins")}>插件管理</button><button onClick={() => setActiveSheet("buddy-tasks")}>定时任务</button><button onClick={() => setActiveSheet("buddy-jobs")}>后台智能体</button><button onClick={() => setActiveSheet("buddy-mcp")}>MCP 管理</button></>}
          </>}
          {snapshot.provider === "codebuddy" && !snapshot.codeBuddyMobile && <p>更新桌面宿主后可使用完整 CodeBuddy 功能。</p>}
          {snapshot.provider === "codex" && <>
            {snapshot.backend === "openai" && <button type="button" disabled={controller.codexPending || !snapshot.threadId || snapshot.busy || snapshot.archived} onClick={() => { void controller.codexRequest("fast-mode", { enabled: !snapshot.fastMode }).catch(cause => setError(String(cause))); }}><span>快速模式</span><small>{snapshot.fastMode ? "开启" : "关闭"}</small></button>}
            {(Object.entries(codexSheetTitles) as Array<[CodexSheet, string]>).filter(([key]) => key !== "sandbox" || session.type === "windows" && snapshot.windowsSandboxSetup?.available).map(([key, label]) => <button type="button" key={key} disabled={!snapshot.threadId || (key === "review" || key === "workspace") && (snapshot.busy || snapshot.archived)} onClick={() => { setError(""); setActiveSheet(key); }}>{label}</button>)}
            <button type="button" disabled={!snapshot.threadId || snapshot.busy || snapshot.archived || isSending || snapshot.compacting} onClick={() => { void controller.codexRequest("compact").then(() => setActiveSheet(null)).catch(cause => setError(String(cause))); }}>压缩对话</button>
          </>}
          {effortOption && <button type="button" disabled={effortDisabled} onClick={() => setActiveSheet("effort")}><span><GraphicalIcon name="mode" />思考强度</span><small>{effortLabel(snapshot)}</small></button>}
          <button type="button" disabled={agentDisabled} onClick={() => setActiveSheet("agent")}><span><GraphicalIcon name="agent" />切换 Agent</span><small>{providerLabel(snapshot.provider)}</small></button>
          <button type="button" disabled={snapshot.busy || snapshot.capabilities?.history === false} onClick={openHistory}><span><GraphicalIcon name="history" />历史记录</span><small>查看并恢复对话</small></button>
          <button type="button" disabled={snapshot.busy || Boolean(historyMutation)} onClick={() => { if (action({ type: "graphical.new-thread" })) setActiveSheet(null); }}><span><GraphicalIcon name="new" />新对话</span></button>
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
          {snapshot.provider === "codex" && session.type !== "ssh" && <>
            {snapshot.backend !== "openai" && <button disabled={snapshot.busy || snapshot.archived || controller.codexPending} onClick={() => { if (window.confirm("切换到 OpenAI 原生模型将重启图形会话，是否继续？")) void controller.codexRequest("model-source", { source: "native" }).catch(cause => setError(String(cause))); }}>OpenAI · 原生模型</button>}
            {controller.serviceModels.map(model => <button key={`${model.source}:${model.id}`} disabled={snapshot.busy || snapshot.archived || controller.codexPending || attachments.length > 0} onClick={() => { if (window.confirm(`切换到 ${model.name} 将重启图形会话，是否继续？`)) void controller.codexRequest("model-source", { source: model.source, modelId: model.id }).catch(cause => setError(String(cause))); }}>{model.source} · {model.name}</button>)}
          </>}
          {snapshot.provider === "codebuddy" && snapshot.codeBuddyMobile && session.type !== "ssh" && <>
            {snapshot.modelSource !== "native" && <button disabled={modelDisabled || controller.codexPending} onClick={() => { if (window.confirm("切换原生模型将重启会话，是否继续？")) void controller.buddyRequest("model-source", { source: "native" }).catch(cause => setError(String(cause))); }}>原生模型</button>}
            {controller.serviceModels.map(model => <button key={`${model.source}:${model.id}`} disabled={modelDisabled || controller.codexPending || snapshot.modelSource === model.source && snapshot.serviceModelId === model.id} aria-pressed={snapshot.modelSource === model.source && snapshot.serviceModelId === model.id} onClick={() => { if (window.confirm(`切换到 ${model.name} 将重启图形会话，是否继续？`)) void controller.buddyRequest("model-source", { source: model.source, modelId: model.id }).catch(cause => setError(String(cause))); }}>{model.source} · {model.name}</button>)}
          </>}
          {modelOptions(snapshot).map(option => <button type="button" key={option.value} disabled={modelDisabled || option.value === currentModel}
            aria-pressed={option.value === currentModel} onClick={() => { if (snapshot.provider === "codebuddy" && snapshot.modelSource && snapshot.modelSource !== "native") { if (window.confirm("切换原生模型将重启会话，是否继续？")) void controller.buddyRequest("model-source", { source: "native", modelId: option.value }).catch(cause => setError(String(cause))); } else changeModel(option.value); }}>
            <span>{option.name}{snapshot.provider === "codebuddy" && controller.buddyModelMetadata.filter(model => model.id === option.value).map(model => <small key={model.id}>{model.creditMultiplier ? ` · ${model.creditMultiplier} 倍` : ""}{model.promotions.map(promotion => ` · ${promotion.label}`).join("")}</small>)}</span>{option.value === currentModel && <small>当前使用</small>}
          </button>)}
        </div>}
        {activeSheet === "effort" && <div className="graphical-sheet-list">
          {effortOption?.options.map(option => <button type="button" key={option.value}
            disabled={effortDisabled || option.value === effortOption.currentValue}
            aria-pressed={option.value === effortOption.currentValue} onClick={() => changeEffort(option.value)}>
            <span>{option.name}</span>{option.description && <small>{option.description}</small>}
            {option.value === effortOption.currentValue && <small>当前使用</small>}
          </button>)}
        </div>}
        {activeSheet === "permission" && <div className="graphical-sheet-list">
          {permissions.map(option => <button type="button" key={option.value} aria-pressed={snapshot.executionPermission === option.value}
            disabled={changingPermission || snapshot.busy
              || Boolean(snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(option.value))}
            onClick={() => changePermission(option.value)}><span>{option.name}</span><small>{option.description}</small></button>)}
        </div>}
        {activeSheet === "native-mode" && <div className="graphical-sheet-list">
          {snapshot.nativeModes?.map(mode => <button type="button" key={mode.id} aria-pressed={snapshot.nativeMode === mode.id}
            disabled={changingMode || snapshot.busy || snapshot.archived || snapshot.nativeMode === mode.id}
            onClick={() => changeNativeMode(mode.id)}><span>{mode.name || mode.id}</span>{mode.description && <small>{mode.description}</small>}{snapshot.nativeMode === mode.id && <small>当前使用</small>}</button>)}
        </div>}
        {activeSheet === "history" && <div className="graphical-sheet-list graphical-history-list">
          {snapshot.provider === "codex" && <><div className="graphical-actions" role="tablist"><button role="tab" aria-selected={!controller.historyArchived} disabled={historyLoading} onClick={() => controller.loadHistory(null, false)}>进行中</button><button role="tab" aria-selected={controller.historyArchived} disabled={historyLoading} onClick={() => controller.loadHistory(null, true)}>已归档</button></div>
            <input aria-label="搜索历史会话" placeholder="搜索历史会话" value={controller.historyQuery} onChange={event => controller.setHistoryQuery(event.target.value)} />
          </>}
          {error && <button type="button" disabled={historyLoading} onClick={() => loadHistory()}>重试加载历史</button>}
          {history?.data.filter(thread => thread.title.toLocaleLowerCase().includes(controller.historyQuery.toLocaleLowerCase())).map(thread => <div className="graphical-history-row" key={thread.id}><button type="button" disabled={historyDisabled || thread.archived || thread.id === snapshot.threadId}
            onClick={() => { if (action({ type: "graphical.resume", targetThreadId: thread.id })) setActiveSheet(null); }}>
            <span>{thread.isPinned ? "置顶 · " : ""}{thread.title}</span><small>{new Date(thread.updatedAt * 1000).toLocaleString()}{thread.archived ? " · 已归档" : ""}</small>
          </button>
            {snapshot.provider === "codebuddy" && <div className="graphical-history-actions"><button onClick={() => void copyMobileText(thread.id).catch(cause => setError(String(cause)))}>复制会话 ID</button>{snapshot.codeBuddyMobile && <button disabled={historyDisabled || controller.codexPending} onClick={() => { const name = window.prompt("会话名称", thread.title); if (name?.trim()) void controller.buddyRequest("history.rename", { targetThreadId: thread.id, name }).then(() => loadHistory()).catch(cause => setError(String(cause))); }}>重命名</button>}</div>}
            {snapshot.provider === "codex" && <div className="graphical-history-actions">
              <button disabled={historyDisabled} onClick={() => { void copyMobileText(thread.id).catch(cause => setError(String(cause))); }}>复制 ID</button>
              <button disabled={historyDisabled} onClick={() => { void controller.codexRequest<{ text: string } | null>("history.initial", { targetThreadId: thread.id }).then(value => copyMobileText(value?.text || "")).catch(cause => setError(String(cause))); }}>复制首条输入</button>
              <button disabled={historyDisabled} onClick={() => { const name = window.prompt("重命名会话", thread.title); if (name?.trim()) void controller.codexRequest("history.rename", { targetThreadId: thread.id, name: name.trim() }).then(() => loadHistory()).catch(cause => setError(String(cause))); }}>重命名</button>
              <button disabled={historyDisabled} onClick={() => { void controller.codexRequest("history.pin", { targetThreadId: thread.id, isPinned: !thread.isPinned }).then(() => loadHistory()).catch(cause => setError(String(cause))); }}>{thread.isPinned ? "取消置顶" : "置顶"}</button>
              {!thread.archived && <button disabled={historyDisabled} onClick={() => { void controller.codexRequest("history.fork", { targetThreadId: thread.id }).then(() => setActiveSheet(null)).catch(cause => setError(String(cause))); }}>分叉</button>}
              <button disabled={historyDisabled} onClick={() => { void controller.codexRequest(thread.archived ? "history.unarchive" : "history.archive", { targetThreadId: thread.id }).then(() => loadHistory()).catch(cause => setError(String(cause))); }}>{thread.archived ? "恢复归档" : "归档"}</button>
            </div>}
            {snapshot.provider === "opencode" && <div className="graphical-history-actions">
              {snapshot.capabilities?.forkHistory && <button type="button" disabled={historyDisabled} onClick={() => mutateHistory(thread.id, "fork")}>分叉</button>}
              {snapshot.capabilities?.deleteHistory && <button type="button" disabled={historyDisabled || thread.id === snapshot.threadId}
                title={thread.id === snapshot.threadId ? "请先切换到其他对话再删除" : undefined}
                onClick={() => mutateHistory(thread.id, "delete")}>删除</button>}
              {historyMutation === thread.id && <span role="status">正在处理…</span>}
            </div>}
          </div>)}
          {historyLoading && <p role="status">正在加载…</p>}
          {!historyLoading && history?.data.length === 0 && <p>暂无历史对话</p>}
          {history?.nextCursor && <button type="button" disabled={historyLoading} onClick={() => loadHistory(history.nextCursor)}>加载更多</button>}
        </div>}
      </div>
    </div>
  );
}
