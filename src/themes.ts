import type { ITheme } from "xterm";
import type { ThemeId } from "./vite-env";

export type AppTheme = {
  id: ThemeId;
  label: string;
  terminal: ITheme;
};

export const DEFAULT_THEME_ID: ThemeId = "dark-slate";

export const APP_THEMES: AppTheme[] = [
  {
    id: "dark-slate",
    label: "深色石板",
    terminal: {
      background: "#101318",
      foreground: "#e7edf4",
      cursor: "#ffffff",
      selectionBackground: "#35506c",
      black: "#15191f",
      red: "#df6b75",
      green: "#76c38f",
      yellow: "#d7b46a",
      blue: "#6ca8e7",
      magenta: "#c792ea",
      cyan: "#64c9cf",
      white: "#e7edf4",
      brightBlack: "#626a73",
      brightRed: "#f07f89",
      brightGreen: "#8ad9a4",
      brightYellow: "#e8c981",
      brightBlue: "#82bbf7",
      brightMagenta: "#d7a5f4",
      brightCyan: "#80dde1",
      brightWhite: "#ffffff"
    }
  },
  {
    id: "dark-blue",
    label: "深蓝色",
    terminal: {
      background: "#0b1220",
      foreground: "#e5edf8",
      cursor: "#ffffff",
      selectionBackground: "#24476b",
      black: "#111827",
      red: "#f87171",
      green: "#5ee4a4",
      yellow: "#f6c85f",
      blue: "#7bb5ff",
      magenta: "#c4a3ff",
      cyan: "#67e8f9",
      white: "#e5edf8",
      brightBlack: "#64748b",
      brightRed: "#fca5a5",
      brightGreen: "#86efac",
      brightYellow: "#fde68a",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#a5f3fc",
      brightWhite: "#ffffff"
    }
  },
  {
    id: "dark-green",
    label: "深绿色",
    terminal: {
      background: "#0f1512",
      foreground: "#e3eee8",
      cursor: "#ffffff",
      selectionBackground: "#28523c",
      black: "#131a16",
      red: "#ee7b7b",
      green: "#77d996",
      yellow: "#d9c36f",
      blue: "#7fb4d8",
      magenta: "#c39be6",
      cyan: "#7bd6c8",
      white: "#e3eee8",
      brightBlack: "#68756d",
      brightRed: "#f19a9a",
      brightGreen: "#96e6ae",
      brightYellow: "#e7d58b",
      brightBlue: "#9bc8e6",
      brightMagenta: "#d4b1ef",
      brightCyan: "#9ae4d9",
      brightWhite: "#ffffff"
    }
  },
  {
    id: "light",
    label: "浅色",
    terminal: {
      background: "#f8fafc",
      foreground: "#1f2937",
      cursor: "#111827",
      selectionBackground: "#c7ddf7",
      black: "#111827",
      red: "#b91c1c",
      green: "#047857",
      yellow: "#a16207",
      blue: "#1d4ed8",
      magenta: "#7e22ce",
      cyan: "#0e7490",
      white: "#e5e7eb",
      brightBlack: "#6b7280",
      brightRed: "#dc2626",
      brightGreen: "#059669",
      brightYellow: "#ca8a04",
      brightBlue: "#2563eb",
      brightMagenta: "#9333ea",
      brightCyan: "#0891b2",
      brightWhite: "#ffffff"
    }
  }
];

export function getAppTheme(themeId: ThemeId): AppTheme {
  return APP_THEMES.find((theme) => theme.id === themeId) ?? APP_THEMES[0];
}
