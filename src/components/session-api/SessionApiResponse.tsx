import { useEffect, useMemo, useRef, useState } from "react";
import { Compartment, EditorState, StateEffect, Text } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers } from "@codemirror/view";
import { SearchCursor } from "@codemirror/search";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import { useI18n } from "../../i18n";

export function findResponseMatches(text: string, query: string) {
  if (!query) return [];
  const cursor = new SearchCursor(Text.of(text.split("\n")), query, 0, text.length, value => value.toLowerCase());
  const matches: { from: number; to: number }[] = [];
  while (!cursor.next().done) matches.push(cursor.value);
  return matches;
}

export function SessionApiResponse({ text, visible, onCopy }: {
  text: string | null;
  visible: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const view = useRef<EditorView | null>(null);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const matches = useMemo(() => findResponseMatches(text ?? "", query), [text, query]);

  useEffect(() => {
    if (!host.current || text === null) return;
    let active = true;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({
      doc: text,
      extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), searchHighlights.of([]),
        EditorView.contentAttributes.of({ "aria-label": t("sessionApi.response"), tabindex: "0" }),
        syntaxHighlighting(responseHighlightStyle),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } })]
    }) });
    view.current = editor;
    const json = LanguageDescription.matchLanguageName(languages, "JSON");
    void json?.load().then(language => {
      if (active) editor.dispatch({ effects: StateEffect.appendConfig.of(language) });
    }).catch(() => { /* Keep the response readable if the language chunk cannot load. */ });
    return () => { active = false; view.current = null; editor.destroy(); };
  }, [text, t]);

  useEffect(() => { setCurrent(0); }, [text, query]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const index = current < matches.length ? current : 0;
    const decorations = Decoration.set(matches.map((match, position) => Decoration.mark({
      class: position === index ? "session-api-match-current" : "session-api-match"
    }).range(match.from, match.to)));
    editor.dispatch({ effects: searchHighlights.reconfigure(EditorView.decorations.of(decorations)) });
    if (matches[index]) editor.dispatch({ effects: EditorView.scrollIntoView(matches[index].from, { y: "center" }) });
  }, [matches, current, text, t]);

  function move(delta: number) {
    if (matches.length) setCurrent(value => (value + delta + matches.length) % matches.length);
  }

  return <>
    <div className="session-api-search">
      <input ref={input} type="search" aria-label={t("sessionApi.searchResponse")} placeholder={t("sessionApi.searchResponse")} value={query} disabled={text === null} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
        if (event.key === "Escape") { event.preventDefault(); setQuery(""); }
      }} />
      <span role="status">{query && !matches.length ? t("sessionApi.noMatches") : `${matches.length ? Math.min(current + 1, matches.length) : 0} / ${matches.length}`}</span>
      <button type="button" disabled={!matches.length} onClick={() => move(-1)} aria-label={t("sessionApi.previousMatch")}>↑</button>
      <button type="button" disabled={!matches.length} onClick={() => move(1)} aria-label={t("sessionApi.nextMatch")}>↓</button>
      <button type="button" disabled={text === null} onClick={onCopy}>{t("sessionApi.copyResponse")}</button>
    </div>
    {text === null ? <div className="session-api-empty">{t("sessionApi.responseEmpty")}</div> : <div ref={host} className="session-api-response-editor" />}
    <ResponseShortcut visible={visible} focus={() => input.current?.focus()} />
  </>;
}

const searchHighlights = new Compartment();
const responseHighlightStyle = HighlightStyle.define([
  { tag: tags.string, color: "var(--color-code-string)" },
  { tag: tags.propertyName, color: "var(--color-code-property)" },
  { tag: tags.number, color: "var(--color-code-number)" },
  { tag: [tags.bool, tags.null], color: "var(--color-code-constant)" }
]);

function ResponseShortcut({ visible, focus }: { visible: boolean; focus: () => void }) {
  useEffect(() => {
    if (!visible) return;
    const handle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && event.target instanceof Element && event.target.closest(".session-api-workspace")) {
        event.preventDefault(); focus();
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [visible, focus]);
  return null;
}
