<div align="center">

<img src="build/icon.png" alt="logo" width="96" height="96" />

# Pannel Handle

**Windows Desktop Terminal Session Manager**

**一站管理本地 Shell、SSH 远程连接与 AI Agent 工作流**

[![Electron](https://img.shields.io/badge/Electron-35.x-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19.x-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6.x-646CFF?logo=vite)](https://vitejs.dev/)
[![xterm.js](https://img.shields.io/badge/xterm.js-5.x-4B9FE4)](https://xtermjs.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

</div>

---

A Windows desktop application that combines a multi-tab terminal emulator with deep **AI agent status monitoring** (Claude Code / Codex / OpenCode). Manage local shells, SSH remote sessions, and track your AI assistant's real-time status — all in one place.

一款 Windows 桌面终端管理工具，集多标签终端模拟器与 **AI Agent 状态监听**（Claude Code / Codex / OpenCode）于一体。

---

Documentation / 文档：

- [:us: English](./README.en.md)
- [:cn: 简体中文](./README.zh-CN.md)

---

## Quick Start / 快速开始

```bash
# Prerequisites / 环境要求: Windows 10/11, Node.js 18+, pnpm

git clone <repo-url>
cd pannel_handle
pnpm install
pnpm start        # Dev mode / 开发模式
pnpm dist:portable # Build portable package / 打包 portable 安装包
```

---

## Tech Stack / 技术栈

| Layer 层 | Stack 技术选型 |
|-----------|---------------|
| Desktop | Electron 35 |
| Frontend | React 19 + TypeScript 5 + Vite 6 |
| Terminal | xterm.js 5 + node-pty |
| SSH | ssh2 + ssh2-sftp-client |
| Search | @vscode/ripgrep |

---

## License / 许可

MIT

---

<div align="center">

**Pannel Handle** — Your terminal, your remote servers, and your AI agents, all in one place.

让你的终端、远程服务器和 AI Agent 在一处协同工作。

</div>
