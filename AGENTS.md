# 仓库指南

## 项目结构与模块组织

本项目是一个 Windows 桌面终端会话管理器，基于 Electron、Vite、React 和 TypeScript。

- `src/` 是渲染进程应用。`src/App.tsx` 负责组合页面状态、弹窗和主布局；`src/components/` 放置会话栏、终端面板、远程文件面板等 UI；`src/hooks/` 放置终端实例、会话数据、窗口状态和侧栏拖拽等逻辑。
- `src/styles.css` 是全局样式入口，通过 `src/styles/` 下的 `tokens.css`、`base.css`、`layout.css`、`components.css`、`features.css`、`responsive.css` 等文件分层组织样式。
- `electron/` 是桌面端外壳。`electron/main.cjs` 负责应用生命周期和模块装配，`electron/preload.cjs` 负责安全桥接；主进程模块按领域拆分到 `agents/`、`core/`、`hooks/`、`notifications/`、`services/`、`ssh/`、`stores/` 和 `terminal/` 子目录。
- `electron/preload.cjs` 向渲染进程暴露安全 API；新增渲染进程能力时，同步更新 `src/vite-env.d.ts` 类型。
- `docs/` 存放 Claude/Codex Hook 等使用文档，`scripts/` 存放构建前补丁脚本，`build/` 存放应用图标等打包资产。
- `dist/` 和 `release/` 是构建产物目录，不要手动编辑。

## 构建、测试与开发命令

请统一使用 `pnpm`，仓库已包含 `pnpm-lock.yaml`。

- `pnpm install`：安装依赖。
- `pnpm dev`：只启动 Vite 渲染进程开发服务器，地址为 `127.0.0.1:5173`。
- `pnpm electron`：启动 Electron 应用入口。
- `pnpm start`：完整开发模式，先启动 Vite，再等待服务可用后启动 Electron。
- `pnpm test`：运行 Vitest 单元测试。
- `pnpm build`：执行 `tsc` 类型检查，并将生产构建输出到 `dist/`。
- `pnpm dist:portable`：构建 Windows portable 安装包。

## 代码风格与命名约定

渲染进程使用 TypeScript、React 函数组件和 Hooks。保持现有双引号导入风格；JSON 使用 2 空格缩进，TypeScript 格式与现有文件一致。React 组件和导出类型使用 `PascalCase`，函数、局部变量和 IPC 辅助方法使用 `camelCase`。Electron 主进程和预加载脚本使用 CommonJS（`.cjs`），除非明确迁移，否则不要改为 ESM。

## 测试指南

提交前至少运行 `pnpm build`。涉及 Electron 主进程模块的改动，还应运行 `pnpm test`，必要时对改动过的 `electron/**/*.cjs` 执行 `node --check`。涉及 UI 或 IPC 的改动，还应运行 `pnpm start`，手动验证会话创建、切换、缩放、重命名、关闭、终端输入、SSH/WSL 相关路径和 Hook 状态显示。

测试文件目前就近放置在 `electron/**/*.test.mjs`，使用 Vitest。新增测试时优先覆盖可独立注入依赖的后端模块，避免引入重量级端到端测试，除非变更确实需要。

## 提交与 Pull Request 规范

提交信息建议使用简短祈使句。提交前检查 `git status --short`，只暂存本次任务相关文件，避免把无关工作树改动混入提交。Pull Request 应说明用户可见变化、列出验证命令、标注 Electron/PTY/SSH/Hook 相关风险；涉及界面的改动应附截图或简短录屏。commit名称需要使用中文说明。

## 安全与配置提示

保持 Electron 窗口中的 `contextIsolation: true` 和 `nodeIntegration: false`。新增渲染进程能力时，应通过 `electron/preload.cjs` 暴露受控 API，并在 `src/vite-env.d.ts` 中补充类型；不要把原始 Node 或 Electron API 直接暴露给 React。涉及本地凭据、SSH known hosts 或安全存储的改动，要保持数据文件位于 Electron `userData` 路径下，并避免把机器本地配置写入仓库。

## 注意

当使用 plan mode 时，计划内容需要为中文。
