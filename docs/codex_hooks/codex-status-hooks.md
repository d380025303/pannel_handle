# Codex 状态监听配置

本文说明本工具如何监听 Codex 的运行、等待确认和完成状态。

## 工作方式

本工具不解析终端文本，而是使用 Codex hooks 获取结构化事件。

1. Electron 主进程启动本地 HTTP hook 接收器。
2. 每个 PTY 会话启动时会注入环境变量：
   - `PANNEL_HANDLE_HOOK_URL`：hook 事件上报地址。
   - `PANNEL_HANDLE_SESSION_ID`：本工具内部会话 ID。
3. Codex 触发 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop` 等 hook。
4. `.codex/pannel-handle-hook.ps1` 从 stdin 读取 Codex hook JSON，并 POST 到本工具的 `/codex-hook`。
5. Electron 将 hook 映射为前端状态：
   - `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse` -> `running`
   - `PermissionRequest` -> `waiting_for_permission`
   - `Stop` -> `completed`
   - PTY exit -> `exited`

只要 Codex 是从本工具创建的终端会话中启动，就会继承这些环境变量。

## 本项目配置

当前项目使用项目级 Codex 配置：

- `.codex/hooks.json`
- `.codex/pannel-handle-hook.ps1`

`hooks.json` 配置 Codex hooks，`pannel-handle-hook.ps1` 负责把事件上报给 Electron。hook 脚本是 best-effort：上报失败不会自动批准、拒绝权限，也不会改变 Codex 的正常权限流程。

项目级 hooks 首次使用时，可能需要在 Codex 中通过 `/hooks` 审核并信任。

## 验证

1. 启动本工具：

```powershell
pnpm start
```

2. 在本工具中新建会话，并在终端中进入本项目目录后启动 Codex：

```powershell
codex
```

3. 发送一个普通任务，确认会话列表显示 `Codex 运行中`。
4. 触发一次需要确认的工具操作，确认会话列表显示 `Codex 等待确认` 或 `Codex 等待确认: <tool>`。
5. 等 Codex 完成回复，确认状态变为 `Codex 已完成`。
6. 退出 Codex 或关闭会话，确认状态变为 `进程已退出`。

## 新 Codex 项目配置

如果在其他项目目录中运行 `codex`，该项目也需要配置 hooks。推荐使用本工具中的 hook 脚本绝对路径，避免每个项目复制脚本。

在新项目的 `.codex/hooks.json` 中添加同样的 `hooks` 配置，并把 `command` 改为绝对路径，例如：

```json
{
  "type": "command",
  "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.codex\\pannel-handle-hook.ps1"
}
```

这种方式的前提仍然是：Codex 必须从本工具创建的终端里启动。否则 `PANNEL_HANDLE_HOOK_URL` 不存在，hook 脚本会直接退出，不会上报任何状态。

## 常见问题

### 外部终端启动 Codex 能监听吗

不能。外部 PowerShell、Windows Terminal 或 IDE 终端不会继承本工具注入的 `PANNEL_HANDLE_HOOK_URL`。

### hook 会自动批准权限吗

不会。当前 hook 只上报事件，不返回 `allow` 或 `deny` 决策，人工确认流程仍由 Codex 自己处理。

### 没有状态变化时检查什么

- Codex 是否从本工具创建的终端会话中启动。
- 当前项目或用户级 Codex 配置是否包含 hooks。
- 项目级 hooks 是否已在 Codex `/hooks` 中信任。
- hook 命令中的 PowerShell 脚本路径是否存在。
- 当前 shell 是否能执行 `powershell.exe`。
