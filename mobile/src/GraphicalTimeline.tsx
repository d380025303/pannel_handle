import { Check, Circle, Paperclip } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GraphicalIcon } from "./GraphicalIcon";
import { GraphicalQuestionCard } from "./GraphicalQuestionCard";
import { groupTimeline, openCodePlanReplyId, providerLabel, ToolItem, toolStatus } from "./GraphicalPresentation";
import { type useGraphicalSession } from "./useGraphicalSession";
import type { GraphicalSnapshot } from "./types";

type Controller = ReturnType<typeof useGraphicalSession>;
export function GraphicalTimeline({ snapshot, controller }: { snapshot: GraphicalSnapshot; controller: Controller }) {
  const { expandedGroupId, setExpandedGroupId, changingMode, scrollRef, action, executeOpenCodePlan } = controller;
  const openCodePlanItemId = openCodePlanReplyId(snapshot);
  const openCodeBuildMode = snapshot.nativeModes?.find(mode => mode.id.toLowerCase() === "build");
  return (    <div className="graphical-timeline" ref={scrollRef}>
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
          return <article className={`graphical-message ${item.type}`} key={item.id}><small>{item.type === "userMessage" ? "你" : providerLabel(snapshot.provider)}</small>
            <div className="graphical-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || ""}</ReactMarkdown></div>
            {item.attachments?.length ? <div className="graphical-attachment-history">{item.attachments.map((file, index) => <span key={index}><Paperclip aria-hidden="true" />{file.name}</span>)}</div> : null}
            {openCodePlanItemId === item.id && openCodeBuildMode && <div className="graphical-actions">
              <button type="button" className="primary" disabled={changingMode} onClick={() => executeOpenCodePlan(item.id)}>执行计划</button>
            </div>}</article>;
        if (item.type === "questionAnswer") return <article className="graphical-card" key={item.id}><strong>已回答问题</strong>{item.questions?.map(value => <p key={value.id}>{value.question}：{value.answers.join("、")}</p>)}</article>;
        if (item.type === "plan" || item.type === "turnPlan") return <article className="graphical-card" key={item.id}><strong>计划</strong><p>{item.text}</p>{item.plan?.map((step, index) => <p className="graphical-plan-step" key={index}>{step.status === "completed" ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}<span>{step.step}</span></p>)}
          {openCodePlanItemId === item.id && openCodeBuildMode && <div className="graphical-actions">
            <button type="button" className="primary" disabled={changingMode} onClick={() => executeOpenCodePlan(item.id)}>执行计划</button>
          </div>}</article>;
        if (item.type === "turnError") return <article className="graphical-card" role="alert" key={item.id}><strong>运行错误</strong><p>{item.text}</p></article>;
        return <article className="graphical-card" key={item.id}><strong>后台任务汇总</strong></article>;
      })}
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
        {approval.params.changes != null && <pre>{JSON.stringify(approval.params.changes, null, 2)}</pre>}
        {approval.params.choices?.length ? <div className="graphical-actions">{approval.params.choices.map(choice =>
          <button type="button" key={choice.id} onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: choice.id })}>{choice.label}</button>)}</div>
          : <div className="graphical-actions"><button type="button" onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: false })}><GraphicalIcon name="close" />拒绝</button>
            <button type="button" className="primary" onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: true })}><GraphicalIcon name="check" />批准一次</button></div>}
      </article>)}
      {snapshot.questions.map(question => <GraphicalQuestionCard key={question.requestId} question={question} provider={snapshot.provider}
        onAnswer={(questionId, answers) => action({ type: "graphical.answer", questionId, answers })}
        onCancel={questionId => action({ type: "graphical.cancelQuestion", questionId })} />)}
    </div>
  );
}
