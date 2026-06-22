import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, File, Folder, ImagePlus, LoaderCircle } from "lucide-react";
import { useI18n } from "../../i18n";
import type { TerminalSession, WorkspaceEntrySearchResult } from "../../vite-env";
import { applyCompletion, isCurrentCompletion, type CompletionCandidate } from "./composerCompletion";

type TerminalComposerProps = {
  session?: TerminalSession;
};

type Mention = {
  start: number;
  end: number;
  query: string;
};

function getMentionAtCaret(value: string, caret: number): Mention | null {
  const prefix = value.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const token = match[0];
  const atOffset = token.lastIndexOf("@");
  return {
    start: prefix.length - token.length + atOffset,
    end: caret,
    query: match[1]
  };
}

function getImageRelativePath(session: TerminalSession, savedPath: string) {
  const normalized = savedPath.replace(/\\/g, "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const separator = session.type === "windows" ? "\\" : "/";
  return `.pannel-handle-images${separator}${fileName}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

export function TerminalComposer({ session }: TerminalComposerProps) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mention, setMention] = useState<Mention | null>(null);
  const [results, setResults] = useState<WorkspaceEntrySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [imageStatus, setImageStatus] = useState<"idle" | "uploading" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [cursor, setCursor] = useState(0);
  const [completion, setCompletion] = useState<CompletionCandidate | null>(null);
  const [completionLoading, setCompletionLoading] = useState(false);
  const [completionError, setCompletionError] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [scrollPosition, setScrollPosition] = useState({ top: 0, left: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const completionRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const value = session ? drafts[session.id] ?? "" : "";

  const mentionVisible = Boolean(session && mention);
  const currentMentionQuery = mention?.query ?? "";
  const canSend = Boolean(session && value.trim());
  const activeCompletion = isCurrentCompletion(completion, value, cursor) ? completion : null;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const contentHeight = Math.max(textarea.scrollHeight, mirrorRef.current?.scrollHeight || 0);
    textarea.style.height = `${Math.min(contentHeight, 144)}px`;
  }, [activeCompletion, value]);

  useEffect(() => {
    setMention(null);
    setResults([]);
    setSelectedIndex(0);
    setImageStatus("idle");
    setStatusMessage("");
    setCursor(0);
    setCompletion(null);
    setCompletionLoading(false);
    setCompletionError("");
    completionRequestRef.current += 1;
  }, [session?.id]);

  useEffect(() => {
    const requestId = completionRequestRef.current + 1;
    completionRequestRef.current = requestId;
    setCompletion(null);
    setCompletionLoading(false);
    setCompletionError("");
    if (!session || !value.trim() || isComposing || mention) return undefined;

    const snapshot = { sessionId: session.id, draft: value, cursor };
    const timer = window.setTimeout(async () => {
      try {
        const config = await window.completionApi.getConfig();
        if (completionRequestRef.current !== requestId || !config.enabled || !config.hasApiKey || !config.model) return;
        setCompletionLoading(true);
        const result = await window.completionApi.complete(snapshot);
        if (completionRequestRef.current !== requestId) return;
        if (result.completion) setCompletion({ completion: result.completion, draft: value, cursor });
      } catch (error) {
        if (completionRequestRef.current === requestId) {
          setCompletionError(t("composer.completionFailed", { message: getErrorMessage(error) }));
        }
      } finally {
        if (completionRequestRef.current === requestId) setCompletionLoading(false);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [cursor, isComposing, mention, session, t, value]);

  useEffect(() => {
    if (!session || !mention) return undefined;
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setSearching(true);
    const timer = window.setTimeout(() => {
      window.projectSearchApi.searchWorkspaceEntries(session.id, currentMentionQuery)
        .then((response) => {
          if (searchRequestRef.current !== requestId) return;
          setResults(response.results);
          setSelectedIndex(0);
        })
        .catch((error) => {
          if (searchRequestRef.current !== requestId) return;
          setResults([]);
          setImageStatus("error");
          setStatusMessage(t("composer.searchFailed", { message: getErrorMessage(error) }));
        })
        .finally(() => {
          if (searchRequestRef.current === requestId) setSearching(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [currentMentionQuery, mention, session, t]);

  const selectedResult = useMemo(() => results[selectedIndex], [results, selectedIndex]);

  const updateDraft = (nextValue: string, caret?: number) => {
    if (!session) return;
    setDrafts((current) => ({ ...current, [session.id]: nextValue }));
    const nextCaret = caret ?? textareaRef.current?.selectionStart ?? nextValue.length;
    setCursor(nextCaret);
    setMention(getMentionAtCaret(nextValue, nextCaret));
  };

  const insertText = (text: string, range?: { start: number; end: number }) => {
    if (!session) return;
    const textarea = textareaRef.current;
    const start = range?.start ?? textarea?.selectionStart ?? value.length;
    const end = range?.end ?? textarea?.selectionEnd ?? start;
    const nextValue = `${value.slice(0, start)}${text}${value.slice(end)}`;
    const nextCaret = start + text.length;
    setDrafts((current) => ({ ...current, [session.id]: nextValue }));
    setCursor(nextCaret);
    setCompletion(null);
    setMention(null);
    setResults([]);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const selectEntry = (entry: WorkspaceEntrySearchResult) => {
    if (!session || !mention) return;
    const separator = session.type === "windows" ? "\\" : "/";
    const suffix = entry.type === "directory" ? separator : "";
    insertText(`@${entry.relativePath}${suffix} `, mention);
  };

  const submit = () => {
    if (!session || !value.trim()) return;
    window.terminalApi.write(session.id, `${value}\r`);
    setDrafts((current) => ({ ...current, [session.id]: "" }));
    setMention(null);
    setResults([]);
    setCursor(0);
    setCompletion(null);
  };

  const acceptCompletion = () => {
    if (!session || !activeCompletion) return;
    const next = applyCompletion(value, cursor, activeCompletion.completion);
    setDrafts((current) => ({ ...current, [session.id]: next.value }));
    setCursor(next.cursor);
    setCompletion(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const pasteClipboardImage = async () => {
    if (!session || imageStatus === "uploading") return;
    setImageStatus("uploading");
    setStatusMessage(t("composer.uploadingImage"));
    try {
      const result = await window.clipboardApi.pasteImageToSession(session.id);
      if (result.status === "no_image") {
        setImageStatus("error");
        setStatusMessage(t("composer.noClipboardImage"));
        return;
      }
      insertText(`@${getImageRelativePath(session, result.path)} `);
      setImageStatus("idle");
      setStatusMessage("");
    } catch (error) {
      setImageStatus("error");
      setStatusMessage(t("composer.imageUploadFailed", { message: getErrorMessage(error) }));
    }
  };

  return (
    <div className="terminal-composer-wrap">
      {mentionVisible && (
        <div className="terminal-composer-mentions" role="listbox" aria-label={t("composer.searchWorkspace")}>
          <div className="terminal-composer-mentions-heading">
            <span>{t("composer.searchWorkspace")}</span>
            {searching && <LoaderCircle className="spin" aria-hidden="true" />}
          </div>
          {!searching && results.length === 0 ? (
            <div className="terminal-composer-empty">{t("composer.noMatches")}</div>
          ) : results.map((entry, index) => (
            <button
              className={index === selectedIndex ? "selected" : ""}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              key={`${entry.type}:${entry.path}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => selectEntry(entry)}
            >
              {entry.type === "directory" ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}
              <span className="terminal-composer-entry-name">{entry.name}</span>
              <span className="terminal-composer-entry-path">{entry.relativePath}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`terminal-composer ${imageStatus === "error" || completionError ? "has-error" : ""}`}>
        <div className="terminal-composer-input">
          {activeCompletion && (
            <div
              ref={mirrorRef}
              className="terminal-composer-mirror"
              aria-hidden="true"
              style={{ transform: `translate(${-scrollPosition.left}px, ${-scrollPosition.top}px)` }}
            >
              <span>{value.slice(0, cursor)}</span>
              <span className="terminal-composer-ghost">{activeCompletion.completion}</span>
              <span>{value.slice(cursor) || "\u200b"}</span>
            </div>
          )}
          <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={!session}
          aria-label={t("composer.inputLabel")}
          placeholder={session ? t("composer.placeholder") : t("app.noActiveSession")}
          className={activeCompletion ? "has-completion" : ""}
          onChange={(event) => updateDraft(event.target.value, event.target.selectionStart)}
          onClick={(event) => {
            setCursor(event.currentTarget.selectionStart);
            setMention(getMentionAtCaret(value, event.currentTarget.selectionStart));
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(event) => {
            setIsComposing(false);
            updateDraft(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onScroll={(event) => setScrollPosition({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && (event.ctrlKey || event.altKey || event.metaKey) && !event.shiftKey) {
              event.preventDefault();
              insertText("\n");
              return;
            }
            if (mention && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setSelectedIndex((current) => results.length ? (current + direction + results.length) % results.length : 0);
              return;
            }
            if (mention && (event.key === "Enter" || event.key === "Tab") && selectedResult) {
              event.preventDefault();
              selectEntry(selectedResult);
              return;
            }
            if (activeCompletion && event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault();
              acceptCompletion();
              return;
            }
            if (session && event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault();
              window.terminalApi.write(session.id, "\x1b[Z");
              return;
            }
            if (mention && event.key === "Escape") {
              event.preventDefault();
              setMention(null);
              return;
            }
            if (activeCompletion && event.key === "Escape") {
              event.preventDefault();
              setCompletion(null);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          onPaste={(event) => {
            const hasImage = Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"));
            if (!hasImage) return;
            event.preventDefault();
            void pasteClipboardImage();
          }}
          />
        </div>
        <div className="terminal-composer-actions">
          <button
            className="terminal-composer-image"
            type="button"
            disabled={!session || imageStatus === "uploading"}
            title={t("composer.pasteImage")}
            aria-label={t("composer.pasteImage")}
            onClick={() => void pasteClipboardImage()}
          >
            {imageStatus === "uploading" ? <LoaderCircle className="spin" aria-hidden="true" /> : <ImagePlus aria-hidden="true" />}
          </button>
          <button
            className="terminal-composer-send"
            type="button"
            disabled={!canSend}
            title={t("composer.send")}
            aria-label={t("composer.send")}
            onClick={submit}
          >
            <ArrowUp aria-hidden="true" />
          </button>
        </div>
      </div>
      {(statusMessage || completionLoading || completionError) && (
        <div className={`terminal-composer-status ${imageStatus === "error" || completionError ? "error" : ""}`} role="status">
          {statusMessage || completionError || (completionLoading ? t("composer.suggesting") : "")}
        </div>
      )}
    </div>
  );
}
