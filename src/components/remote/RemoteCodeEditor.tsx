import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";

type RemoteCodeEditorProps = {
  value: string;
  fileName: string;
  onChange: (value: string) => void;
  onSave: () => void;
};

export function RemoteCodeEditor({ value, fileName, onChange, onSave }: RemoteCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const languageRef = useRef(new Compartment());

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

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
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "transparent", color: "var(--color-text)" },
            ".cm-content": { caretColor: "var(--color-accent)", fontFamily: "Consolas, monospace", fontSize: "12px" },
            ".cm-gutters": { backgroundColor: "var(--color-bg-control)", color: "var(--color-text-muted)", border: "0" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--color-accent) 8%, transparent)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--color-accent) 28%, transparent)" },
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
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;
    let disposed = false;
    const description = languages.find((language) => language.filename?.test(fileName));
    if (!description) {
      view.dispatch({ effects: languageRef.current.reconfigure([]) });
      return undefined;
    }
    void description.load().then((support) => {
      if (!disposed && viewRef.current === view) {
        view.dispatch({ effects: languageRef.current.reconfigure(support) });
      }
    });
    return () => { disposed = true; };
  }, [fileName]);

  return <div ref={hostRef} className="remote-code-editor" aria-label={fileName} />;
}
