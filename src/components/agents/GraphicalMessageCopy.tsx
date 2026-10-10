import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { CodexAppServerSnapshot } from "../../vite-env";

export function graphicalMessageText(item: CodexAppServerSnapshot["items"][number]) {
  const textParts = item.type === "userMessage" ? item.parts?.filter(part => part.type === "text") : undefined;
  return textParts?.length ? textParts.map(part => part.text).join("") : item.text || "";
}

export function GraphicalMessageCopy({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);
  if (!text.trim()) return null;
  const label = status === "copied" ? "已复制" : status === "failed" ? "复制失败，请重试" : "复制消息";
  async function copy() {
    clearTimeout(timer.current);
    setStatus("copying");
    let copied = false;
    try { copied = await window.clipboardApi.writeText(text); } catch { /* Show a retryable failure. */ }
    if (!mounted.current) return;
    setStatus(copied ? "copied" : "failed");
    if (copied) timer.current = setTimeout(() => setStatus("idle"), 2000);
  }
  return <span className="graphical-message-copy-control" data-status={status}>
    <button type="button" aria-label={label} title={label} disabled={status === "copying"} onClick={() => void copy()}>
      {status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
    <span className="graphical-message-copy-feedback" role="status">{status === "copied" || status === "failed" ? label : ""}</span>
  </span>;
}
