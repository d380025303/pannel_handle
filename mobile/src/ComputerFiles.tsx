import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FileText, Folder, HardDrive } from "lucide-react";
import { createRequestId } from "./protocol";
import { isPreviewTransport } from "./remoteSocket";
import { PROTOCOL_VERSION, type ClientMessage, type ComputerFileEntry, type ServerMessage } from "./types";

type FileMessage = Extract<ServerMessage, { type: "files.list.result" | "files.download.ready" | "error" }>;

export function ComputerFiles({ connectionEpoch, send, onFileMessage, onClose }: {
  connectionEpoch: number;
  send: (message: ClientMessage) => boolean;
  onFileMessage: (listener: (message: FileMessage) => void) => () => void;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<string[]>([]);
  const [entries, setEntries] = useState<ComputerFileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const pending = useRef(new Map<string, { kind: "list" | "download"; path?: string }>());
  const path = history.at(-1) ?? null;

  useEffect(() => {
    const remove = onFileMessage(message => {
      const request = message.requestId && pending.current.get(message.requestId);
      if (!request || !message.requestId) return;
      pending.current.delete(message.requestId);
      if (message.type === "error") {
        setError(message.message);
        if (request.kind === "list") setBusy(false);
        else setDownloading(null);
      } else if (message.type === "files.list.result" && request.kind === "list") {
        setEntries(message.entries);
        setBusy(false);
      } else if (message.type === "files.download.ready" && request.kind === "download") {
        setDownloading(null);
        if (!message.url.startsWith("/api/v1/download/") && !(isPreviewTransport() && message.url.startsWith("blob:"))) { setError("下载地址无效。"); return; }
        const link = document.createElement("a");
        link.href = message.url;
        link.download = "";
        document.body.append(link);
        link.click();
        link.remove();
        setNotice("已交由浏览器下载；保存结果请查看浏览器下载记录。");
      }
    });
    return () => { remove(); pending.current.clear(); };
  }, [onFileMessage]);

  useEffect(() => {
    if (!connectionEpoch) return;
    const requestId = createRequestId();
    pending.current.clear();
    pending.current.set(requestId, { kind: "list" });
    setBusy(true);
    setDownloading(null);
    setError("");
    setNotice("");
    setEntries([]);
    if (!send({ v: PROTOCOL_VERSION, type: "files.list", path, requestId })) {
      pending.current.delete(requestId);
      setBusy(false);
      setError("连接已断开，请重新连接后再试。");
    }
  }, [connectionEpoch, path, refreshKey, send]);

  const download = (entry: ComputerFileEntry) => {
    const requestId = createRequestId();
    pending.current.set(requestId, { kind: "download", path: entry.path });
    setDownloading(entry.path);
    setError("");
    setNotice("");
    if (!send({ v: PROTOCOL_VERSION, type: "files.download.prepare", path: entry.path, requestId })) {
      pending.current.delete(requestId);
      setDownloading(null);
      setError("连接已断开，请重新连接后再试。");
    }
  };

  return <section className="computer-files">
    <header>
      <button type="button" onClick={onClose} aria-label="返回会话"><ArrowLeft aria-hidden="true" /></button>
      <strong>电脑文件</strong>
      <span>{path ?? "本地磁盘"}</span>
    </header>
    <div className="computer-files-toolbar">
      {history.length > 0 && <button type="button" onClick={() => setHistory(current => current.slice(0, -1))}>上一级</button>}
      <button type="button" onClick={() => setRefreshKey(current => current + 1)} disabled={busy}>刷新</button>
    </div>
    {error && <p className="computer-files-error" role="alert">{error}</p>}
    {notice && <p className="computer-files-notice" role="status">{notice}</p>}
    <div className="computer-files-list">
      {busy && <p>正在读取…</p>}
      {!busy && entries.length === 0 && <p>这里没有可访问的文件。</p>}
      {!busy && entries.map(entry => <div className="computer-file-row" key={entry.path}>
        <button type="button" className="computer-file-name" disabled={entry.type === "file"}
          onClick={() => setHistory(current => [...current, entry.path])}>
          <span className="computer-file-label">{entry.type === "file" ? <FileText aria-hidden="true" /> : entry.type === "drive" ? <HardDrive aria-hidden="true" /> : <Folder aria-hidden="true" />}<span className="computer-file-text">{entry.name}</span></span>
          <small>{entry.type === "file" ? `${(entry.size ?? 0).toLocaleString()} 字节` : entry.type === "drive" ? "磁盘" : "文件夹"}</small>
        </button>
        {entry.type !== "drive" && <button type="button" className="computer-file-download" disabled={Boolean(downloading)}
          onClick={() => download(entry)}>{downloading === entry.path ? "准备中" : "下载"}</button>}
      </div>)}
    </div>
  </section>;
}
