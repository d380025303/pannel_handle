import catalog from "../../electron/shared/graphical-menu-actions.json";

export type GraphicalMenuConfig = Partial<Record<string, string[]>>;
export const graphicalMenuProviders = catalog.providers;
export const graphicalMenuActions = catalog.actions;

export function normalizeGraphicalMenuConfig(value: unknown): GraphicalMenuConfig {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return Object.fromEntries(catalog.providers.map(provider => [provider,
    catalog.actions.filter(action => action.providers.includes(provider)
      && Array.isArray(input[provider]) && (input[provider] as unknown[]).includes(action.id)).map(action => action.id)
  ]));
}
