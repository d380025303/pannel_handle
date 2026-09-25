import { useMemo, useState } from "react";
import { ChevronRight, FileDiff } from "lucide-react";
import type { CodexAppServerSnapshot } from "../../vite-env";

type DiffLine = { kind: "context" | "add" | "delete" | "hunk" | "meta"; text: string; oldNumber?: number; newNumber?: number };
type DiffFile = { path: string; oldPath: string; lines: DiffLine[]; additions: number; deletions: number };
type TurnDiff = NonNullable<CodexAppServerSnapshot["turnDiffs"]>[number];

function markerPath(line: string) {
  const value = line.slice(4).split("\t", 1)[0];
  return value === "/dev/null" ? "" : value.replace(/^[ab]\//, "");
}

export function parseTurnDiff(value: string): DiffFile[] | null {
  if (!value.startsWith("diff --git ")) return null;
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  for (const line of value.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = { path: match?.[2] || "未知文件", oldPath: match?.[1] || "", lines: [], additions: 0, deletions: 0 };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file || !line) continue;
    if (!inHunk && line.startsWith("--- ")) { file.oldPath = markerPath(line); continue; }
    if (!inHunk && line.startsWith("+++ ")) { file.path = markerPath(line) || file.path; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNumber = Number(hunk[1]); newNumber = Number(hunk[2]); inHunk = true;
      file.lines.push({ kind: "hunk", text: line });
    } else if (inHunk && line.startsWith("+")) {
      file.lines.push({ kind: "add", text: line.slice(1), newNumber: newNumber++ }); file.additions++;
    } else if (inHunk && line.startsWith("-")) {
      file.lines.push({ kind: "delete", text: line.slice(1), oldNumber: oldNumber++ }); file.deletions++;
    } else if (inHunk && line.startsWith(" ")) {
      file.lines.push({ kind: "context", text: line.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
    } else {
      file.lines.push({ kind: "meta", text: line });
    }
  }
  return files.length && files.some(entry => entry.lines.length) ? files : null;
}

function DiffFileSection({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  return <details className="codex-app-server-diff-file" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <ChevronRight className="codex-app-server-diff-chevron" aria-hidden="true" />
      <span className="codex-app-server-diff-path" title={file.path}>{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ""}{file.path}</span>
      <span className="codex-app-server-diff-counts" aria-label={`新增 ${file.additions} 行，删除 ${file.deletions} 行`}>
        <span className="add">+{file.additions}</span><span className="delete">−{file.deletions}</span>
      </span>
    </summary>
    <div className="codex-app-server-diff-lines">
      {file.lines.map((line, index) => <div className={`codex-app-server-diff-line ${line.kind}`} key={index}>
        <span className="codex-app-server-diff-number" aria-hidden="true">{line.oldNumber ?? ""}</span>
        <span className="codex-app-server-diff-number" aria-hidden="true">{line.newNumber ?? ""}</span>
        <span className="codex-app-server-diff-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : ""}</span>
        <code>{line.text}</code>
      </div>)}
    </div>
  </details>;
}

export function TurnDiffCard({ diff }: { diff: TurnDiff }) {
  const files = useMemo(() => parseTurnDiff(diff.diff), [diff.diff]);
  const additions = files?.reduce((sum, file) => sum + file.additions, 0) || 0;
  const deletions = files?.reduce((sum, file) => sum + file.deletions, 0) || 0;
  return <details className="codex-app-server-turn-diff">
    <summary><FileDiff aria-hidden="true" /><strong>本轮变更</strong>
      {files && <span className="codex-app-server-diff-overview">{files.length} 个文件 <span className="add">+{additions}</span> <span className="delete">−{deletions}</span></span>}
      <ChevronRight className="codex-app-server-diff-chevron" aria-hidden="true" />
    </summary>
    {files ? <div className="codex-app-server-diff-files">{files.map((file, index) => <DiffFileSection key={`${index}:${file.path}`} file={file} />)}</div>
      : <pre className="codex-app-server-diff-raw">{diff.diff || "本轮暂无文件差异。"}</pre>}
  </details>;
}
