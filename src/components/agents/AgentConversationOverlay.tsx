import { useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentConversationSnapshot } from "../../vite-env";

function providerName(provider?: "codex" | "codebuddy") {
  return provider === "codebuddy" ? "CodeBuddy" : "Codex";
}

export function AgentConversationOverlay() {
  const [snapshot, setSnapshot] = useState<AgentConversationSnapshot | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followBottomRef = useRef(true);

  useEffect(() => {
    let disposed = false;
    document.body.classList.add("agent-conversation-window-body");
    void window.agentConversationApi.getSnapshot().then(value => {
      if (!disposed) setSnapshot(value);
    });
    const removeListener = window.agentConversationApi.onSnapshot(value => {
      if (!disposed) setSnapshot(value);
    });
    return () => {
      disposed = true;
      removeListener();
      document.body.classList.remove("agent-conversation-window-body");
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    document.documentElement.dataset.theme = snapshot.themeId;
    document.documentElement.lang = snapshot.locale;
  }, [snapshot]);

  useEffect(() => {
    if (!followBottomRef.current) return;
    requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }, [snapshot?.turn?.messages.length]);

  const locale = snapshot?.locale || "zh-CN";
  const isEnglish = locale === "en-US";
  const turn = snapshot?.turn;
  const statusText = turn?.status === "completed"
    ? (isEnglish ? "Completed" : "已完成")
    : turn?.status === "unsupported"
      ? (isEnglish ? "Live replies unavailable" : "暂不支持实时回复")
      : (isEnglish ? "Running" : "进行中");

  return (
    <section className="agent-conversation-overlay" aria-label={isEnglish ? "Agent conversation" : "Agent 对话"}>
      <header className="agent-conversation-header">
        <button
          className="agent-conversation-session"
          type="button"
          title={isEnglish ? "Return to this session" : "返回当前会话"}
          onClick={() => window.agentConversationApi.focusSession()}
        >
          <span className={`agent-conversation-provider ${turn?.provider || "codex"}`}>{providerName(turn?.provider)}</span>
          <span className="agent-conversation-title">{turn?.sessionTitle || (isEnglish ? "Agent conversation" : "Agent 对话")}</span>
          <ExternalLink aria-hidden="true" />
        </button>
        <span className={`agent-conversation-status ${turn?.status || "running"}`}>{statusText}</span>
        <button className="agent-conversation-close" type="button" aria-label={isEnglish ? "Close" : "关闭"} onClick={() => window.agentConversationApi.hide()}>
          <X aria-hidden="true" />
        </button>
      </header>

      <div
        className="agent-conversation-messages"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {!turn?.supported ? (
          <div className="agent-conversation-empty">
            <strong>{isEnglish ? "Remote live replies are unavailable" : "纯远程 SSH 暂不支持实时回复"}</strong>
            <span>{isEnglish ? "Open the terminal session to view this Agent response." : "请返回终端会话查看本轮 Agent 回复。"}</span>
          </div>
        ) : turn.messages.length === 0 ? (
          <div className="agent-conversation-empty">{isEnglish ? "Waiting for an Agent reply…" : "正在等待 Agent 回复…"}</div>
        ) : turn.messages.map(message => (
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
                a: ({ href, children }) => (
                  <a href={href} onClick={(event) => { event.preventDefault(); if (href) void window.agentConversationApi.openExternal(href); }}>
                    {children}
                  </a>
                )
              }}
            >
              {message.text}
            </ReactMarkdown>
          </article>
        ))}
      </div>
    </section>
  );
}
