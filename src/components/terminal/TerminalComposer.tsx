import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, File, Folder, ImagePlus, LoaderCircle } from "lucide-react";
import { useI18n } from "../../i18n";
import type { TerminalSession, WorkspaceEntrySearchResult } from "../../vite-env";
import { applyCompletion, editDistance, getCompletionTrigger, isCurrentCompletion, type CompletionCandidate } from "./composerCompletion";
import { submitTerminalInput } from "./terminalComposerInput";

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
  const completionRef = useRef<CompletionCandidate | null>(null);
  const feedbackRef = useRef<Map<string, Set<string>>>(new Map());
  const acceptedBySessionRef = useRef<Map<string, { candidateId: string; baseline: string }>>(new Map());
  const completionCooldownRef = useRef<Map<string, number>>(new Map());
  const searchRequestRef = useRef(0);
  const value = session ? drafts[session.id] ?? "" : "";

  const mentionVisible = Boolean(session && mention);
  const currentMentionQuery = mention?.query ?? "";
  const canSend = Boolean(session && value.trim());
  const activeCompletion = isCurrentCompletion(completion, value, cursor) ? completion : null;

  const reportFeedback = (candidateId: string, event: "shown" | "accepted" | "dismissed" | "submitted_after_accept", details: { editDistance?: number; finalLength?: number } = {}) => {
    if (!candidateId) return;
    const events = feedbackRef.current.get(candidateId) ?? new Set<string>();
    if (events.has(event)) return;
    events.add(event);
    feedbackRef.current.set(candidateId, events);
    void window.completionApi.recordFeedback({ candidateId, event, ...details }).catch(() => {});
    if (event === "dismissed" || event === "submitted_after_accept") feedbackRef.current.delete(candidateId);
  };

  const dismissCurrentCompletion = (addCooldown = false) => {
    const current = completionRef.current;
    if (!current) return;
    const accepted = acceptedBySessionRef.current.get(session?.id ?? "")?.candidateId === current.candidateId;
    if (!accepted) reportFeedback(current.candidateId, "dismissed");
    if (addCooldown) {
      completionCooldownRef.current.set(`${current.mode}:${current.draft}:${current.cursor}`, Date.now() + 10000);
    }
    completionRef.current = null;
    setCompletion(null);
  };

  const showCompletion = (candidate: CompletionCandidate) => {
    const current = completionRef.current;
    if (current?.candidateId && current.candidateId !== candidate.candidateId) reportFeedback(current.candidateId, "dismissed");
    completionRef.current = candidate;
    setCompletion(candidate);
    reportFeedback(candidate.candidateId, "shown");
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const contentHeight = Math.max(textarea.scrollHeight, mirrorRef.current?.scrollHeight || 0);
    textarea.style.height = `${Math.min(contentHeight, 144)}px`;
  }, [activeCompletion, value]);

  useEffect(() => {
    dismissCurrentCompletion();
    setMention(null);
    setResults([]);
    setSelectedIndex(0);
    setImageStatus("idle");
    setStatusMessage("");
    setCursor(0);
    completionRef.current = null;
    setCompletion(null);
    setCompletionLoading(false);
    setCompletionError("");
    completionRequestRef.current += 1;
  }, [session?.id]);

  useEffect(() => {
    const requestId = completionRequestRef.current + 1;
    completionRequestRef.current = requestId;
    const previous = completionRef.current;
    if (previous) dismissCurrentCompletion();
    setCompletion(null);
    completionRef.current = null;
    setCompletionLoading(false);
    setCompletionError("");
    if (!session || !value.trim() || isComposing || mention) return undefined;
    const mode = session.agentProvider ? "agent" : "shell";
    const trigger = getCompletionTrigger(mode, value);
    if (!trigger) return undefined;
    const cooldownKey = `${mode}:${value}:${cursor}`;
    if ((completionCooldownRef.current.get(cooldownKey) ?? 0) > Date.now()) return undefined;

    const snapshot = { sessionId: session.id, draft: value, cursor };
    let timer: number | undefined;
    let disposed = false;
    const requestModel = async () => {
      try {
        setCompletionLoading(true);
        const result = await window.completionApi.complete(snapshot);
        if (completionRequestRef.current !== requestId) return;
        if (result.completion) showCompletion({ ...result, draft: value, cursor });
      } catch (error) {
        if (completionRequestRef.current === requestId) {
          completionCooldownRef.current.set(cooldownKey, Date.now() + 10000);
          setCompletionError(t("composer.completionFailed", { message: getErrorMessage(error) }));
        }
      } finally {
        if (completionRequestRef.current === requestId) setCompletionLoading(false);
      }
    };
    void window.completionApi.getConfig().then(async (config) => {
      if (disposed || completionRequestRef.current !== requestId || !config.enabled) return;
      if (trigger.checkLocalHistory) {
        const localResult = await window.completionApi.complete({ ...snapshot, localOnly: true });
        if (disposed || completionRequestRef.current !== requestId) return;
        if (localResult.completion) {
          showCompletion({ ...localResult, draft: value, cursor });
          return;
        }
      }
      timer = window.setTimeout(() => void requestModel(), trigger.modelDelayMs);
    }).catch((error) => {
      if (!disposed && completionRequestRef.current === requestId) {
        setCompletionError(t("composer.completionFailed", { message: getErrorMessage(error) }));
      }
    });
    return () => {
      disposed = true;
      if (timer != null) window.clearTimeout(timer);
    };
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
    if (nextValue !== value || caret !== cursor) dismissCurrentCompletion();
    setDrafts((current) => ({ ...current, [session.id]: nextValue }));
    const nextCaret = caret ?? textareaRef.current?.selectionStart ?? nextValue.length;
    setCursor(nextCaret);
    setMention(getMentionAtCaret(nextValue, nextCaret));
  };

  const insertText = (text: string, range?: { start: number; end: number }) => {
    if (!session) return;
    dismissCurrentCompletion();
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
    dismissCurrentCompletion();
    const accepted = acceptedBySessionRef.current.get(session.id);
    if (accepted) {
      reportFeedback(accepted.candidateId, "submitted_after_accept", {
        editDistance: editDistance(accepted.baseline, value),
        finalLength: value.length
      });
      acceptedBySessionRef.current.delete(session.id);
    }
    void window.completionApi.recordSubmission({ sessionId: session.id, value }).catch(() => {});
    submitTerminalInput(session.id, value, window.terminalApi.write);
    setDrafts((current) => ({ ...current, [session.id]: "" }));
    setMention(null);
    setResults([]);
    setCursor(0);
    setCompletion(null);
  };

  const acceptCompletion = () => {
    if (!session || !activeCompletion) return;
    const next = applyCompletion(value, cursor, activeCompletion.completion);
    reportFeedback(activeCompletion.candidateId, "accepted");
    acceptedBySessionRef.current.set(session.id, { candidateId: activeCompletion.candidateId, baseline: next.value });
    setDrafts((current) => ({ ...current, [session.id]: next.value }));
    setCursor(next.cursor);
    completionRef.current = null;
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
              dismissCurrentCompletion(true);
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
