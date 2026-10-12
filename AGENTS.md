# 仓库指南

这是一个基于 Electron、Vite、React 和 TypeScript 的 Windows 终端会话管理器，使用 `pnpm`。

## 目录

- `src/`：桌面端渲染进程；`electron/`：主进程、预加载脚本及服务；`mobile/`：移动端。
- `docs/`：使用文档；`scripts/`：构建脚本；`build/`：打包资源。
- `dist/` 和 `release/` 是生成目录，不要手动编辑。

## 开发与验证

- 以 `package.json` 中的脚本为准。`pnpm test` 和 `pnpm build` 均包含桌面端与移动端；需要缩小范围时使用 `test:desktop`、`test:mobile`、`build:desktop` 或 `build:mobile`。
- 代码改动后运行相关测试和构建；修改 Electron 的 `.cjs` 文件时，按需运行 `node --check`。
- 不需要启动 dev 模式进行测试。构建或单元测试不能证明 Electron、PTY、SSH 等运行时行为；需要验证时明确说明实际验证范围。
- 浏览器视觉验证可运行 `pnpm dev:browser`，打开 `http://127.0.0.1:6174`。该模式通过 `src/browser-preview/installBrowserPreview.ts` 注入内存 mock，可检查主题、布局、弹窗、滚动、窄窗口适配及模拟交互；新增桌面 API 或功能时按需同步补齐 mock。
- 浏览器 mock 预览不能替代真实 Electron、PTY、SSH、Git、文件系统、IPC 或系统剪贴板验证；报告验收结果时区分浏览器视觉验证与实际运行时验证。

## 代码与安全

- 延续所在文件的风格。渲染进程使用 TypeScript 和 React；Electron 主进程及预加载脚本使用 CommonJS（`.cjs`）。
- 渲染进程新增桌面能力时，通过 `electron/preload.cjs` 暴露受控 API，并同步更新 `src/vite-env.d.ts`；不要向 React 暴露原始 Node 或 Electron API。
- 保持 Electron 窗口的 `contextIsolation: true` 和 `nodeIntegration: false`。本地凭据与配置留在 Electron `userData`，不要提交机器本地数据。

## CSS 与界面样式

- 新增、修改或审查 CSS、主题、布局和界面视觉样式时，先读取项目技能 `.agents/skills/pannel-css/SKILL.md`，再按其指引读取 `docs/css-style-guide.md`。
- 不涉及界面样式的任务无需加载该技能；现有样式按任务范围渐进整理，不进行无关的全量迁移。

## 提交

提交前检查 `git status --short`，仅暂存本次任务的文件。提交信息使用简短中文；未经要求不要推送。
