import type { TranslationKey } from "../../i18n/locales";

export const TITLE_BAR_ACTIONS = [
  { id: "terminal", labelKey: "app.openTerminal" },
  { id: "stats", labelKey: "tokenStats.open" },
  { id: "skills", labelKey: "skills.open" },
  { id: "mcp", labelKey: "mcp.open" },
  { id: "idea", labelKey: "idea.open" },
  { id: "screenshot", labelKey: "screenshot.capture" },
  { id: "settings", labelKey: "settings.open" },
  { id: "library", labelKey: "sidebar.openLibrary" },
  { id: "quickAgent", labelKey: "session.quickAgent" },
  { id: "api", labelKey: "sessionApi.title" },
  { id: "moduleOwners", labelKey: "moduleOwners.title" },
  { id: "create", labelKey: "sidebar.newSession" }
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey }>;

export type TitleBarActionId = typeof TITLE_BAR_ACTIONS[number]["id"];
export const DEFAULT_TITLE_BAR_ACTION_ORDER: TitleBarActionId[] = TITLE_BAR_ACTIONS.map(action => action.id);

export function withSettingsAction(order: TitleBarActionId[]): TitleBarActionId[] {
  const next = [...order];
  if (!next.includes("settings")) next.splice(6, 0, "settings");
  if (!next.includes("api")) next.splice(next.includes("create") ? next.indexOf("create") : next.length, 0, "api");
  if (!next.includes("moduleOwners")) next.splice(next.includes("create") ? next.indexOf("create") : next.length, 0, "moduleOwners");
  return next;
}
