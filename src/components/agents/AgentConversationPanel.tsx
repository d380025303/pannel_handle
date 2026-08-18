import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentConversationSnapshot } from "../../vite-env";
import { useI18n } from "../../i18n";

function providerName(provider?: "codex" | "codebuddy") {
  return provider === "codebuddy" ? "CodeBuddy" : "Codex";
}

function highlightText(
  text: string,
  query: string,
  nextIndex: () => number,
  activeIndex: number
): ReactNode {
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

function highlightChildren(
  children: ReactNode,
  query: string,
  nextIndex: () => number,
  activeIndex: number
): ReactNode {
  if (typeof children === "string") return highlightText(children, query, nextIndex, activeIndex);
  if (Array.isArray(children)) {
    return children.map(child => highlightChildren(child, query, nextIndex, activeIndex));
  }
  if (!isValidElement<{ children?: ReactNode }>(children) || children.type === "mark" || children.props.children === undefined) {
    return children;
  }
  return cloneElement(
    children,
    undefined,
    highlightChildren(children.props.children, query, nextIndex, activeIndex)
  );
}

export function AgentConversationPanel({ snapshot }: { snapshot: AgentConversationSnapshot | null }) {
  const { locale } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const followBottomRef = useRef(true);

  useEffect(() => {
    if (!followBottomRef.current || searchQuery.trim()) return;
    requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }, [searchQuery, snapshot?.turn?.messages.length]);

  const isEnglish = locale === "en-US";
  const turn = snapshot?.turn;
  const normalizedSearchQuery = searchQuery.trim();

  const openSearch = useCallback(() => {
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
    if (!totalMatches) return;
    setActiveMatchIndex(current => (current + direction + totalMatches) % totalMatches);
  }, [totalMatches]);

  useEffect(() => {
    const nextTotal = scrollRef.current?.querySelectorAll("mark.agent-conversation-search-match").length || 0;
    setTotalMatches(nextTotal);
    setActiveMatchIndex(current => nextTotal ? Math.min(current, nextTotal - 1) : 0);
  }, [normalizedSearchQuery, turn?.messages]);

  useEffect(() => {
    if (!normalizedSearchQuery || !totalMatches) return;
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-search-index="${activeMatchIndex}"]`)?.scrollIntoView?.({ block: "center" });
    });
  }, [activeMatchIndex, normalizedSearchQuery, totalMatches]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        openSearch();
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        closeSearch();
      } else if (event.key === "Enter" && searchOpen && normalizedSearchQuery) {
        event.preventDefault();
        moveSearch(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSearch, moveSearch, normalizedSearchQuery, openSearch, searchOpen]);
  const statusText = turn?.status === "completed"
    ? (isEnglish ? "Completed" : "已完成")
    : turn?.status === "unsupported"
      ? (isEnglish ? "Live replies unavailable" : "暂不支持实时回复")
      : (isEnglish ? "Running" : "进行中");

  return (
    <section className={`agent-conversation-panel${searchOpen ? " searching" : ""}`} aria-label={isEnglish ? "Agent conversation" : "Agent 对话"}>
      <header className="agent-conversation-header">
        <div className="agent-conversation-heading">
          {turn && <span className={`agent-conversation-provider ${turn.provider}`}>{providerName(turn.provider)}</span>}
          <span className="agent-conversation-title">{turn?.sessionTitle || (isEnglish ? "Agent conversation" : "Agent 对话")}</span>
          {turn && <span className={`agent-conversation-status ${turn.status}`}>{statusText}</span>}
        </div>
        <button
          className="agent-conversation-search-toggle"
          type="button"
          title={isEnglish ? "Search content" : "搜索内容"}
          aria-label={isEnglish ? "Search content" : "搜索内容"}
          onClick={openSearch}
        >
          <Search aria-hidden="true" />
        </button>
      </header>

      {searchOpen && (
        <div className="agent-conversation-search" role="search" aria-label={isEnglish ? "Content search" : "内容搜索"}>
          <Search aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            aria-label={isEnglish ? "Search conversation content" : "搜索对话内容"}
            placeholder={isEnglish ? "Search" : "搜索内容"}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setActiveMatchIndex(0);
            }}
          />
          <span className="agent-conversation-search-count" aria-live="polite">
            {totalMatches ? activeMatchIndex + 1 : 0}/{totalMatches}
          </span>
          <button type="button" aria-label={isEnglish ? "Previous match" : "上一个匹配项"} disabled={!totalMatches} onClick={() => moveSearch(-1)}>
            <ChevronUp aria-hidden="true" />
          </button>
          <button type="button" aria-label={isEnglish ? "Next match" : "下一个匹配项"} disabled={!totalMatches} onClick={() => moveSearch(1)}>
            <ChevronDown aria-hidden="true" />
          </button>
          <button type="button" aria-label={isEnglish ? "Close search" : "关闭搜索"} onClick={closeSearch}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <div
        className="agent-conversation-messages"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {!turn ? (
          <div className="agent-conversation-empty">
            {isEnglish ? "No Agent conversation for this session yet." : "当前会话暂无 Agent 对话。"}
          </div>
        ) : !turn.supported ? (
          <div className="agent-conversation-empty">
            <strong>{isEnglish ? "Remote live replies are unavailable" : "纯远程 SSH 暂不支持实时回复"}</strong>
            <span>{isEnglish ? "Open the terminal session to view this Agent response." : "请返回终端会话查看本轮 Agent 回复。"}</span>
          </div>
        ) : turn.messages.length === 0 ? (
          <div className="agent-conversation-empty">{isEnglish ? "Waiting for an Agent reply…" : "正在等待 Agent 回复…"}</div>
        ) : (() => {
          let searchMatchIndex = 0;
          const nextSearchMatchIndex = () => searchMatchIndex++;
          const highlight = (children: ReactNode) => highlightChildren(children, normalizedSearchQuery, nextSearchMatchIndex, activeMatchIndex);
          return turn.messages.map(message => (
          <article className={`agent-conversation-message ${message.kind}`} key={message.id}>
            {message.kind !== "reply" && (
              <div className="agent-conversation-message-kind">
                {message.kind === "final"
                  ? (isEnglish ? "Final reply" : "最终回复")
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
                  <a href={href} onClick={(event) => { event.preventDefault(); if (href) void window.agentConversationApi.openExternal(href); }}>
                    {highlight(children)}
                  </a>
                )
              }}
            >
              {message.text}
            </ReactMarkdown>
          </article>
          ));
        })()}
      </div>
    </section>
  );
}
