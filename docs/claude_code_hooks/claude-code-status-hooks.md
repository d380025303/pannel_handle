# Claude Code 状态监听配置

本文说明本工具如何监听 Claude Code 的完成、等待确认和退出状态，以及在其他 Claude 项目中如何配置。

## 工作原理

本工具不解析终端文本，而是使用 Claude Code hooks 获取结构化事件。

1. Electron 主进程启动一个只监听 `127.0.0.1` 的本地 HTTP 接收器。
2. 每个 PTY 会话启动时会注入环境变量：
   - `PANNEL_HANDLE_HOOK_URL`：hook 事件上报地址。
   - `PANNEL_HANDLE_SESSION_ID`：本工具内部会话 ID。
3. Claude Code 触发 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、`Notification`、`Stop`、`StopFailure`、`SessionEnd` 等 hook。
4. `.claude/pannel-handle-hook.ps1` 从 stdin 读取 Claude hook JSON，并 POST 到 `PANNEL_HANDLE_HOOK_URL`。
5. Electron 将 hook 映射为前端状态：
   - `UserPromptSubmit` -> `running`
   - `PreToolUse` -> `running`
   - `PermissionRequest` -> `waiting_for_permission`
   - `Notification` + `permission_prompt` -> `waiting_for_permission`
   - `Notification` + `idle_prompt` -> `e_prompt`
   - `Stop` -> `completed`（resolution: `none`）
   - `StopFailure` -> `failed`（resolution: `none`）
   - `PostToolUse`（失败）-> `failed`（resolution: `provide_input`）
   - `PostToolUse`（成功）-> 忽略
   - `SessionEnd` -> `ended`（resolution: `none`）
   - PTY exit -> `exited`

只要 Claude 是从本工具创建的终端会话中启动，就会继承这些环境变量。

## 当前项目配置

当前项目使用本地 Claude 配置：

- `.claude/settings.local.json`
- `.claude/pannel-handle-hook.ps1`

`settings.local.json` 配置 Claude hooks，`pannel-handle-hook.ps1` 负责把事件上报给 Electron。hook 脚本是 best-effort：上报失败不会自动批准、拒绝权限，也不会改变 Claude 的正常权限流程。

注意：`.claude/` 已在 `.gitignore` 中，因此这些本机配置默认不会进入 Git。

## 本项目必须配置什么

本项目要让 Claude 状态监听生效，需要同时满足下面几部分。

### 1. Electron 应用侧

这些已经在项目代码中实现，不需要手动配置：

- `electron/main.cjs` 启动本地 hook HTTP 接收器。
- `electron/main.cjs` 在创建 PTY 时注入：
  - `PANNEL_HANDLE_HOOK_URL`
  - `PANNEL_HANDLE_SESSION_ID`
- `electron/preload.cjs` 暴露 `terminalApi.onAgentStatus(...)`。
- `src/vite-env.d.ts` 定义 `AgentStatusPayload` 等类型。
- `src/App.tsx` 订阅 `agent:status` 并显示状态。

如果后续移动 hook 脚本位置，Electron 代码不需要改；只需要更新 Claude hooks 里的 `command`。

### 2. 本项目 Claude hooks 配置

本项目的 `.claude/settings.local.json` 必须包含 `hooks` 字段，用来告诉 Claude Code 在特定事件发生时调用上报脚本。

最小配置如下：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/pannel-handle-hook.ps1"
          }
        ]
      }
    ]
  }
}
```

推荐配置还应包含 `Notification` 的 `permission_prompt` 和 `idle_prompt`，以及 `SessionEnd`。当前本项目的 `.claude/settings.local.json` 已包含这些事件。用户在终端输入或切换会话不会切换到 `running`，只有 Claude hook 事件才会更新 agent 状态。

如果 `.claude/settings.local.json` 已有 `permissions.allow`，保留它，只合并 `hooks`，不要覆盖整个文件。

### 3. 本项目 hook 脚本

本项目必须存在：

```text
.claude/pannel-handle-hook.ps1
```

该脚本负责：

- 从 stdin 读取 Claude Code hook JSON。
- 附加 `cwd` 和 `PANNEL_HANDLE_SESSION_ID`。
- POST 到 `PANNEL_HANDLE_HOOK_URL`。
- 上报失败时只打印错误，不改变 Claude 权限确认流程。

### 4. 运行前提

本项目运行时需要：

- 使用 `pnpm start` 启动本工具。
- 在本工具创建的终端会话中启动 `claude`。
- 不使用 `claude --bare`，因为该模式会跳过 hooks。
- 当前 shell 能运行 `powershell.exe`，Windows 默认满足。

如果直接在外部 PowerShell、Windows Terminal 或 IDE 终端里启动 `claude`，不会继承本工具注入的 `PANNEL_HANDLE_HOOK_URL`，因此本工具无法收到状态事件。

## 新 Claude 项目配置

如果在其他项目目录中运行 `claude`，该项目也需要配置 hooks。推荐使用本工具中的 hook 脚本绝对路径，避免每个项目复制脚本。

在新项目的 `.claude/settings.local.json` 中添加：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\mine\\crm\\personal\\pannel_handle\\.claude\\pannel-handle-hook.ps1"
          }
        ]
      }
    ]
  }
}
```

如果新项目已经有 `.claude/settings.local.json`，不要覆盖原文件；只合并 `hooks` 字段，并保留已有 `permissions`、`mcpServers` 或其他配置。

## 用户级配置

如果希望所有 Claude 项目默认启用状态监听，可以把同样的 `hooks` 配置放到 Claude Code 用户级 settings 中，并继续使用 hook 脚本绝对路径。

这种方式的前提仍然是：Claude 必须从本工具创建的终端里启动。否则 `PANNEL_HANDLE_HOOK_URL` 不存在，hook 脚本会直接退出，不会上报任何状态。

## 手动验证

1. 启动本工具：

```powershell
pnpm start
```

2. 在本工具中新建会话，并在终端中启动 Claude：

```powershell
claude
```

3. 让 Claude 执行一个未被 allow 的命令，触发权限确认。

预期结果：

- 会话列表显示 `Claude 等待确认` 或 `Claude 等待确认: Bash`。
- 终端标题区域显示同样状态。
- 人工批准后，Claude 完成回复时状态变为 `Claude 已完成`。
- Claude 回复完毕、空闲等待用户下一轮输入时，状态变为 `Claude 等待输入`。
- 用户输入新问题或 Claude 开始执行工具时，状态切回 `Claude 运行中`。
- 工具执行失败时，状态变为 `Claude 失败`。
- 退出 Claude 或关闭会话后，状态变为 `Claude 已结束`。

## 常见问题

### 状态没有出现

检查以下条件：

- Claude 是否从本工具创建的终端会话中启动。
- 是否使用了 `claude --bare`。该模式会跳过 hooks。
- 当前项目或用户级 settings 是否包含 hooks 配置。
- hook 命令中的脚本路径是否存在。
- hook 命令中的 PowerShell 脚本路径是否存在，当前 shell 是否能执行 `powershell.exe`。

### 多个项目是否都要复制脚本

不需要。推荐在其他项目中使用 `pannel-handle-hook.ps1` 的绝对路径，只复制或合并 hooks 配置即可。

### hook 会自动批准权限吗

不会。当前 hook 只上报事件，不返回 `allow` 或 `deny` 决策，人工确认流程仍由 Claude Code 自己处理。
