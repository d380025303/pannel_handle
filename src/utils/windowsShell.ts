import type { WindowsShell } from "../vite-env";

export const WINDOWS_SHELL_OPTIONS: { value: WindowsShell; label: string }[] = [
  { value: "cmd", label: "CMD" },
  { value: "powershell", label: "PowerShell 5.1" },
  { value: "pwsh", label: "PowerShell 7" }
];

export function windowsShellLabel(shell: WindowsShell) {
  return WINDOWS_SHELL_OPTIONS.find(option => option.value === shell)?.label || "CMD";
}

export function windowsCommandExample(shell: string) {
  const executable = shell.split(/[\\/]/).pop()?.toLowerCase();
  return ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable || "")
    ? "$env:HTTP_PROXY = 'http://127.0.0.1:7892'; $env:HTTPS_PROXY = 'http://127.0.0.1:7892'"
    : 'set "HTTP_PROXY=http://127.0.0.1:7892" && set "HTTPS_PROXY=http://127.0.0.1:7892"';
}
