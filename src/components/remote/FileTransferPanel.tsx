import { ArrowDown, ArrowUp, RefreshCw, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { FileTransferTask, TerminalSession } from "../../vite-env";

type FileTransferPanelProps = {
  tasks: FileTransferTask[];
  sessions: TerminalSession[];
};

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function FileTransferPanel({ tasks, sessions }: FileTransferPanelProps) {
  const { t } = useI18n();
  const sessionTitles = new Map(sessions.map((session) => [session.id, session.title]));
  return (
    <div className="file-transfer-workspace">
      <header>
        <div><h2>{t("files.transfers")}</h2><span>{tasks.length}</span></div>
        <button type="button" onClick={() => void window.fileTransferApi.clear()}><Trash2 aria-hidden="true" />{t("files.clearCompleted")}</button>
      </header>
      <div className="file-transfer-list">
        {tasks.length === 0 ? <div className="remote-file-empty">{t("files.noTransfers")}</div> : tasks.map((task) => (
          <article className={`file-transfer-task ${task.status}`} key={task.id}>
            <span className="file-transfer-direction">{task.direction === "upload" ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}</span>
            <div className="file-transfer-main">
              <div><strong title={task.remotePath || task.localPath}>{task.name}</strong><span>{sessionTitles.get(task.sessionId) || task.sessionId}</span></div>
              <div className={`remote-file-transfer-progress ${task.percent === null ? "indeterminate" : ""}`}><span style={{ width: `${task.percent ?? 35}%` }} /></div>
              <small>{task.error || `${formatSize(task.transferredBytes)}${task.totalBytes ? ` / ${formatSize(task.totalBytes)}` : ""} · ${task.status}`}</small>
            </div>
            <div className="file-transfer-buttons">
              {(task.status === "queued" || task.status === "running") && <button type="button" title={t("common.cancel")} onClick={() => void window.fileTransferApi.cancel(task.id)}><X aria-hidden="true" /></button>}
              {(task.status === "failed" || task.status === "canceled") && <button type="button" title={t("common.retry")} onClick={() => void window.fileTransferApi.retry(task.id)}><RefreshCw aria-hidden="true" /></button>}
              {task.status === "conflict" && <>
                <button type="button" title={t("files.overwrite")} onClick={() => void window.fileTransferApi.resolveConflict(task.id, "overwrite")}>O</button>
                <button type="button" title={t("files.autoRename")} onClick={() => void window.fileTransferApi.resolveConflict(task.id, "rename")}>R</button>
                <button type="button" title={t("files.skip")} onClick={() => void window.fileTransferApi.resolveConflict(task.id, "skip")}>S</button>
              </>}
              {!["queued", "running"].includes(task.status) && <button type="button" title={t("common.delete")} onClick={() => void window.fileTransferApi.clear(task.id)}><Trash2 aria-hidden="true" /></button>}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
