import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CodeBuddyMcpAppData, CodeBuddyMcpApi } from "../../vite-env";
import "./codebuddy-mcp.css";

type MessageContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
export const CodeBuddyMcpAppContext = createContext<{
  api?: CodeBuddyMcpApi; openLink?: (url: string) => Promise<unknown>;
  sessionId: string; threadId: string; enabled: boolean;
  fillMessage: (itemId: string, content: MessageContent) => Promise<void>;
} | null>(null);

function domains(values: string[] | undefined) {
  return (values || []).filter(value => /^https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i.test(value)).join(" ");
}
export function mcpAppDocument(html: string, csp?: CodeBuddyMcpAppData["csp"]) {
  const resources = domains(csp?.resourceDomains);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: blob: ${resources}; font-src data: ${resources}; connect-src ${domains(csp?.connectDomains) || "'none'"}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
  doc.head.prepend(policy);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

type Grant = Awaited<ReturnType<CodeBuddyMcpApi["prepare"]>>;
export function CodeBuddyMcpApp({ itemId, revision }: { itemId: string; revision?: number }) {
  const context = useContext(CodeBuddyMcpAppContext);
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [height, setHeight] = useState(320);
  const [pending, setPending] = useState<Grant | null>(null);
  const answer = useRef<((approved: boolean) => void) | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const latestData = useRef<CodeBuddyMcpAppData | null>(null);
  const ready = useRef(false);
  const callPending = useRef(false);
  const hostContext = useRef<Parameters<AppBridge["setHostContext"]>[0]>({});
  const modeRef = useRef(fullscreen); modeRef.current = fullscreen;
  const fillRef = useRef(context?.fillMessage);
  fillRef.current = context?.fillMessage;

  useEffect(() => {
    if (!context?.enabled || !frame.current) return;
    const { sessionId, threadId } = context;
    const iframe = frame.current;
    let active = true;
    let initialized = false;
    let bridge: AppBridge | undefined;
    let themeObserver: MutationObserver | undefined;
    setError(""); setLoading(true); ready.current = false;
    const check = () => { if (!active) throw new Error("MCP App 所属对话已失效。"); };
    const updateTheme = () => {
      const root = document.documentElement;
      const theme = root.dataset.theme === "light" || root.classList.contains("light") || getComputedStyle(root).colorScheme === "light" ? "light" : "dark";
      hostContext.current = { theme, displayMode: modeRef.current ? "fullscreen" : "inline", availableDisplayModes: ["inline", "fullscreen"],
        locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      bridge?.setHostContext(hostContext.current);
    };
    const api = context.api || window.codeBuddyMcpApi;
    void (async () => {
      const data = await api.load(sessionId, threadId, itemId);
      check(); latestData.current = data;
      let html = data.html;
      let csp = data.csp;
      if (html === undefined && data.toolResourceUri) {
        const resource = await api.read(sessionId, threadId, itemId, data.toolResourceUri);
        check();
        const content = resource.contents.find(value => value.uri === data.toolResourceUri && value.mimeType === "text/html;profile=mcp-app");
        if (!content?.text) throw new Error("服务器未返回 MCP App HTML 资源。");
        html = content.text; csp = content._meta?.ui?.csp;
      }
      if (typeof html !== "string") throw new Error("MCP App 没有可显示的内容。");
      bridge = new AppBridge(null, { name: "Pannel Handle", version: "1.0.0" },
        { openLinks: {}, serverTools: {}, serverResources: {}, message: { text: {}, image: {} } });
      bridgeRef.current = bridge;
      bridge.onreadresource = async ({ uri }) => {
        check();
        const result = await api.read(sessionId, threadId, itemId, uri);
        check();
        return result as Awaited<ReturnType<NonNullable<AppBridge["onreadresource"]>>>;
      };
      bridge.oncalltool = async ({ name, arguments: args }) => {
        check();
        if (callPending.current) throw new Error("请先处理当前工具授权。");
        callPending.current = true;
        try {
        const grant = await api.prepare(sessionId, threadId, itemId, name, args || {});
        check();
        const approved = await new Promise<boolean>(resolve => { answer.current = resolve; setPending(grant); });
        answer.current = null; setPending(null);
        check();
        const result = await api.resolve(sessionId, grant.token, approved);
        check();
        return result as Awaited<ReturnType<NonNullable<AppBridge["oncalltool"]>>>;
        } finally { callPending.current = false; }
      };
      bridge.onopenlink = async ({ url }) => {
        check();
        if (!/^https?:\/\//i.test(url)) throw new Error("仅支持 HTTP(S) 外链。");
        await (context.openLink ? context.openLink(url) : window.externalLinkApi.open(url));
        return {};
      };
      bridge.onmessage = async ({ content }) => {
        check();
        await fillRef.current?.(itemId, content as MessageContent);
        check();
        return {};
      };
      bridge.onrequestdisplaymode = async ({ mode }) => {
        check();
        if (mode !== "inline" && mode !== "fullscreen") throw new Error("不支持此显示模式。");
        setFullscreen(mode === "fullscreen");
        return { mode };
      };
      bridge.onsizechange = ({ height: next }) => { if (active && typeof next === "number") setHeight(Math.max(120, Math.min(next, 900))); };
      bridge.oninitialized = () => {
        if (!active) return;
        initialized = true; ready.current = true; setLoading(false); updateTheme();
        const current = latestData.current || data;
        if (current.toolInput) void bridge?.sendToolInput({ arguments: current.toolInput }).catch(() => {});
        if (current.toolResult) void bridge?.sendToolResult(current.toolResult as Parameters<AppBridge["sendToolResult"]>[0]).catch(() => {});
      };
      bridge.onerror = cause => { if (active) setError(cause.message); };
      await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
      check();
      iframe.srcdoc = mcpAppDocument(html, csp);
      themeObserver = new MutationObserver(updateTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    })().catch(cause => { if (active) { setLoading(false); setError(cause instanceof Error ? cause.message : String(cause)); } });
    const timer = window.setTimeout(() => { if (active && !initialized) { setLoading(false); setError(current => current || "MCP App 初始化超时，可重试加载。"); } }, 20000);
    return () => {
      active = false; ready.current = false; clearTimeout(timer); themeObserver?.disconnect();
      answer.current?.(false); answer.current = null;
      bridgeRef.current = null;
      void bridge?.teardownResource({}, { timeout: 1000 }).catch(() => {}).finally(() => bridge?.close());
      void api.dispose(sessionId, threadId, itemId).catch(() => {});
      iframe.srcdoc = "";
    };
  }, [context?.sessionId, context?.threadId, context?.enabled, itemId, retry]);

  useEffect(() => {
    if (!context?.enabled || !revision) return;
    let active = true;
    void (context.api || window.codeBuddyMcpApi).load(context.sessionId, context.threadId, itemId).then(data => {
      if (!active) return;
      latestData.current = data;
      if (!ready.current) return;
      if (data.toolInput) void bridgeRef.current?.sendToolInput({ arguments: data.toolInput }).catch(() => {});
      if (data.toolResult) void bridgeRef.current?.sendToolResult(data.toolResult as Parameters<AppBridge["sendToolResult"]>[0]).catch(() => {});
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [context?.enabled, context?.sessionId, context?.threadId, itemId, revision]);

  useEffect(() => {
    bridgeRef.current?.setHostContext({ ...hostContext.current, displayMode: fullscreen ? "fullscreen" : "inline" });
  }, [fullscreen]);

  if (!context?.enabled) return <p>MCP App 交互仅支持当前 Windows 本机 CodeBuddy 对话。</p>;
  return <div className={`codebuddy-mcp-app${fullscreen ? " fullscreen" : ""}`}>
    <div className="codebuddy-mcp-app-actions"><strong>MCP App</strong>
      <button type="button" onClick={() => setFullscreen(value => !value)}>{fullscreen ? "退出全屏" : "全屏"}</button>
      <button type="button" onClick={() => { answer.current?.(false); setPending(null); setRetry(value => value + 1); }}>重新加载</button></div>
    {loading && <p role="status">正在加载 MCP App…</p>}
    {error && <p role="alert">{error}</p>}
    {pending && <div role="dialog" aria-label="MCP App 工具授权" className="codebuddy-mcp-app-approval">
      <p>允许 {pending.serverName} 调用 {pending.toolName}？</p><pre>{JSON.stringify(pending.arguments, null, 2)}</pre>
      <button type="button" onClick={() => answer.current?.(true)}>允许本次</button>
      <button type="button" onClick={() => answer.current?.(false)}>拒绝</button>
    </div>}
    <iframe ref={frame} title="MCP App 沙箱" sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" style={{ height: fullscreen ? "100%" : height }} />
    <small>App 消息会回填草稿，由你确认发送。</small>
  </div>;
}
