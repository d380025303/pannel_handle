# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

| 命令 | 用途 |
|------|------|
| `pnpm dev` | 仅启动 Vite 开发服务器（127.0.0.1:5173） |
| `pnpm start` | 同时启动 Vite + Electron，完整开发流程 |
| `pnpm build` | `tsc` 类型检查 + `vite build` → `dist/` |
| `pnpm dist:dir` | 修补 rcedit + 构建 + `electron-builder --dir` → `release/win-unpacked/` |
| `pnpm dist:portable` | 修补 rcedit + 构建 + `electron-builder` → `release/Pannel Handle.exe` 绿色单文件 |
| `pnpm test` | `vitest run`，测试文件在 `electron/*.test.mjs` |

未配置代码检查工具（ESLint/Prettier 等）。

## 架构

一个 Windows 桌面终端会话管理器，基于 Electron。启动真实的 shell 进程（默认 PowerShell），在 React 界面中以标签页形式展示 xterm.js 终端。

**Electron 三层架构：**

1. **主进程** (`electron/`, CommonJS) — 后端，模块化拆分为多个文件：
   - `main.cjs` — 入口，创建并组装各子系统
   - `terminal-manager.cjs` — 在内存 `Map<string, session>` 中管理所有 PTY 会话（基于 `node-pty`），各会话保留最近 1000 条数据块的环形缓冲区用于切换标签页时的回放
   - `session-store.cjs` — 会话库持久化（保存的会话配置）
   - `config-store.cjs` — 应用配置持久化（JSON 文件）
   - `ipc-handlers.cjs` — 注册所有 `ipcMain.handle` / `ipcMain.on` 处理器（会话增删改查、终端读写/调整大小、剪贴板、远程文件、窗口控制、WSL 发行版列表等）
   - `window-manager.cjs` — BrowserWindow 创建与广播
   - `remote-file-service.cjs` — 通过 SSH/SFTP 浏览/读写远程文件
   - `agent-hook-server.cjs` — Agent hook HTTP 服务器

2. **预加载脚本** (`electron/preload.cjs`) — 通过 `contextBridge` 暴露四套 API：
   - `window.terminalApi` — 会话管理、终端读写、WSL、配置（invoke/send/on 模式）
   - `window.clipboardApi` — 剪贴板读写
   - `window.remoteFileApi` — 远程文件浏览与传输
   - `window.windowApi` — 窗口控制（最小化/最大化/关闭）

3. **渲染进程** (`src/`, TypeScript + React 19 + Vite) — `main.tsx` 挂载 `App` 组件。`App.tsx` 负责布局外壳，组合以下组件：
   - `TitleBar` — 自定义标题栏
   - `SessionSidebar` — 侧边栏会话列表
   - `TerminalPanel` — xterm.js 终端面板（Terminal 实例缓存在 `useTerminalInstances` hook 的 `Map<string, TerminalEntry>` ref 中，切换标签页时通过 DOM 移除/重新挂载，使用 `ResizeObserver` + `FitAddon.fit()` + IPC `resize()` 保持 PTY 尺寸同步）
   - `QuickCommandBar` — 快捷命令栏
   - `RemoteFilePanel` — SSH 远程文件面板
   - `DebugSidebar` — Agent hook 调试面板
   - 模态窗口：`CreateSessionModal`、`EditSessionModal`、`SessionPickerModal`、`SettingsModal`
   - 自定义 hooks：`useTerminalSessions`、`useTerminalInstances`、`useSidebarResize`、`useWindowState`

**共享类型** 定义在 `src/vite-env.d.ts` — `TerminalSession`、`TerminalApi`、`SshConfig`、`AppConfig`、`QuickCommand`、`RemoteFileEntry`、`AgentProvider`、`AgentRunStatus` 及相关 payload 类型，以及全局 `Window` 接口增强（添加 `terminalApi`、`clipboardApi`、`remoteFileApi`、`windowApi`）。

**开发与生产环境区别：** 开发时 Electron 加载 `http://127.0.0.1:5173`；打包后加载 `dist/index.html`。Vite 配置使用 `base: "./"` 以支持 Electron file:// 协议加载资源。
