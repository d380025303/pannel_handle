import { useState } from "react";
import type { QuickCommand } from "./types";

type Props = {
  commands: QuickCommand[];
  onSelect: (command: QuickCommand) => boolean;
  disabled?: (command: QuickCommand) => boolean;
};

const labels = { "write": "手动写入", "auto-enter": "自动执行", "one-time": "一次性" };

export function QuickCommandPicker({ commands, onSelect, disabled = () => false }: Props) {
  const [open, setOpen] = useState(false);
  if (!commands.length) return null;
  const pinned = commands.filter(command => command.pinned).slice(0, 3);
  const direct = [...pinned, ...commands.filter(command => !command.pinned).slice(0, 3 - pinned.length)];
  const run = (command: QuickCommand) => { if (onSelect(command)) setOpen(false); };
  return <div className="mobile-quick-commands">
    <div className="mobile-quick-direct">
      {direct.map(command => <button key={command.id} type="button" title={command.command} disabled={disabled(command)} onClick={() => run(command)}>{command.command}</button>)}
      <button type="button" className="mobile-quick-more" onClick={() => setOpen(true)}>快捷输入 ({commands.length})</button>
    </div>
    {open && <div className="sheet-backdrop" onClick={() => setOpen(false)}>
      <div className="mobile-quick-sheet" role="dialog" aria-modal="true" aria-label="快捷输入" onClick={event => event.stopPropagation()}>
        <header><strong>快捷输入</strong><button type="button" aria-label="关闭快捷输入" onClick={() => setOpen(false)}>×</button></header>
        <div className="mobile-quick-list">{commands.map(command => <button key={command.id} type="button" disabled={disabled(command)} onClick={() => run(command)}>
          <span>{command.command}</span><small>{command.pinned ? "置顶 · " : ""}{labels[command.mode || "write"]}</small>
        </button>)}</div>
      </div>
    </div>}
  </div>;
}
