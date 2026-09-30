import { GraphicalIcon } from "./GraphicalIcon";
import { type useGraphicalSession, type GraphicalViewProps } from "./useGraphicalSession";
import type { GraphicalSnapshot } from "./types";

type Controller = ReturnType<typeof useGraphicalSession>;
export function GraphicalComposer({ snapshot, controller, draft, setDraft }: {
  snapshot: GraphicalSnapshot; controller: Controller;
  draft: GraphicalViewProps["draft"]; setDraft: GraphicalViewProps["setDraft"];
}) {
  const { attachments, setAttachments, isSending, action, submit, uploadFile, removeAttachment, historyMutation } = controller;
  const effectivePlan = snapshot.mode === "plan";
  return (    <form className="graphical-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
      {attachments.length > 0 && <div className="graphical-attachments">{attachments.map(item => <div key={item.key}>
        <span>{item.file.name} · {item.status === "uploading" ? "上传中" : item.status === "failed" ? "上传失败" : "已上传"}</span>
        {item.status === "failed" && <button type="button" className="graphical-icon-button" aria-label={`重试上传 ${item.file.name}`} title="重试上传" onClick={() => { setAttachments(current => current.map(value => value.key === item.key ? { ...value, status: "uploading" } : value)); void uploadFile(item.file, item.key); }}><GraphicalIcon name="retry" /></button>}
        <button type="button" className="graphical-icon-button" aria-label={`移除附件 ${item.file.name}`} title="移除附件" disabled={isSending} onClick={() => removeAttachment(item.key)}><GraphicalIcon name="remove" /></button>
      </div>)}</div>}
      <div className={`graphical-input-border${snapshot.busy ? " is-running" : ""}`} data-mode={effectivePlan ? "plan" : "default"}>
        <div className="graphical-input-row">
          <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder={snapshot.archived ? "已归档的对话不可发送" : "输入消息"}
            disabled={!snapshot.threadId || snapshot.archived || Boolean(historyMutation) || (snapshot.busy && snapshot.provider !== "codex")} />
          {snapshot.busy && <button type="button" className="graphical-icon-button" aria-label="停止" title="停止" onClick={() => action({ type: "graphical.interrupt" })}><GraphicalIcon name="stop" /></button>}
          <button type="submit" className="primary graphical-icon-button" aria-label="发送" title="发送" disabled={isSending || (!draft.trim() && !attachments.length) || attachments.some(item => item.status !== "ready") || !snapshot.threadId || snapshot.archived || (snapshot.busy && snapshot.provider !== "codex")}><GraphicalIcon name="send" /></button>
        </div>
      </div>
    </form>
  );
}
