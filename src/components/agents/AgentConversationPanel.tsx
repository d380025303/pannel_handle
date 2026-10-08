import { cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, History, Search, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentProvider,
  AgentConversationHistoryError,
  AgentConversationHistoryItem,
  AgentConversationMessage,
  AgentConversationSnapshot,
  TerminalSession
} from "../../vite-env";
import { useI18n } from "../../i18n";
import { SearchableSelect } from "../shared/SearchableSelect";

function providerName(provider?: AgentProvider) {
  if (provider === "claude") return "Claude";
  if (provider === "qoder") return "Qoder";
  if (provider === "copilot") return "Copilot";
  return provider === "codebuddy" ? "CodeBuddy" : provider === "opencode" ? "OpenCode" : provider === "gemini" ? "Gemini CLI" : provider === "grok" ? "Grok CLI" : "Codex";
}

function highlightText(text: string, query: string, nextIndex: () => number, activeIndex: number): ReactNode {
  if (!query) return text;
  const normalizedText = text.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let offset = 0;
  let matchOffset = normalizedText.indexOf(normalizedQuery);
  while (matchOffset !== -1) {
    if (matchOffset > offset) parts.push(text.slice(offset, matchOffset));
    const matchIndex = nextIndex();
    parts.push(
      <mark
        className={`agent-conversation-search-match${matchIndex === activeIndex ? " active" : ""}`}
        data-search-index={matchIndex}
        key={`${matchOffset}-${matchIndex}`}
      >
        {text.slice(matchOffset, matchOffset + query.length)}
      </mark>
    );
    offset = matchOffset + query.length;
    matchOffset = normalizedText.indexOf(normalizedQuery, offset);
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts.length ? parts : text;
}

function highlightChildren(children: ReactNode, query: string, nextIndex: () => number, activeIndex: number): ReactNode {
  if (typeof children === "string") return highlightText(children, query, nextIndex, activeIndex);
  if (Array.isArray(children)) return children.map(child => highlightChildren(child, query, nextIndex, activeIndex));
  if (!isValidElement<{ children?: ReactNode }>(children) || children.type === "mark" || children.props.children === undefined) {
    return children;
  }
  return cloneElement(children, undefined, highlightChildren(children.props.children, query, nextIndex, activeIndex));
}

type HistoryProviderFilter = "all" | AgentProvider;

export function AgentConversationPanel({
  snapshot,
  session
}: {
  snapshot: AgentConversationSnapshot | null;
  session?: TerminalSession;
}) {
  const { locale } = useI18n();
  const isEnglish = locale === "en-US";
  const turn = snapshot?.turn;
  const hasLive = Boolean(turn);
  const [providerFilter, setProviderFilter] = useState<HistoryProviderFilter>("all");
  const [scope, setScope] = useState<"cwd" | "all">("cwd");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyItems, setHistoryItems] = useState<Array<AgentConversationHistoryItem & { backupSourceKey?: string; backupRef?: string }>>([]);
  const [backupDevices, setBackupDevices] = useState<Array<{ id: string; name: string }>>([]);
  const [historyDeviceId, setHistoryDeviceId] = useState("archive");
  const [historyErrors, setHistoryErrors] = useState<AgentConversationHistoryError[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedRef, setSelectedRef] = useState(hasLive ? "live" : "");
  const [historyMessages, setHistoryMessages] = useState<AgentConversationMessage[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const prependedScrollRef = useRef<{ height: number; top: number } | null>(null);
  const lastScrollKeyRef = useRef("");
  const lastSearchTargetRef = useRef("");
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const selectedHistory = historyItems.find(item => item.ref === selectedRef);
  const showingLive = selectedRef === "live" && hasLive;
  const detailMessages = useMemo(
    () => showingLive ? turn?.messages || [] : historyMessages,
    [historyMessages, showingLive, turn?.messages]
  );
  const normalizedSearchQuery = searchQuery.trim();
  const historyProviderFilters = useMemo(
    () => historyDeviceId === "archive"
      ? (["all", "codex", "codebuddy", "opencode", "claude", "qoder", "copilot", "gemini", "grok"] as const)
      : historyDeviceId === "local" && session?.type === "ssh"
      ? (["all", "codex", "codebuddy", "opencode"] as const)
      : (["all", "codex", "codebuddy", "opencode", "gemini", "grok"] as const),
    [historyDeviceId, session?.type]
  );

  useEffect(() => {
    if (window.postgresBackupApi) void window.postgresBackupApi.listDevices().then(setBackupDevices).catch(() => {});
  }, []);
  useEffect(() => { setSelectedRef(""); setHistoryItems([]); setProviderFilter("all"); setScope((historyDeviceId === "archive" || historyDeviceId === "local") && session ? "cwd" : "all"); }, [historyDeviceId]);

  useEffect(() => {
    setSelectedRef(hasLive ? "live" : "");
    setHistoryMessages([]);
    setMessageCursor(null);
  }, [hasLive, session?.id]);

  useEffect(() => {
    setHistoryOpen(false);
    setProviderFilter("all");
  }, [session?.id, snapshot?.activeSessionId]);

  const loadHistory = useCallback(async (cursor: string | null = null, append = false, refresh = false) => {
    if (!session && historyDeviceId !== "archive") return;
    const requestId = ++listRequestRef.current;
    setHistoryLoading(true);
    try {
      const result = historyDeviceId === "local" || historyDeviceId === "archive" ? await window.agentConversationApi.listHistory({
        source: historyDeviceId === "archive" ? "archive" : "cli",
        cwd: session?.cwd, windows: session?.type === "windows",
        panelSessionId: session?.id,
        providers: providerFilter === "all"
          ? (historyDeviceId === "archive" ? undefined : session?.type === "ssh" ? ["codex", "codebuddy", "opencode"] : ["codex", "codebuddy", "opencode", "gemini", "grok"])
          : [providerFilter],
        scope,
        includeArchived,
        query: historyQuery.trim(),
        cursor,
        limit: 50
      }) : await (async () => {
        const offset = Number(cursor || 0);
        const page = await window.postgresBackupApi.listConversations(historyDeviceId, offset);
        const items = page.map(entry => ({ ...entry.metadata,
          ref: `backup:${JSON.stringify([entry.source_key, entry.conversation_ref])}`,
          backupSourceKey: entry.source_key, backupRef: entry.conversation_ref }))
          .filter(item => (providerFilter === "all" || item.provider === providerFilter)
            && (scope === "all" || item.cwd === session?.cwd)
            && (includeArchived || !item.archived)
            && [item.title, item.preview, item.cwd].some(value => String(value || "").toLowerCase().includes(historyQuery.trim().toLowerCase())));
        return { items, nextCursor: page.length === 100 ? String(offset + page.length) : null, errors: [] };
      })();
      if (requestId !== listRequestRef.current) return;
      setHistoryItems(current => {
        const next = result.items.map(item => {
          const existing = current.find(value => value.ref === item.ref);
          return existing && JSON.stringify(existing) === JSON.stringify(item) ? existing : item;
        });
        if (append) return [...current, ...next.filter(item => !current.some(value => value.ref === item.ref))];
        return refresh ? [...next, ...current.filter(item => !next.some(value => value.ref === item.ref))] : next;
      });
      setHistoryErrors(result.errors);
      if (!refresh) setHistoryCursor(result.nextCursor);
      if (!append && !refresh) {
        setSelectedRef(current => {
          if (current === "live" && hasLive && (historyDeviceId === "local" || historyDeviceId === "archive")) return current;
          return result.items.some(item => item.ref === current) ? current : (hasLive && (historyDeviceId === "local" || historyDeviceId === "archive") ? "live" : result.items[0]?.ref || "");
        });
      }
    } catch (error) {
      if (requestId !== listRequestRef.current) return;
      setHistoryItems([]);
      setHistoryCursor(null);
      setHistoryErrors([{ provider: "codex", message: error instanceof Error ? error.message : String(error) }]);
    } finally {
      if (requestId === listRequestRef.current) setHistoryLoading(false);
    }
  }, [hasLive, historyDeviceId, historyProviderFilters, historyQuery, includeArchived, providerFilter, scope, session]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadHistory(); }, 180);
    return () => window.clearTimeout(timer);
  }, [loadHistory]);

  useEffect(() => {
    if (historyDeviceId !== "archive") return;
    const timer = window.setInterval(() => { void loadHistory(null, false, true); }, 5000);
    return () => window.clearInterval(timer);
  }, [historyDeviceId, loadHistory]);

  const loadMessages = useCallback(async (cursor: string | null = null, append = false) => {
    if ((!session && historyDeviceId !== "archive") || !selectedRef || selectedRef === "live") return;
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailError("");
    try {
      const result = historyDeviceId === "local" || historyDeviceId === "archive" ? await window.agentConversationApi.getHistoryMessages({
        panelSessionId: session?.id,
        conversationRef: selectedRef,
        cursor,
        limit: 100
      }) : await (async () => {
        if (!selectedHistory?.backupSourceKey || !selectedHistory.backupRef) throw new Error("Backup conversation was not found.");
        const offset = Number(cursor || 0);
        const page = await window.postgresBackupApi.getMessages(historyDeviceId,
          selectedHistory.backupSourceKey, selectedHistory.backupRef, offset);
        return { conversationRef: selectedRef, messages: page,
          nextCursor: page.length === 100 ? String(offset + page.length) : null };
      })();
      if (requestId !== detailRequestRef.current || result.conversationRef !== selectedRef) return;
      if (append && scrollRef.current) {
        prependedScrollRef.current = { height: scrollRef.current.scrollHeight, top: scrollRef.current.scrollTop };
      }
      const chronologicalPage = [...result.messages].reverse();
      setHistoryMessages(current => append ? [...chronologicalPage, ...current] : chronologicalPage);
      setMessageCursor(result.nextCursor);
    } catch (error) {
      if (requestId !== detailRequestRef.current) return;
      setHistoryMessages([]);
      setMessageCursor(null);
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }, [historyDeviceId, selectedHistory, selectedRef, session]);

  useEffect(() => {
    setHistoryMessages([]);
    setMessageCursor(null);
    setDetailError("");
    if (selectedRef && selectedRef !== "live") void loadMessages();
  }, [loadMessages, selectedRef]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const prependedScroll = prependedScrollRef.current;
    if (prependedScroll) {
      scroller.scrollTop = prependedScroll.top + scroller.scrollHeight - prependedScroll.height;
      prependedScrollRef.current = null;
      return;
    }
    const scrollKey = `${session?.id || ""}:${selectedRef}:${detailMessages.length}:${detailMessages.at(-1)?.id || ""}`;
    if (scrollKey !== lastScrollKeyRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
      lastScrollKeyRef.current = scrollKey;
    }
  }, [detailMessages, selectedRef, session?.id]);

  const openSearch = useCallback(() => {
    setHistoryOpen(false);
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setActiveMatchIndex(0);
    setTotalMatches(0);
  }, []);
  const moveSearch = useCallback((direction: number) => {
    if (totalMatches) setActiveMatchIndex(current => (current + direction + totalMatches) % totalMatches);
  }, [totalMatches]);
  const toggleHistory = useCallback(() => {
    if (!historyOpen) closeSearch();
    setHistoryOpen(current => !current);
  }, [closeSearch, historyOpen]);
  const selectConversation = useCallback((ref: string) => {
    setSelectedRef(ref);
    setHistoryOpen(false);
  }, []);

  useEffect(() => {
    const nextTotal = scrollRef.current?.querySelectorAll("mark.agent-conversation-search-match").length || 0;
    setTotalMatches(nextTotal);
    setActiveMatchIndex(current => nextTotal ? Math.min(current, nextTotal - 1) : 0);
  }, [detailMessages, normalizedSearchQuery]);

  useEffect(() => {
    if (!normalizedSearchQuery) {
      lastSearchTargetRef.current = "";
      return;
    }
    if (!totalMatches) return;
    const searchTarget = `${selectedRef}:${normalizedSearchQuery}:${activeMatchIndex}`;
    if (searchTarget === lastSearchTargetRef.current) return;
    lastSearchTargetRef.current = searchTarget;
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-search-index="${activeMatchIndex}"]`)?.scrollIntoView?.({ block: "center" });
    });
  }, [activeMatchIndex, normalizedSearchQuery, selectedRef, totalMatches]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        openSearch();
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        closeSearch();
      } else if (event.key === "Escape" && historyOpen) {
        event.preventDefault();
        setHistoryOpen(false);
      } else if (event.key === "Enter" && searchOpen && normalizedSearchQuery) {
        event.preventDefault();
        moveSearch(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSearch, historyOpen, moveSearch, normalizedSearchQuery, openSearch, searchOpen]);

  const detailTitle = showingLive ? turn?.sessionTitle : selectedHistory?.title;
  const detailProvider = showingLive ? turn?.provider : selectedHistory?.provider;
  const statusText = showingLive
    ? turn?.status === "completed"
      ? (isEnglish ? "Completed" : "已完成")
      : turn?.status === "unsupported"
        ? (isEnglish ? "Live replies unavailable" : "暂不支持实时回复")
        : (isEnglish ? "Running" : "进行中")
    : (isEnglish ? "History" : "历史");

  function renderMessages() {
    if (!showingLive && !selectedHistory) {
      return <div className="agent-conversation-empty">{!session
        ? (isEnglish ? "No Agent conversation for this session yet." : "当前会话暂无 Agent 对话。")
        : (isEnglish ? "Select a conversation to view its messages." : "请选择一条对话查看内容。")}</div>;
    }
    if (showingLive && !turn?.supported) {
      return <div className="agent-conversation-empty"><strong>{isEnglish ? "Remote live replies are unavailable" : "纯远程 SSH 暂不支持实时回复"}</strong><span>{isEnglish ? "Historical messages remain available after the provider saves them." : "Provider 保存后仍可查看历史消息。"}</span></div>;
    }
    if (detailError) {
      return <div className="agent-conversation-empty"><strong>{isEnglish ? "Unable to load conversation" : "无法加载对话"}</strong><span>{detailError}</span></div>;
    }
    if (detailLoading && detailMessages.length === 0) {
      return <div className="agent-conversation-empty">{isEnglish ? "Loading conversation…" : "正在加载对话…"}</div>;
    }
    if (detailMessages.length === 0 && selectedHistory?.captureStatus === "unsupported") return <div className="agent-conversation-empty">暂不支持此 CLI 的结构化对话采集，会话记录已保存。</div>;
    if (detailMessages.length === 0 && selectedHistory?.captureError) return <div className="agent-conversation-empty">{selectedHistory.captureError}</div>;
    if (detailMessages.length === 0) {
      return <div className="agent-conversation-empty">{showingLive ? (isEnglish ? "Waiting for an Agent reply…" : "正在等待 Agent 回复…") : (isEnglish ? "This conversation has no visible messages." : "此对话没有可见消息。")}</div>;
    }
    let searchMatchIndex = 0;
    const nextSearchMatchIndex = () => searchMatchIndex++;
    const highlight = (children: ReactNode) => highlightChildren(children, normalizedSearchQuery, nextSearchMatchIndex, activeMatchIndex);
    return <>
      {messageCursor && !showingLive && (
        <button className="agent-conversation-messages-more" type="button" disabled={detailLoading} onClick={() => void loadMessages(messageCursor, true)}>
          {detailLoading ? (isEnglish ? "Loading…" : "正在加载…") : (isEnglish ? "Load earlier messages" : "加载更早消息")}
        </button>
      )}
      {detailMessages.map(message => (
        <article className={`agent-conversation-message ${message.kind}`} key={message.id}>
          {message.kind !== "reply" && (
            <div className="agent-conversation-message-kind">
              {message.kind === "user"
                ? (isEnglish ? "You" : "用户")
                : message.kind === "final"
                  ? (isEnglish ? "Final reply" : "最终回复")
                  : message.kind === "reasoning" ? (isEnglish ? "Reasoning" : "推理")
                  : message.kind === "tool" ? (isEnglish ? "Tool / event" : "工具 / 事件")
                  : (isEnglish ? "Progress update" : "中间回复")}
            </div>
          )}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p>{highlight(children)}</p>,
              li: ({ children }) => <li>{highlight(children)}</li>,
              td: ({ children }) => <td>{highlight(children)}</td>,
              th: ({ children }) => <th>{highlight(children)}</th>,
              h1: ({ children }) => <h1>{highlight(children)}</h1>,
              h2: ({ children }) => <h2>{highlight(children)}</h2>,
              h3: ({ children }) => <h3>{highlight(children)}</h3>,
              h4: ({ children }) => <h4>{highlight(children)}</h4>,
              h5: ({ children }) => <h5>{highlight(children)}</h5>,
              h6: ({ children }) => <h6>{highlight(children)}</h6>,
              blockquote: ({ children }) => <blockquote>{highlight(children)}</blockquote>,
              code: ({ children, className }) => <code className={className}>{highlight(children)}</code>,
              a: ({ href, children }) => (
                <a href={href} onClick={event => { event.preventDefault(); if (href) void window.agentConversationApi.openExternal(href); }}>
                  {highlight(children)}
                </a>
              )
            }}
          >
            {message.text}
          </ReactMarkdown>
        </article>
      ))}
    </>;
  }

  return (
    <section className={`agent-conversation-panel${historyOpen ? " history-open" : ""}${searchOpen ? " searching" : ""}`} aria-label={isEnglish ? "Agent conversation" : "Agent 对话"}>
      <aside id="agent-conversation-history" className="agent-conversation-history" aria-label={isEnglish ? "Conversation history" : "对话历史"} hidden={!historyOpen}>
        <div className="agent-conversation-history-filters">
          {(
            <SearchableSelect
              className="agent-conversation-history-source"
              value={historyDeviceId}
              onChange={setHistoryDeviceId}
              ariaLabel={isEnglish ? "Conversation source" : "对话来源"}
              options={[
                { value: "archive", label: isEnglish ? "Local archive" : "本地留档" },
                { value: "local", label: isEnglish ? "CLI original history" : "CLI 原始历史" },
                ...backupDevices.map(device => ({ value: device.id, label: device.name }))
              ]}
            />
          )}
          <div className="agent-conversation-history-provider" role="group" aria-label={isEnglish ? "Provider" : "Agent 类型"}>
            {historyProviderFilters.map(provider => (
              <button className={providerFilter === provider ? "active" : ""} key={provider} type="button" onClick={() => setProviderFilter(provider)}>
                {provider === "all" ? (isEnglish ? "All" : "全部") : providerName(provider)}
              </button>
            ))}
          </div>
          <div className="agent-conversation-history-options">
            <button className={scope === "all" ? "active" : ""} type="button" onClick={() => setScope(current => current === "cwd" ? "all" : "cwd")}>
              {scope === "cwd" ? (isEnglish ? "Current directory" : "当前目录") : (isEnglish ? "All directories" : "全部目录")}
            </button>
            <label><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />{isEnglish ? "Archived" : "归档"}</label>
          </div>
          <label className="agent-conversation-history-search">
            <Search aria-hidden="true" />
            <input type="search" value={historyQuery} placeholder={isEnglish ? "Search sessions" : "搜索会话"} onChange={event => setHistoryQuery(event.target.value)} />
          </label>
        </div>
        <div className="agent-conversation-history-list">
          {turn && (historyDeviceId === "local" || historyDeviceId === "archive") && (
            <button className={`agent-conversation-history-item live${selectedRef === "live" ? " active" : ""}`} type="button" onClick={() => selectConversation("live")}>
              <span><strong>{isEnglish ? "Current conversation" : "当前对话"}</strong><small className={`agent-conversation-provider ${turn.provider}`}>{providerName(turn.provider)}</small></span>
            </button>
          )}
          {historyItems.map(item => (
            <button className={`agent-conversation-history-item${selectedRef === item.ref ? " active" : ""}`} key={item.ref} type="button" onClick={() => selectConversation(item.ref)}>
              <span><strong>{item.title}</strong><small className={`agent-conversation-provider ${item.provider}`}>{providerName(item.provider)}</small></span>
              <small title={item.cwd}>{item.cwd}</small>
              {item.status && <small>{item.status === "running" ? "进行中" : item.status === "failed" ? "启动失败" : item.status === "interrupted" ? "已中断" : "已结束"} · {item.mode === "graphical" ? "图形" : "终端"}</small>}
              {item.captureStatus === "unsupported" && <small>暂不支持对话采集</small>}
              {item.captureStatus === "waiting" && <small>等待对话采集</small>}
              {item.captureError && <small role="status">{item.captureError}</small>}
              <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleString(locale)}</time>
            </button>
          ))}
          {historyLoading && <div className="agent-conversation-history-empty">{isEnglish ? "Loading…" : "正在加载…"}</div>}
          {!historyLoading && !turn && historyItems.length === 0 && <div className="agent-conversation-history-empty">{isEnglish ? "No conversations found." : "未找到对话历史。"}</div>}
          {historyCursor && !historyLoading && <button className="agent-conversation-history-more" type="button" onClick={() => void loadHistory(historyCursor, true)}>{isEnglish ? "Load more" : "加载更多"}</button>}
          {historyErrors.map(error => <div className="agent-conversation-history-error" key={error.provider}>{error.message}</div>)}
        </div>
      </aside>

      <div className="agent-conversation-detail">
        <header className="agent-conversation-header">
          <div className="agent-conversation-heading">
            {detailProvider && <span className={`agent-conversation-provider ${detailProvider}`}>{providerName(detailProvider)}</span>}
            <span className="agent-conversation-title">{detailTitle || (isEnglish ? "Agent conversation" : "Agent 对话")}</span>
            {(turn || selectedHistory) && <span className={`agent-conversation-status ${showingLive ? turn?.status : "completed"}`}>{statusText}</span>}
          </div>
          <div className="agent-conversation-header-actions">
            <button
              className="agent-conversation-history-toggle"
              type="button"
              title={historyOpen ? (isEnglish ? "Collapse conversation history" : "收起对话历史") : (isEnglish ? "Expand conversation history" : "展开对话历史")}
              aria-label={historyOpen ? (isEnglish ? "Collapse conversation history" : "收起对话历史") : (isEnglish ? "Expand conversation history" : "展开对话历史")}
              aria-controls="agent-conversation-history"
              aria-expanded={historyOpen}
              onClick={toggleHistory}
            >
              <History aria-hidden="true" />
            </button>
            <button className="agent-conversation-search-toggle" type="button" title={isEnglish ? "Search content" : "搜索内容"} aria-label={isEnglish ? "Search content" : "搜索内容"} onClick={openSearch}>
              <Search aria-hidden="true" />
            </button>
          </div>
        </header>
        {searchOpen && (
          <div className="agent-conversation-search" role="search" aria-label={isEnglish ? "Content search" : "内容搜索"}>
            <Search aria-hidden="true" />
            <input ref={searchInputRef} type="search" value={searchQuery} aria-label={isEnglish ? "Search conversation content" : "搜索对话内容"} placeholder={isEnglish ? "Search" : "搜索内容"} onChange={event => { setSearchQuery(event.target.value); setActiveMatchIndex(0); }} />
            <span className="agent-conversation-search-count" aria-live="polite">{totalMatches ? activeMatchIndex + 1 : 0}/{totalMatches}</span>
            <button type="button" aria-label={isEnglish ? "Previous match" : "上一个匹配项"} disabled={!totalMatches} onClick={() => moveSearch(-1)}><ChevronUp aria-hidden="true" /></button>
            <button type="button" aria-label={isEnglish ? "Next match" : "下一个匹配项"} disabled={!totalMatches} onClick={() => moveSearch(1)}><ChevronDown aria-hidden="true" /></button>
            <button type="button" aria-label={isEnglish ? "Close search" : "关闭搜索"} onClick={closeSearch}><X aria-hidden="true" /></button>
          </div>
        )}
        <div className="agent-conversation-messages" ref={scrollRef}>
          {renderMessages()}
        </div>
      </div>
    </section>
  );
}
