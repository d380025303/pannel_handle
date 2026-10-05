import { copyMobileText } from "./clipboard";
import { useState } from "react";
import { McpElicitationCard } from "../../src/components/agents/GraphicalInteractionCards";
import { Check, Circle, Paperclip } from "lucide-react";
import { MarkdownBlock } from "../../src/components/shared/MarkdownBlock";
import { GraphicalIcon } from "./GraphicalIcon";
import { GraphicalQuestionCard } from "./GraphicalQuestionCard";
import { groupTimeline, openCodePlanReplyId, providerLabel, ToolItem, toolStatus } from "./GraphicalPresentation";
import { type useGraphicalSession } from "./useGraphicalSession";
import type { GraphicalSnapshot } from "./types";

type Controller = ReturnType<typeof useGraphicalSession>;
export function GraphicalTimeline({ snapshot, controller }: { snapshot: GraphicalSnapshot; controller: Controller }) {
  const { expandedGroupId, setExpandedGroupId, changingMode, scrollRef, action, executeOpenCodePlan } = controller;
  const [preview, setPreview] = useState<{ kind: string; dataUrl?: string; text?: string } | null>(null);
  const copy = (text: string) => { void copyMobileText(text).catch(cause => controller.setError(String(cause))); };
  const fail = (cause: unknown) => controller.setError(cause instanceof Error ? cause.message : String(cause));
  const openCodePlanItemId = openCodePlanReplyId(snapshot);
  const openCodeBuildMode = snapshot.nativeModes?.find(mode => mode.id.toLowerCase() === "build");
  return (    <div className="graphical-timeline" ref={scrollRef}>
      {preview && <div className="graphical-card"><button type="button" onClick={() => setPreview(null)}>关闭附件预览</button>{preview.kind === "image" ? <img className="graphical-preview-image" src={preview.dataUrl} alt="会话附件" /> : <pre>{preview.text || (preview.kind === "too_large" ? "附件过大，无法预览" : "此附件不支持预览")}</pre>}</div>}
      {snapshot.items.length === 0 && <p className="graphical-empty">向 {providerLabel(snapshot.provider)} 发送消息以开始对话。</p>}
      {groupTimeline(snapshot.items).map(entry => {
        if (entry.kind === "tools") {
          const groupId = entry.items[0].id;
          const expanded = expandedGroupId === groupId;
          const status = toolStatus(entry.items);
          return <section className="graphical-tool-group" data-status={status} key={groupId}>
            <button type="button" className="graphical-tool-group-toggle" aria-expanded={expanded}
              onClick={() => setExpandedGroupId(current => current === groupId ? null : groupId)}>
              <span className="graphical-tool-group-chevron"><GraphicalIcon name="chevron" /></span>
              <strong>工具调用 · {entry.items.length} 项</strong><span>{status}</span>
            </button>
            {expanded && <div className="graphical-tool-list">{entry.items.map(item => <ToolItem item={item} codeBuddy={snapshot.provider === "codebuddy"} key={item.id} />)}</div>}
          </section>;
        }
        const item = entry.item;
        if (item.type === "userMessage" || item.type === "agentMessage")
          return <article className={`graphical-message ${item.type}`} key={item.id}>
            <div className="graphical-markdown"><MarkdownBlock content={item.text || ""} onCopyCode={copy} /></div>
            {item.attachments?.length ? <div className="graphical-attachment-history">{item.attachments.map((file, index) => <button type="button" key={index} disabled={!file.path} onClick={() => { void controller.codexRequest<{ kind: string; dataUrl?: string; text?: string }>("attachment-preview", { path: file.path }).then(setPreview).catch(fail); }}><Paperclip aria-hidden="true" />{file.name}</button>)}</div> : null}
            {snapshot.provider === "codex" && <div className="graphical-message-actions"><button type="button" onClick={() => copy(item.text || "")}>复制消息</button>{item.turnId && <button type="button" disabled={snapshot.busy || snapshot.archived || controller.isSending} onClick={() => { void controller.codexRequest("fork-turn", { turnId: item.turnId }).then(() => controller.setError("")).catch(fail); }}>分叉到新会话</button>}</div>}
            {openCodePlanItemId === item.id && openCodeBuildMode && <div className="graphical-actions">
              <button type="button" className="primary" disabled={changingMode} onClick={() => executeOpenCodePlan(item.id)}>执行计划</button>
            </div>}</article>;
        if (item.type === "reasoning" || item.type === "collabAgentToolCall" || item.type === "contextCompaction" || item.type === "enteredReviewMode" || item.type === "exitedReviewMode") return <details className="graphical-card" key={item.id}><summary>{item.type === "reasoning" ? "思考过程" : item.type === "collabAgentToolCall" ? "子 Agent" : item.type === "contextCompaction" ? "上下文压缩" : "代码审查"}</summary><pre>{item.text || item.summary?.map(value => typeof value === "string" ? value : value.text || "").join("\n") || item.prompt || item.agentStatus || "状态已更新"}</pre></details>;
        if (item.type === "questionAnswer") return <article className="graphical-card" key={item.id}><strong>已回答问题</strong>{item.questions?.map(value => <p key={value.id}>{value.question}：{value.answers.join("、")}</p>)}</article>;
        if (item.type === "plan" || item.type === "turnPlan") return <article className="graphical-card" key={item.id}><strong>计划</strong><p>{item.text}</p>{item.plan?.map((step, index) => <p className="graphical-plan-step" key={index}>{step.status === "completed" ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}<span>{step.step}</span></p>)}
          {openCodePlanItemId === item.id && openCodeBuildMode && <div className="graphical-actions">
            <button type="button" className="primary" disabled={changingMode} onClick={() => executeOpenCodePlan(item.id)}>执行计划</button>
          </div>}</article>;
        if (item.type === "turnError") return <article className="graphical-card" role="alert" key={item.id}><strong>运行错误</strong><p>{item.text}</p></article>;
        return <article className="graphical-card" key={item.id}><strong>后台任务汇总</strong></article>;
      })}
      {snapshot.provider === "codex" && <>
        {snapshot.turnDiffs?.map(diff => <details className="graphical-card" key={diff.turnId}><summary>代码差异</summary><button type="button" onClick={() => copy(diff.diff)}>复制差异</button><pre>{diff.diff}</pre></details>)}
        {snapshot.subAgents && <section className="graphical-card"><div className="graphical-actions"><strong>子 Agent</strong><button disabled={snapshot.subAgents.loading} onClick={() => { void controller.codexRequest("subagents").catch(fail); }}>刷新</button><button onClick={() => { void controller.codexRequest("subagent-view", { expanded: !snapshot.subAgents?.expanded }).catch(fail); }}>{snapshot.subAgents.expanded ? "收起" : "展开"}</button></div>
          {snapshot.subAgents.error && <p role="alert">{snapshot.subAgents.error}</p>}{snapshot.subAgents.warning && <p>{snapshot.subAgents.warning}</p>}
          {snapshot.subAgents.expanded && snapshot.subAgents.members.map(member => <details key={member.threadId}><summary onClick={() => { void controller.codexRequest("subagent-view", { expanded: true, targetThreadId: member.threadId }).catch(fail); }}>{member.name} · {member.role} · {member.status}</summary><p>{member.task}</p>{member.loading && <p>正在加载…</p>}{member.error && <p role="alert">{member.error}</p>}{member.items.map(item => <article key={item.id}><MarkdownBlock content={item.text || item.output || item.command || ""} onCopyCode={copy} /></article>)}</details>)}
        </section>}
        {snapshot.elicitations?.map(request => <McpElicitationCard key={request.requestId} sessionId="mobile" request={request}
          onRespond={async (action, content) => { await controller.codexRequest("elicitation", { requestId: request.requestId, action, content }); }}
          onOpenUrl={async url => { if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("链接无效。"); window.open(url, "_blank", "noopener,noreferrer"); }} />)}
      </>}
      {snapshot.provider === "codex" && snapshot.diagnostics?.map(event => <details className="graphical-card graphical-diagnostic" key={event.id}>
        <summary><strong>运行错误</strong>{event.message}</summary>
        {(event.kind || event.httpStatusCode) && <p>{event.kind || "Codex 错误"}{event.httpStatusCode ? ` · HTTP ${event.httpStatusCode}` : ""}</p>}
        {event.additionalDetails != null && <pre>{typeof event.additionalDetails === "string" ? event.additionalDetails : JSON.stringify(event.additionalDetails, null, 2)}</pre>}
      </details>)}
      {snapshot.pendingPlan && <article className="graphical-card"><strong>确认执行计划</strong><div className="graphical-actions">
        <button type="button" onClick={() => action({ type: "graphical.plan", itemId: snapshot.pendingPlan!.itemId, execute: false })}><GraphicalIcon name="back" />{snapshot.provider === "codebuddy" ? "继续修改" : "暂不执行"}</button>
        <button type="button" className="primary" onClick={() => action({ type: "graphical.plan", itemId: snapshot.pendingPlan!.itemId, execute: true })}><GraphicalIcon name="check" />执行计划</button>
      </div></article>}
      {snapshot.approvals.map(approval => <article className="graphical-card" key={approval.requestId}>
        <strong>{approval.params.networkApprovalContext ? "网络访问确认" : approval.method.includes("fileChange") ? "文件修改确认" : "操作确认"}</strong>
        <p>{approval.params.reason || approval.params.command || approval.method}</p>
        {approval.params.cwd && <small>{approval.params.cwd}</small>}
        {approval.params.networkApprovalContext && <p>{approval.params.networkApprovalContext.protocol}://{approval.params.networkApprovalContext.host}{approval.params.networkApprovalContext.port ? `:${approval.params.networkApprovalContext.port}` : ""}</p>}
        {approval.params.permissions && <pre>{JSON.stringify(approval.params.permissions, null, 2)}</pre>}
        {approval.params.grantRoot && <p>授权目录：{approval.params.grantRoot}</p>}
        {approval.params.changes != null && <pre>{JSON.stringify(approval.params.changes, null, 2)}</pre>}
        {approval.params.choices?.length ? <div className="graphical-actions">{approval.params.choices.map(choice =>
          <button type="button" key={choice.id} onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: choice.id })}>{choice.label}</button>)}</div>
          : snapshot.provider === "codex" ? <div className="graphical-actions">{[ ["decline", "拒绝"], ["cancel", "取消并停止本回合"], ["accept", approval.method === "item/permissions/requestApproval" ? "本回合允许" : "批准一次"], ["acceptForSession", "本会话允许"], ["acceptWithExecpolicyAmendment", "批准并记住规则"] ].filter(([decision]) => (approval.method !== "item/permissions/requestApproval" || ["accept", "acceptForSession", "decline"].includes(decision)) && (decision !== "acceptWithExecpolicyAmendment" || approval.params.proposedExecpolicyAmendment?.length) && (!approval.params.availableDecisions || approval.params.availableDecisions.some(value => value === decision || typeof value === "object" && decision === "acceptWithExecpolicyAmendment" && value.acceptWithExecpolicyAmendment))).map(([decision, label]) => <button type="button" key={decision} onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision })}>{label}</button>)}</div>
          : <div className="graphical-actions"><button type="button" onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: false })}><GraphicalIcon name="close" />拒绝</button>
            <button type="button" className="primary" onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: true })}><GraphicalIcon name="check" />批准一次</button></div>}
      </article>)}
      {snapshot.questions.map(question => <GraphicalQuestionCard key={question.requestId} question={question} provider={snapshot.provider}
        onAnswer={(questionId, answers) => action({ type: "graphical.answer", questionId, answers })}
        onCancel={questionId => action({ type: "graphical.cancelQuestion", questionId })} />)}
    </div>
  );
}
