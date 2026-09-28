import type { TranslationKey } from "../../i18n/locales";

export const TITLE_BAR_ACTIONS = [
  { id: "terminal", labelKey: "app.openTerminal" },
  { id: "stats", labelKey: "tokenStats.open" },
  { id: "skills", labelKey: "skills.open" },
  { id: "mcp", labelKey: "mcp.open" },
  { id: "assistant", labelKey: "projectAssistant.open" },
  { id: "screenshot", labelKey: "screenshot.capture" },
  { id: "library", labelKey: "sidebar.openLibrary" },
  { id: "quickAgent", labelKey: "session.quickAgent" },
  { id: "create", labelKey: "sidebar.newSession" }
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey }>;

export type TitleBarActionId = typeof TITLE_BAR_ACTIONS[number]["id"];
export const DEFAULT_TITLE_BAR_ACTION_ORDER: TitleBarActionId[] = TITLE_BAR_ACTIONS.map(action => action.id);
