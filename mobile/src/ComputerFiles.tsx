import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FileText, Folder, HardDrive } from "lucide-react";
import { createRequestId } from "./protocol";
import { isPreviewTransport } from "./remoteSocket";
import { PROTOCOL_VERSION, type ClientMessage, type ComputerFileEntry, type ServerMessage } from "./types";

type FileMessage = Extract<ServerMessage, { type: "files.list.result" | "files.search.result" | "files.download.ready" | "error" }>;

export function ComputerFiles({ connectionEpoch, send, onFileMessage, onClose }: {
  connectionEpoch: number;
  send: (message: ClientMessage) => boolean;
  onFileMessage: (listener: (message: FileMessage) => void) => () => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [destination, setDestination] = useState<{ path: string | null }>({ path: null });
  const [address, setAddress] = useState("");
  const [query, setQuery] = useState("");
  const [searchEntries, setSearchEntries] = useState<ComputerFileEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const currentPath = useRef<string | null>(null);
  const previousEpoch = useRef(connectionEpoch);
  const searchRequest = useRef<string | null>(null);
  const [entries, setEntries] = useState<ComputerFileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const pending = useRef(new Map<string, { kind: "list" | "search" | "download"; path?: string }>());
  const cancelSearch = () => {
    if (searchRequest.current) {
      send({ v: PROTOCOL_VERSION, type: "files.search.cancel", requestId: searchRequest.current });
      pending.current.delete(searchRequest.current);
      searchRequest.current = null;
    }
    setSearching(false);
  };
  const navigate = (target: string | null) => {
    cancelSearch();
    setSearchEntries(null);
    setQuery("");
    setDestination({ path: target });
  };
  const parts = path?.replace(/\\/g, "/").split("/").filter(Boolean) ?? [];
  const crumbs = parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("\\") + (index === 0 ? "\\" : "") }));
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
  const visibleEntries = searchEntries ?? entries;

  useEffect(() => {
    const remove = onFileMessage(message => {
      const request = message.requestId && pending.current.get(message.requestId);
      if (!request || !message.requestId) return;
      pending.current.delete(message.requestId);
      if (message.type === "error") {
        setError(message.message);
        if (request.kind === "list") setBusy(false);
        else if (request.kind === "search") { setSearching(false); searchRequest.current = null; }
        else setDownloading(null);
      } else if (message.type === "files.list.result" && request.kind === "list") {
        currentPath.current = message.path;
        setPath(message.path);
        setAddress(message.path ?? "");
        setEntries(message.entries);
        setBusy(false);
      } else if (message.type === "files.search.result" && request.kind === "search") {
        searchRequest.current = null;
        setSearching(false);
        setSearchEntries(message.entries);
        setNotice(`找到 ${message.entries.length} 项。${message.reason !== "complete" ? "达到搜索上限，结果不完整，请缩小搜索范围。" : ""}${message.skipped ? `有 ${message.skipped} 个位置未搜索。` : ""}`);
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
    return () => {
      remove();
      if (searchRequest.current) send({ v: PROTOCOL_VERSION, type: "files.search.cancel", requestId: searchRequest.current });
      pending.current.clear();
    };
  }, [onFileMessage, send]);

  useEffect(() => {
    if (!connectionEpoch) return;
    const requestId = createRequestId();
    const target = previousEpoch.current !== connectionEpoch ? currentPath.current : destination.path;
    previousEpoch.current = connectionEpoch;
    cancelSearch();
    setSearchEntries(null);
    pending.current.clear();
    pending.current.set(requestId, { kind: "list" });
    setBusy(true);
    setDownloading(null);
    setError("");
    setNotice("");

    if (!send({ v: PROTOCOL_VERSION, type: "files.list", path: target, requestId })) {
      pending.current.delete(requestId);
      setBusy(false);
      setError("连接已断开，请重新连接后再试。");
    }
  }, [connectionEpoch, destination, refreshKey, send]);

  const search = () => {
    if (!path || !query.trim()) return;
    cancelSearch();
    const requestId = createRequestId();
    searchRequest.current = requestId;
    pending.current.set(requestId, { kind: "search" });
    setSearching(true);
    setSearchEntries(null);
    setError("");
    setNotice("");
    if (!send({ v: PROTOCOL_VERSION, type: "files.search", path, query: query.trim(), requestId })) {
      cancelSearch();
      setError("连接已断开，请重新连接后再试。");
    }
  };

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
      {path && <button type="button" onClick={() => navigate(parent)}>上一级</button>}
      <button type="button" onClick={() => { setDestination({ path }); setRefreshKey(current => current + 1); }} disabled={busy}>刷新</button>
    </div>
    <nav className="computer-files-breadcrumbs" aria-label="目录导航">
      <button type="button" onClick={() => navigate(null)}>本地磁盘</button>
      {crumbs.map(crumb => <button type="button" key={crumb.path} onClick={() => navigate(crumb.path)}>{crumb.name}</button>)}
    </nav>
    <form className="computer-files-form" onSubmit={event => { event.preventDefault(); navigate(address.trim()); }}>
      <input aria-label="目录路径" placeholder="粘贴电脑目录路径，如 C:\Users" value={address} onChange={event => setAddress(event.target.value)} />
      <button type="submit" disabled={!address.trim()}>跳转</button>
    </form>
    <form className="computer-files-form" onSubmit={event => { event.preventDefault(); search(); }}>
      <input aria-label="搜索文件名" placeholder={path ? "搜索当前目录及子目录" : "请先选择磁盘或目录"} disabled={!path || busy} maxLength={256} value={query} onChange={event => setQuery(event.target.value)} />
      <button type="submit" disabled={!path || busy || !query.trim()}>搜索</button>
      {searching && <button type="button" onClick={cancelSearch}>取消</button>}
      {(query || searchEntries) && <button type="button" onClick={() => { cancelSearch(); setSearchEntries(null); setQuery(""); setNotice(""); }}>清空</button>}
    </form>
    {searching && <p className="computer-files-notice" role="status">正在搜索…</p>}
    {error && <p className="computer-files-error" role="alert">{error}</p>}
    {notice && <p className="computer-files-notice" role="status">{notice}</p>}
    <div className="computer-files-list">
      {busy && <p>正在读取…</p>}
      {!busy && visibleEntries.length === 0 && <p>{searchEntries ? "未找到匹配的文件或文件夹。" : "这里没有可访问的文件。"}</p>}
      {!busy && visibleEntries.map(entry => <div className="computer-file-row" data-search-result={searchEntries !== null || undefined} key={entry.path}>
        <button type="button" className="computer-file-name" disabled={entry.type === "file"}
          onClick={() => navigate(entry.path)}>
          <span className="computer-file-label">{entry.type === "file" ? <FileText aria-hidden="true" /> : entry.type === "drive" ? <HardDrive aria-hidden="true" /> : <Folder aria-hidden="true" />}<span className="computer-file-text">{entry.name}</span></span>
          {searchEntries && <small className="computer-file-relative">{entry.path.slice((path?.replace(/[\\/]+$/, "").length ?? 0) + 1)}</small>}
          <small>{entry.type === "file" ? `${(entry.size ?? 0).toLocaleString()} 字节` : entry.type === "drive" ? "磁盘" : "文件夹"}</small>
        </button>
        {searchEntries && entry.type === "file" && <button type="button" className="computer-file-download" onClick={() => navigate(entry.path.replace(/[\\/][^\\/]+$/, "") + (/^[A-Za-z]:[\\/][^\\/]+$/.test(entry.path) ? "\\" : ""))}>打开所在目录</button>}
        {entry.type !== "drive" && <button type="button" className="computer-file-download" disabled={Boolean(downloading)}
          onClick={() => download(entry)}>{downloading === entry.path ? "准备中" : "下载"}</button>}
      </div>)}
    </div>
  </section>;
}
