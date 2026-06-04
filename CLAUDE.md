# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

| 命令 | 用途 |
|------|------|
| `pnpm dev` | 仅启动 Vite 开发服务器（127.0.0.1:5173） |
| `pnpm start` | 同时启动 Vite + Electron，完整开发流程 |
| `pnpm build` | `tsc` 类型检查 + `vite build` → `dist/` |
| `pnpm dist:dir` | 构建 + `electron-builder --dir` → `release/win-unpacked/` |
| `pnpm dist:portable` | 构建 + `electron-builder` → `release/Pannel Handle.exe` 绿色单文件 |

没有配置测试框架或代码检查工具。

## 架构

一个 Windows 桌面终端会话管理器，基于 Electron。启动真实的 shell 进程（默认 PowerShell），在 React 界面中以标签页形式展示 xterm.js 终端。

**Electron 三层架构：**

1. **主进程** (`electron/main.cjs`, CommonJS) — 后端。在内存 `Map<string, session>` 中管理所有 PTY 会话，每个会话封装一个 `node-pty` 伪终端。处理会话增删改查、终端读写/调整大小的 IPC。向渲染进程广播 `sessions:changed`、`terminal:data`、`terminal:exit` 事件。每个会话保留最近 1000 条数据块的环形缓冲区，用于切换标签页时回放历史输出。

2. **预加载脚本** (`electron/preload.cjs`) — 通过 `contextBridge` 暴露 `window.terminalApi`。主进程与渲染进程之间的整个通信契约都在这里：`invoke` 用于请求/响应（列表、创建、重命名、关闭、历史），`send` 用于单向发送（写入、调整大小），`onXxx` 方法返回取消订阅函数以解除事件监听。

3. **渲染进程** (`src/`, TypeScript + React 19 + Vite) — `main.tsx` 挂载 `App` 组件。`App.tsx` 负责侧边栏会话列表和 xterm.js 终端面板。xterm `Terminal` 实例缓存在 `Map<string, TerminalEntry>` ref 中，以会话 ID 为键。切换标签页时，通过 DOM 移除/重新挂载来切换当前终端，使用 `ResizeObserver` 调用 `FitAddon.fit()` + IPC `resize()` 保持 PTY 尺寸同步。

**共享类型** 定义在 `src/vite-env.d.ts` — `TerminalSession` 和 `TerminalApi`，以及全局 `Window` 类型增强。

**开发与生产环境区别：** 开发时 Electron 加载 `http://127.0.0.1:5173`；打包后加载 `dist/index.html`。
