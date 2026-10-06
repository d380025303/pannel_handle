import type { WorkspaceEntrySearchResult, WorkspaceEntrySearchResponse } from "../../src/vite-env";
import { useEffect, useState } from "react";
import { modelLabel } from "./GraphicalPresentation";
import { graphicalInputPolicy, graphicalPermissionStatus } from "./GraphicalInputPolicy";
import { GraphicalIcon } from "./GraphicalIcon";
import { type useGraphicalSession, type GraphicalViewProps } from "./useGraphicalSession";
import type { GraphicalSnapshot } from "./types";

type Controller = ReturnType<typeof useGraphicalSession>;
export function GraphicalComposer({ snapshot, controller, draft, setDraft }: {
  snapshot: GraphicalSnapshot; controller: Controller;
  draft: GraphicalViewProps["draft"]; setDraft: GraphicalViewProps["setDraft"];
}) {
  const { attachments, setAttachments, isSending, action, submit, uploadFile, removeAttachment, historyMutation } = controller;
  const [fileSuggestions, setFileSuggestions] = useState<WorkspaceEntrySearchResult[]>([]);
  const mention = /(?:^|\s)@([^\s]*)$/.exec(draft);
  const mentionQuery = mention?.[1];
  useEffect(() => {
    if (snapshot.provider !== "codex" || mentionQuery === undefined) { setFileSuggestions([]); return; }
    let active = true;
    const timer = setTimeout(() => { void controller.codexRequest<WorkspaceEntrySearchResponse>("workspace-search", { query: mentionQuery })
      .then(value => { if (active) setFileSuggestions(value.results); }).catch(() => { if (active) setFileSuggestions([]); }); }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [mentionQuery, snapshot.threadId]);
  const [preview, setPreview] = useState<{ name: string; url?: string; text?: string } | null>(null);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);
  const policy = graphicalInputPolicy(snapshot, Boolean(historyMutation));
  const permissionStatus = graphicalPermissionStatus(snapshot);
  const effectivePlan = snapshot.mode === "plan";
  return (    <form className="graphical-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
      {controller.references.length > 0 && <div className="graphical-attachments">{controller.references.map(reference => <button type="button" key={reference.path} onClick={() => controller.setReferences(current => current.filter(value => value.path !== reference.path))}>{reference.name} ×</button>)}</div>}
      {preview && <div className="graphical-card"><strong>{preview.name}</strong><button type="button" onClick={() => setPreview(null)}>关闭预览</button>{preview.url ? <img className="graphical-preview-image" src={preview.url} alt={preview.name} /> : <pre>{preview.text}</pre>}</div>}
      {attachments.length > 0 && <div className="graphical-attachments">{attachments.map(item => <div key={item.key}>
        <button type="button" onClick={() => { if (item.file.type.startsWith("image/")) setPreview({ name: item.file.name, url: URL.createObjectURL(item.file) }); else void item.file.slice(0, 65536).text().then(text => setPreview({ name: item.file.name, text })).catch(cause => controller.setError(String(cause))); }}>{item.file.name} · {item.status === "uploading" ? "上传中" : item.status === "failed" ? "上传失败" : "已上传"}</button>
        {item.status === "failed" && <button type="button" className="graphical-icon-button" aria-label={`重试上传 ${item.file.name}`} title="重试上传" onClick={() => { setAttachments(current => current.map(value => value.key === item.key ? { ...value, status: "uploading" } : value)); void uploadFile(item.file, item.key); }}><GraphicalIcon name="retry" /></button>}
        <button type="button" className="graphical-icon-button" aria-label={`移除附件 ${item.file.name}`} title="移除附件" disabled={isSending} onClick={() => removeAttachment(item.key)}><GraphicalIcon name="remove" /></button>
      </div>)}</div>}
      <div className={`graphical-input-border${snapshot.busy ? " is-running" : ""}`} data-mode={effectivePlan ? "plan" : "default"}>
        <div className="graphical-input-row">
          <textarea value={draft} onChange={event => { const value = event.target.value; setDraft(value); controller.setReferences(current => current.filter(reference => value.includes(reference.token))); }} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); controller.addFiles(event.clipboardData.files); } }} aria-label="图形对话输入" aria-autocomplete="list" placeholder={snapshot.signedOut ? "请先登录 Codex 账号" : snapshot.archived ? "已归档的对话不可发送" : "输入消息"}
            disabled={!policy.canInput} />
          {snapshot.busy && <button type="button" className="graphical-icon-button" aria-label="停止" title="停止" onClick={() => action({ type: "graphical.interrupt" })}><GraphicalIcon name="stop" /></button>}
          <button type="submit" className="primary graphical-icon-button" aria-label="发送" title="发送" disabled={isSending || (!draft.trim() && !attachments.length) || attachments.some(item => item.status !== "ready") || !policy.canSubmit}><GraphicalIcon name="send" /></button>
        </div>
      </div>
      {(snapshot.provider === "codex" || snapshot.provider === "codebuddy") && <div className="graphical-composer-toolbar">
        <button ref={controller.moreButtonRef} type="button" aria-label="更多操作" aria-haspopup="dialog" aria-expanded={Boolean(controller.activeSheet)} onClick={() => controller.setActiveSheet("menu")}><GraphicalIcon name="more" /></button>
        <button type="button" disabled={snapshot.busy || snapshot.archived || !!snapshot.pendingPlan || controller.changingMode} onClick={() => controller.changeMode(effectivePlan ? "default" : "plan")}>{effectivePlan ? "Plan" : snapshot.provider === "codebuddy" ? snapshot.executionPermission === "fullAccess" ? "Full Access" : snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "模式" : "Exec"}</button>
        <button type="button" disabled={snapshot.busy || snapshot.archived || controller.changingModel} onClick={() => controller.setActiveSheet("model")}>{modelLabel(snapshot)}</button>
        <button type="button" disabled={!snapshot.threadId || snapshot.busy || isSending} aria-label="新对话" onClick={() => action({ type: "graphical.new-thread" })}><GraphicalIcon name="new" /></button>
      </div>}
      {(snapshot.provider === "codex" || snapshot.provider === "codebuddy") && draft.startsWith("/") && <div className="graphical-slash-commands" role="listbox" aria-label="会话操作联想">{controller.slashCommands.filter(([command]) => `/${command}`.toLowerCase().startsWith(draft.trim().toLowerCase())).map(([command, label]) => <button type="button" role="option" aria-selected={false} key={command} onClick={() => controller.invokeSlash(command)}>/{command} · {label}</button>)}</div>}
      {snapshot.provider === "codex" && mentionQuery !== undefined && fileSuggestions.length > 0 && <div className="graphical-slash-commands" role="listbox" aria-label="搜索工作区文件">{fileSuggestions.map(file => <button type="button" role="option" aria-selected={false} key={file.path} onClick={() => { setDraft(current => current.replace(/@[^\s]*$/, `@${file.relativePath} `)); setFileSuggestions([]); }}>{file.relativePath}</button>)}</div>}
      {permissionStatus && <span className="graphical-composer-permission">{permissionStatus}</span>}
    </form>
  );
}
