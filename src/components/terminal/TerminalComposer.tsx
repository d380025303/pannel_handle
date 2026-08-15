import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUp, File, Folder, ImagePlus, LoaderCircle } from "lucide-react";
import { useI18n } from "../../i18n";
import type { TerminalSession, WorkspaceEntrySearchResult } from "../../vite-env";
import { submitTerminalInput } from "./terminalComposerInput";

type TerminalComposerProps = {
  session?: TerminalSession;
  onFocusTerminal: () => void;
};

type Mention = {
  start: number;
  end: number;
  query: string;
};

type SearchStatus = "idle" | "loading" | "ready" | "error";
type ImageStatus = "idle" | "uploading" | "error";

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

export function TerminalComposer({ session, onFocusTerminal }: TerminalComposerProps) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mention, setMention] = useState<Mention | null>(null);
  const [results, setResults] = useState<WorkspaceEntrySearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [searchError, setSearchError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [imageStatus, setImageStatus] = useState<ImageStatus>("idle");
  const [imageMessage, setImageMessage] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchRequestRef = useRef(0);
  const listboxId = useId();
  const feedbackId = useId();
  const value = session ? drafts[session.id] ?? "" : "";

  const mentionVisible = Boolean(session && mention);
  const currentMentionQuery = mention?.query ?? "";
  const canSend = Boolean(session && value.trim());
  const selectedResult = useMemo(() => results[selectedIndex], [results, selectedIndex]);
  const selectedOptionId = selectedResult ? `${listboxId}-option-${selectedIndex}` : undefined;
  const feedbackMessage = imageStatus !== "idle"
    ? imageMessage
    : searchStatus === "error"
      ? searchError
      : "";
  const feedbackIsError = imageStatus === "error" || searchStatus === "error";
  const showShortcuts = Boolean(session && (isFocused || value));
  const hasError = feedbackIsError;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    searchRequestRef.current += 1;
    setMention(null);
    setResults([]);
    setSearchStatus("idle");
    setSearchError("");
    setSelectedIndex(0);
    setImageStatus("idle");
    setImageMessage("");
    setIsFocused(false);
    setIsComposing(false);
  }, [session?.id]);

  useEffect(() => {
    if (!session || !mention) return undefined;
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setSearchStatus("loading");
    setSearchError("");
    setResults([]);
    setSelectedIndex(0);

    const timer = window.setTimeout(() => {
      window.projectSearchApi.searchWorkspaceEntries(session.id, currentMentionQuery)
        .then((response) => {
          if (searchRequestRef.current !== requestId) return;
          setResults(response.results);
          setSelectedIndex(0);
          setSearchStatus("ready");
        })
        .catch((error) => {
          if (searchRequestRef.current !== requestId) return;
          setResults([]);
          setSearchStatus("error");
          setSearchError(t("composer.searchFailed", { message: getErrorMessage(error) }));
        });
    }, 180);

    return () => window.clearTimeout(timer);
  }, [currentMentionQuery, mention, session, t]);

  useEffect(() => {
    if (!mentionVisible || !selectedResult) return;
    resultRefs.current[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [mentionVisible, selectedIndex, selectedResult]);

  const clearMention = () => {
    searchRequestRef.current += 1;
    setMention(null);
    setResults([]);
    setSearchStatus("idle");
    setSearchError("");
    setSelectedIndex(0);
  };

  const updateDraft = (nextValue: string, caret?: number) => {
    if (!session) return;
    setDrafts((current) => ({ ...current, [session.id]: nextValue }));
    const nextCaret = caret ?? textareaRef.current?.selectionStart ?? nextValue.length;
    const nextMention = getMentionAtCaret(nextValue, nextCaret);
    if (nextMention) {
      setMention(nextMention);
    } else {
      clearMention();
    }
  };

  const insertText = (text: string, range?: { start: number; end: number }) => {
    if (!session) return;
    const textarea = textareaRef.current;
    const start = range?.start ?? textarea?.selectionStart ?? value.length;
    const end = range?.end ?? textarea?.selectionEnd ?? start;
    const nextValue = `${value.slice(0, start)}${text}${value.slice(end)}`;
    const nextCaret = start + text.length;
    setDrafts((current) => ({ ...current, [session.id]: nextValue }));
    clearMention();
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
    submitTerminalInput(session.id, value, window.terminalApi.write);
    setDrafts((current) => ({ ...current, [session.id]: "" }));
    clearMention();
    setImageStatus("idle");
    setImageMessage("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(0, 0);
    });
  };

  const pasteClipboardImage = async () => {
    if (!session || imageStatus === "uploading") return;
    setImageStatus("uploading");
    setImageMessage(t("composer.uploadingImage"));
    try {
      const result = await window.clipboardApi.pasteImageToSession(session.id);
      if (result.status === "no_image") {
        setImageStatus("error");
        setImageMessage(t("composer.noClipboardImage"));
        return;
      }
      insertText(`@${getImageRelativePath(session, result.path)} `);
      setImageStatus("idle");
      setImageMessage("");
    } catch (error) {
      setImageStatus("error");
      setImageMessage(t("composer.imageUploadFailed", { message: getErrorMessage(error) }));
    }
  };

  return (
    <div className="terminal-composer-wrap">
      {mentionVisible && (
        <div
          id={listboxId}
          className="terminal-composer-mentions"
          role="listbox"
          aria-label={t("composer.searchWorkspace")}
        >
          <div className="terminal-composer-mentions-heading">
            <span>{t("composer.searchWorkspace")}</span>
            {searchStatus === "loading" && (
              <LoaderCircle className="spin" aria-label={t("composer.searching")} />
            )}
          </div>
          {searchStatus === "idle" || searchStatus === "loading" ? (
            <div className="terminal-composer-empty">{t("composer.searching")}</div>
          ) : searchStatus === "error" ? (
            <div className="terminal-composer-empty error">{t("composer.searchUnavailable")}</div>
          ) : results.length === 0 ? (
            <div className="terminal-composer-empty">{t("composer.noMatches")}</div>
          ) : results.map((entry, index) => (
            <button
              ref={(element) => { resultRefs.current[index] = element; }}
              id={`${listboxId}-option-${index}`}
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
      <div className={`terminal-composer ${hasError ? "has-error" : ""}`}>
        <div className="terminal-composer-input">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={!session}
            aria-label={t("composer.inputLabel")}
            aria-autocomplete="list"
            aria-controls={mentionVisible ? listboxId : undefined}
            aria-expanded={mentionVisible}
            aria-activedescendant={mentionVisible ? selectedOptionId : undefined}
            aria-describedby={feedbackMessage || showShortcuts ? feedbackId : undefined}
            placeholder={session ? t("composer.placeholder") : t("app.noActiveSession")}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onChange={(event) => updateDraft(event.target.value, event.target.selectionStart)}
            onClick={(event) => {
              const nextMention = getMentionAtCaret(value, event.currentTarget.selectionStart);
              if (nextMention) setMention(nextMention);
              else clearMention();
            }}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={(event) => {
              setIsComposing(false);
              updateDraft(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onKeyDown={(event) => {
              if (isComposing || event.nativeEvent.isComposing) return;
              const hasPrimaryModifier = event.ctrlKey || event.altKey || event.metaKey;
              const isPlainKey = !event.shiftKey && !hasPrimaryModifier;

              if (session?.agentProvider && !value && event.key === "/" && isPlainKey) {
                event.preventDefault();
                clearMention();
                window.terminalApi.write(session.id, "/");
                onFocusTerminal();
                return;
              }
              if (event.key === "Enter" && hasPrimaryModifier && !event.shiftKey) {
                event.preventDefault();
                insertText("\n");
                return;
              }
              if (mention && isPlainKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setSelectedIndex((current) => results.length ? (current + direction + results.length) % results.length : 0);
                return;
              }
              if (mention && isPlainKey && (event.key === "Enter" || event.key === "Tab") && selectedResult) {
                event.preventDefault();
                selectEntry(selectedResult);
                return;
              }
              if (session && event.key === "Tab" && event.shiftKey && !hasPrimaryModifier) {
                event.preventDefault();
                window.terminalApi.write(session.id, "\x1b[Z");
                return;
              }
              if (mention && event.key === "Escape") {
                event.preventDefault();
                clearMention();
                return;
              }
              if (event.key === "Enter" && isPlainKey) {
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
        <div className="terminal-composer-toolbar">
          <div
            id={feedbackId}
            className={`terminal-composer-feedback ${feedbackIsError ? "error" : feedbackMessage ? "status" : "hint"} ${showShortcuts || feedbackMessage ? "visible" : ""}`}
            role={feedbackIsError ? "alert" : "status"}
            aria-live="polite"
          >
            {feedbackMessage || (showShortcuts
              ? t(session?.agentProvider ? "composer.shortcutsAgent" : "composer.shortcuts")
              : "\u00a0")}
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
      </div>
    </div>
  );
}
