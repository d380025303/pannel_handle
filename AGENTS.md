# 仓库指南

## 项目结构与模块组织

本项目是一个 Windows 桌面终端会话管理器，基于 Electron、Vite、React 和 TypeScript。

- `src/` 是渲染进程应用。`src/App.tsx` 负责会话界面和 xterm.js 集成，`src/main.tsx` 挂载 React，`src/styles.css` 存放全局样式。
- `electron/` 是桌面端外壳。`electron/main.cjs` 管理窗口、PTY 会话和 IPC；`electron/preload.cjs` 向渲染进程暴露安全 API。
- `index.html`、`vite.config.ts`、`tsconfig.json` 是 Vite 和 TypeScript 的入口配置。
- `dist/` 和 `release/` 是构建产物目录，不要手动编辑。
- 当前没有独立的 `tests/` 或资产目录。

## 构建、测试与开发命令

请统一使用 `pnpm`，仓库已包含 `pnpm-lock.yaml`。

- `pnpm install`：安装依赖。
- `pnpm dev`：只启动 Vite 渲染进程开发服务器，地址为 `127.0.0.1:5173`。
- `pnpm electron`：启动 Electron 应用入口。
- `pnpm start`：完整开发模式，先启动 Vite，再等待服务可用后启动 Electron。
- `pnpm build`：执行 `tsc` 类型检查，并将生产构建输出到 `dist/`。
- `pnpm dist:dir`：构建应用，并将 Windows 解包版本输出到 `release/win-unpacked/`。

## 代码风格与命名约定

渲染进程使用 TypeScript、React 函数组件和 Hooks。保持现有双引号导入风格；JSON 使用 2 空格缩进，TypeScript 格式与现有文件一致。React 组件和导出类型使用 `PascalCase`，函数、局部变量和 IPC 辅助方法使用 `camelCase`。Electron 主进程和预加载脚本目前使用 CommonJS（`.cjs`），除非明确迁移，否则不要改为 ESM。

## 测试指南

当前未配置测试框架。提交前至少运行 `pnpm build`。涉及 UI 或 IPC 的改动，还应运行 `pnpm start`，手动验证会话创建、切换、缩放、重命名、关闭和终端输入。如果后续添加测试，建议使用就近放置的 `*.test.ts` 或 `*.test.tsx`，并补充 `pnpm test` 脚本。

## 提交与 Pull Request 规范

Git 历史目前只有初始提交，尚未形成固定提交规范。提交信息建议使用简短祈使句，例如 `Add terminal resize handling` 或 `Fix session close cleanup`。Pull Request 应说明用户可见变化、列出验证命令、标注 Electron/PTY 相关风险；涉及界面的改动应附截图或简短录屏。

## 安全与配置提示

保持 Electron 窗口中的 `contextIsolation: true` 和 `nodeIntegration: false`。新增渲染进程能力时，应通过 `electron/preload.cjs` 暴露受控 API，并在 `src/vite-env.d.ts` 中补充类型；不要把原始 Node 或 Electron API 直接暴露给 React。

## 注意
当claude使用plan mode的时候，计划内容需要为中文