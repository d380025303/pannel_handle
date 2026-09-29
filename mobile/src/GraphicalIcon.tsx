import { Check, ChevronLeft, ChevronRight, CirclePlus, Command, Cpu, Ellipsis, FilePlus, History, RefreshCw, Send, ShieldCheck, Square, SquareTerminal, UserRound, X, type LucideIcon } from "lucide-react";

type IconName = "more" | "close" | "send" | "stop" | "retry" | "refresh" | "remove" | "chevron"
  | "shield" | "mode" | "model" | "agent" | "history" | "new" | "file" | "back" | "check" | "command";

const icons: Record<IconName, LucideIcon> = {
  more: Ellipsis,
  close: X,
  send: Send,
  stop: Square,
  retry: RefreshCw,
  refresh: RefreshCw,
  remove: X,
  chevron: ChevronRight,
  shield: ShieldCheck,
  mode: SquareTerminal,
  model: Cpu,
  agent: UserRound,
  history: History,
  new: CirclePlus,
  file: FilePlus,
  back: ChevronLeft,
  check: Check,
  command: Command
};

export function GraphicalIcon({ name }: { name: IconName }) {
  const Icon = icons[name];
  return <Icon className="graphical-icon" aria-hidden="true" focusable="false" />;
}
