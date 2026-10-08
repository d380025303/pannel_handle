import { OpenCodeRetryStatus } from "../../src/components/agents/OpenCodeRetryStatus";
import { CodeBuddyMcpAppContext } from "../../src/components/agents/CodeBuddyMcpApp";
import { useCodeBuddyApi } from "./useCodeBuddyApi";
import { graphicalInputPolicy } from "./GraphicalInputPolicy";
import { GraphicalUsage } from "./GraphicalUsage";
import { GraphicalIcon } from "./GraphicalIcon";
import { canSwitchMode, effortLabel, modelLabel, permissionLabel, providerLabel } from "./GraphicalPresentation";
import { QuickCommandPicker } from "./QuickCommandPicker";
import { useGraphicalSession, type GraphicalViewProps } from "./useGraphicalSession";
import { GraphicalTimeline } from "./GraphicalTimeline";
import { GraphicalComposer } from "./GraphicalComposer";
import { GraphicalActionSheet } from "./GraphicalActionSheet";

export function GraphicalView(props: GraphicalViewProps) {
  const { session, send, onGraphicalMessage, draft, setDraft } = props;
  const controller = useGraphicalSession(props);
  const remote = useCodeBuddyApi(controller);
  const { snapshot, isSending, error, activeSheet, setActiveSheet, switchingTo, moreButtonRef, runQuickCommand } = controller;
  if (!snapshot) return <section className="graphical-shell graphical-loading">正在加载图形会话…</section>;
  const inputPolicy = graphicalInputPolicy(snapshot, Boolean(controller.historyMutation || snapshot.provider === "opencode" && controller.codexPending));
  const openCodeBlocked = snapshot.provider === "opencode" && (controller.codexPending || controller.isSending || !!snapshot.pendingPlan || !!snapshot.approvals.length || !!snapshot.questions.length || ["running", "reconnecting"].includes(snapshot.acpAuth?.status || ""));
  const effectivePlan = snapshot.mode === "plan";
  const headerStatus = snapshot.provider === "opencode" && snapshot.acpAuth?.required ? "需要登录" : snapshot.questions.length ? "等待回答" : snapshot.approvals.length ? "待确认" : snapshot.busy ? "运行中" : "就绪";
  const headerState = headerStatus === "就绪" ? "ready" : headerStatus === "运行中" ? "running" : "attention";
  const hasModelControl = ["codex", "codebuddy", "opencode"].includes(snapshot.provider);
  const modeName = effectivePlan ? "Plan" : snapshot.provider === "codebuddy" ? snapshot.executionPermission === "fullAccess" ? "Full Access" : snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "模式" : snapshot.provider === "opencode" ? snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "Build" : "Exec";
  const context = snapshot.contextUsage;
  const contextPercent = context && context.size > 0 ? Math.min(100, Math.max(0, context.used / context.size * 100)) : null;
  return <CodeBuddyMcpAppContext.Provider value={{ sessionId: session.id, threadId: snapshot.threadId || "", api: remote.mcp,
    enabled: snapshot.provider === "codebuddy" && session.type === "windows" && Boolean(snapshot.threadId && snapshot.codeBuddyMobile),
    openLink: async url => { window.open(url, "_blank", "noopener,noreferrer"); },
    fillMessage: async (_itemId, content) => {
      if (content.some(part => part.type !== "text" && part.type !== "image")) throw new Error("仅支持文本和图片回填。");
      const images = content.filter(part => part.type === "image");
      if (controller.attachments.length + images.length > 10) throw new Error("最多附加 10 个文件。");
      const transfer = new DataTransfer();
      for (const [index, part] of images.entries()) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(part.mimeType || "") || !part.data || part.data.length > 14 * 1024 * 1024) throw new Error("图片格式或大小无效。");
        const bytes = Uint8Array.from(atob(part.data), char => char.charCodeAt(0));
        transfer.items.add(new File([bytes], `mcp-app-${index}.${part.mimeType!.split("/")[1]}`, { type: part.mimeType }));
      }
      if (images.length) controller.addFiles(transfer.files);
      const text = content.filter(part => part.type === "text").map(part => part.text || "").join("\n");
      setDraft(current => current ? `${current}\n${text}` : text);
    }
  }}><section className="graphical-shell">
    <header className="graphical-header">
      <div className="graphical-header-details">
        <div className="graphical-header-heading">
          <strong title={session.title}>{session.title}</strong>
          <span className="graphical-header-status" data-state={headerState}>{providerLabel(snapshot.provider)} · {headerStatus}</span>
        </div>
        <div className="graphical-current-config">
          {!hasModelControl && <span>模型：{modelLabel(snapshot)}</span>}
          {snapshot.provider === "codebuddy" && snapshot.modelSource === "native" && controller.buddyModelMetadata.filter(model => model.id === snapshot.acpOptions?.find(option => option.id === "model")?.currentValue).map(model => <span key={model.id}>{model.creditMultiplier ? `模型倍率：${model.creditMultiplier}` : ""}{model.promotions.map(promotion => ` · ${promotion.label}`).join("")}</span>)}
          <span>强度：{effortLabel(snapshot)}</span>
          {snapshot.provider === "codex" && permissionLabel(snapshot.executionPermission)
            && <span aria-label={`执行权限：${snapshot.permissionProfileId || permissionLabel(snapshot.executionPermission)}`}>{snapshot.permissionProfileId || permissionLabel(snapshot.executionPermission)}</span>}
          {["codex", "opencode"].includes(snapshot.provider) && snapshot.tokenUsage && <span>Token：{snapshot.tokenUsage.total.totalTokens.toLocaleString()}{snapshot.tokenUsage.modelContextWindow ? ` · 上下文 ${Math.min(100, snapshot.tokenUsage.last.totalTokens / snapshot.tokenUsage.modelContextWindow * 100).toFixed(1)}%` : ""}</span>}
          {["codex", "opencode"].includes(snapshot.provider) && snapshot.outputRateAvailable && <span>本轮输出：{snapshot.turnOutputTokens || 0} Token · {(snapshot.outputTokensPerSecond || 0).toFixed(1)} Token/s</span>}
          {snapshot.fastMode && <span>快速模式</span>}
          {context && contextPercent !== null && <span aria-label="上下文用量">上下文：{contextPercent.toFixed(1)}% · {context.used.toLocaleString()} / {context.size.toLocaleString()}</span>}
        </div>
        <div className="graphical-header-controls">
          {hasModelControl && <>
            <button type="button" disabled={openCodeBlocked || snapshot.provider === "opencode" && !canSwitchMode(snapshot, effectivePlan ? "default" : "plan") || snapshot.busy || snapshot.archived || !!snapshot.pendingPlan || controller.changingMode} title={modeName} onClick={() => controller.changeMode(effectivePlan ? "default" : "plan")}>{modeName}</button>
            <button type="button" disabled={openCodeBlocked || snapshot.busy || snapshot.archived || controller.changingModel} onClick={() => controller.setActiveSheet("model")} title={modelLabel(snapshot)}>{modelLabel(snapshot)}</button>
          </>}
          <button ref={moreButtonRef} type="button" className="graphical-more-button" aria-label="更多操作" aria-haspopup="dialog" aria-expanded={Boolean(controller.activeSheet)} onClick={() => controller.setActiveSheet("menu")}><GraphicalIcon name="more" /></button>
        </div>
      </div>
      {switchingTo && <span className="graphical-switching">切换中…</span>}
    </header>
    <GraphicalUsage sessionId={session.id} sessionType={session.type} snapshot={snapshot} send={send} onGraphicalMessage={onGraphicalMessage} />
    {snapshot.provider === "opencode" && <OpenCodeRetryStatus retry={snapshot.openCodeRetry} className="graphical-usage-status" />}
    {snapshot.permissionError && <div className="graphical-error" role="alert">{snapshot.permissionError}<button type="button" onClick={() => controller.setActiveSheet("configuration")}>配置与权限</button></div>}
    {snapshot.error && <div className="graphical-error" role="alert">{snapshot.error}</div>}
    {error && !activeSheet && <div className="graphical-error" role="alert">{error}</div>}
    <GraphicalTimeline key={`${session.id}:${snapshot.threadId}`} snapshot={snapshot} controller={controller} />
    <QuickCommandPicker commands={session.quickCommands || []} onSelect={runQuickCommand}
      disabled={command => !inputPolicy.canInput || (command.mode !== "write" && (!inputPolicy.canSubmit || isSending))} />
    {snapshot.provider === "codex" && snapshot.goal && <button className="graphical-goal-chip" title={snapshot.goal.objective} onClick={() => setActiveSheet("goal")}>目标：{snapshot.goal.objective} · {snapshot.goal.status}</button>}
    {snapshot.provider === "codebuddy" && snapshot.codeBuddyGoal?.active && <button className="graphical-goal-chip" onClick={() => setActiveSheet("buddy-goal")}>目标：{snapshot.codeBuddyGoal.active.condition} · {snapshot.codeBuddyGoal.active.paused ? "已暂停" : "进行中"}</button>}
    <GraphicalComposer snapshot={snapshot} controller={controller} draft={draft} setDraft={setDraft} />
    <GraphicalActionSheet snapshot={snapshot} session={session} controller={controller} graphicalMenuConfig={props.graphicalMenuConfig} />
  </section></CodeBuddyMcpAppContext.Provider>;
}
