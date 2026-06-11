# OpenCode 状态 Hook

本工具通过 [OpenCode 官方插件机制](https://opencode.ai/docs/plugins/) 接收结构化事件，用于显示会话状态和发送 Windows 系统通知。插件仅观察并上报事件，不会批准或拒绝权限请求。

## 工作方式

1. Electron 主进程启动本地 HTTP Hook 接收器。
2. 本工具创建终端时注入：
   - `PANNEL_HANDLE_HOOK_URL`：本地 Hook 上报地址。
   - `PANNEL_HANDLE_SESSION_ID`：本工具内部会话 ID。
3. 项目插件 `.opencode/plugins/pannel-handle-notification.js` 监听 OpenCode 事件，并 POST 到 `/opencode-hook`。
4. Electron 将事件映射为运行中、等待确认、已完成、失败或已结束，并通过现有状态徽标和系统通知展示。

## 安装

在本工具的会话侧栏点击 Hook 安装按钮，选择项目目录并勾选 **OpenCode**，然后点击“安装或修复”。

安装器只创建或更新：

```text
.opencode/plugins/pannel-handle-notification.js
```

安装器不会创建或修改 `opencode.json`。如果插件文件已存在且内容不同，原文件会备份为 `pannel-handle-notification.js.pannel-handle.bak`。

Windows 和 WSL 项目使用同一个 JavaScript 插件。WSL 会话依赖本工具通过 `WSLENV` 传递 Hook 地址和会话 ID。

## 状态映射

| OpenCode 事件 | 本工具状态 |
| --- | --- |
| `session.status` 且状态为 `busy`、工具执行事件 | 运行中 |
| `permission.asked`、`permission.updated` | 等待确认 |
| `session.idle` | 已完成 |
| `session.error` | 失败 |
| `session.deleted` | 已结束 |

其他事件仍会在启用 Debug 模式时显示，但不会改变会话状态。

## 手动验证

1. 在本工具创建 Windows 或 WSL 终端会话。
2. 使用 Hook 安装弹窗为目标项目安装 OpenCode 插件。
3. 在该会话中进入目标项目并启动 `opencode`。
4. 提交一个会调用工具的任务，确认状态依次出现“运行中”和“已完成”。
5. 触发权限请求，确认状态显示“等待确认”。
6. 将本工具窗口切到后台，确认等待权限、完成和失败状态会显示 Windows 通知。
7. 启用 Debug 模式，确认 OpenCode 事件可按 `opencode` 筛选。

## 故障排查

- 必须从本工具创建的终端中启动 OpenCode；外部终端不会继承 `PANNEL_HANDLE_HOOK_URL`。
- 确认目标项目存在 `.opencode/plugins/pannel-handle-notification.js`。
- WSL 中可运行 `printenv PANNEL_HANDLE_HOOK_URL PANNEL_HANDLE_SESSION_ID` 检查环境变量是否已传递。
- 如果插件被修改，重新使用 Hook 安装弹窗执行“安装或修复”。
- 启用 Debug 模式检查事件是否到达以及是否匹配到当前会话。
