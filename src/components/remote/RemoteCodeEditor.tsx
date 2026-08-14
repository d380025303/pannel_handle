import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useI18n } from "../../i18n";

export type RemoteCodeLanguageMode = "auto" | "plain" | `language:${string}`;

export type RemoteCodeEditorViewport = {
  scrollTop: number;
  scrollLeft: number;
};

type RemoteCodeEditorProps = {
  documentId: string;
  value: string;
  fileName: string;
  languageMode: RemoteCodeLanguageMode;
  viewport: RemoteCodeEditorViewport;
  onChange: (value: string) => void;
  onLanguageModeChange: (mode: RemoteCodeLanguageMode) => void;
  onSave: () => void;
  onViewportChange: (documentId: string, viewport: RemoteCodeEditorViewport) => void;
};

const remoteCodeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--color-code-keyword)", fontWeight: "600" },
  { tag: [tags.atom, tags.bool, tags.null], color: "var(--color-code-constant)" },
  { tag: [tags.number, tags.integer, tags.float], color: "var(--color-code-number)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--color-code-string)" },
  { tag: [tags.regexp, tags.escape], color: "var(--color-code-regexp)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--color-code-comment)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--color-code-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--color-code-function)" },
  { tag: [tags.definition(tags.variableName), tags.variableName], color: "var(--color-code-variable)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--color-code-property)" },
  { tag: [tags.tagName, tags.heading], color: "var(--color-code-tag)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--color-code-operator)" },
  { tag: [tags.meta, tags.annotation, tags.macroName], color: "var(--color-code-meta)" },
  { tag: [tags.link, tags.url], color: "var(--color-code-link)", textDecoration: "underline" },
  { tag: tags.invalid, color: "var(--color-danger-text)", textDecoration: "underline wavy" }
]);

function detectLanguage(fileName: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, fileName);
}

function getLanguageForMode(fileName: string, mode: RemoteCodeLanguageMode): LanguageDescription | null {
  if (mode === "plain") return null;
  if (mode === "auto") return detectLanguage(fileName);
  const languageName = mode.slice("language:".length);
  return languages.find((language) => language.name === languageName) ?? null;
}

function readViewport(view: EditorView): RemoteCodeEditorViewport {
  return {
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft
  };
}

function restoreViewport(view: EditorView, viewport: RemoteCodeEditorViewport) {
  view.scrollDOM.scrollTop = viewport.scrollTop;
  view.scrollDOM.scrollLeft = viewport.scrollLeft;
}

export function RemoteCodeEditor({
  documentId,
  value,
  fileName,
  languageMode,
  viewport,
  onChange,
  onLanguageModeChange,
  onSave,
  onViewportChange
}: RemoteCodeEditorProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onViewportChangeRef = useRef(onViewportChange);
  const documentIdRef = useRef(documentId);
  const viewportRef = useRef(viewport);
  const languageRef = useRef(new Compartment());

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onViewportChangeRef.current = onViewportChange;
  viewportRef.current = viewport;

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection({ cursorBlinkRate: 900 }),
          dropCursor(),
          indentOnInput(),
          syntaxHighlighting(remoteCodeHighlightStyle, { fallback: true }),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "transparent", color: "var(--color-text)" },
            ".cm-content": { caretColor: "var(--color-accent)", fontFamily: "Consolas, monospace", fontSize: "12px" },
            ".cm-cursor, .cm-dropCursor": {
              borderLeft: "2px solid var(--color-text)",
              marginLeft: "-1px",
              filter: "drop-shadow(0 0 2px var(--color-accent))"
            },
            ".cm-gutters": { backgroundColor: "var(--color-bg-control)", color: "var(--color-text-muted)", border: "0" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--color-accent) 8%, transparent)" },
            ".cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--color-accent) 18%, transparent)" },
            "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
              backgroundColor: "color-mix(in srgb, var(--color-accent) 18%, transparent)"
            },
            ".cm-scroller": { overflow: "auto" }
          }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          languageRef.current.of([])
        ]
      })
    });
    viewRef.current = view;
    restoreViewport(view, viewportRef.current);
    return () => {
      onViewportChangeRef.current(documentIdRef.current, readViewport(view));
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || documentIdRef.current === documentId) return;
    onViewportChangeRef.current(documentIdRef.current, readViewport(view));
    documentIdRef.current = documentId;
    if (view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
    restoreViewport(view, viewportRef.current);
  }, [documentId, value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;
    let disposed = false;
    const description = getLanguageForMode(fileName, languageMode);
    if (!description) {
      view.dispatch({ effects: languageRef.current.reconfigure([]) });
      return undefined;
    }
    void description.load().then((support) => {
      if (!disposed && viewRef.current === view) {
        view.dispatch({ effects: languageRef.current.reconfigure(support) });
      }
    }).catch(() => {
      if (!disposed && viewRef.current === view) {
        view.dispatch({ effects: languageRef.current.reconfigure([]) });
      }
    });
    return () => { disposed = true; };
  }, [fileName, languageMode]);

  const detectedLanguage = detectLanguage(fileName);
  return (
    <div className="remote-code-editor">
      <div className="remote-code-editor-toolbar">
        <label>
          <span>{t("files.languageMode")}</span>
          <select
            aria-label={t("files.languageMode")}
            value={languageMode}
            onChange={(event) => onLanguageModeChange(event.target.value as RemoteCodeLanguageMode)}
          >
            <option value="auto">
              {detectedLanguage ? t("files.languageAutoDetected", { language: detectedLanguage.name }) : t("files.languageAuto")}
            </option>
            <option value="plain">{t("files.languagePlainText")}</option>
            {languages.map((language) => (
              <option key={language.name} value={`language:${language.name}`}>{language.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div ref={hostRef} className="remote-code-editor-host" aria-label={fileName} />
    </div>
  );
}
