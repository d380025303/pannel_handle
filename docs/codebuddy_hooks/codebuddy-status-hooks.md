# CodeBuddy 状态 Hook

Pannel Handle 可以把 CodeBuddy CLI 作为 Agent 会话启动，并通过项目 Hook 在侧栏显示运行、权限等待、完成、失败和会话结束状态。

## 前置条件

- Node.js 18 或更高版本。
- 全局安装 CodeBuddy CLI：`npm install -g @tencent-ai/codebuddy-code`。
- Windows 使用 Hook 时需要安装 Git for Windows；CodeBuddy 在 Windows 下通过 Git Bash 执行 Hook 命令。
- 状态 Hook 需要 CodeBuddy Code v1.16.0 或更高版本。

可运行 `codebuddy --version` 和 `codebuddy` 验证安装与登录状态。Pannel Handle 只检测外部命令，不会下载、登录或升级 CodeBuddy。

## 使用方式

1. 创建或编辑会话，在 Agent CLI 中选择 **CodeBuddy**，并填写明确的项目工作目录。
2. 启动会话。Pannel Handle 会在项目的 `.codebuddy/settings.local.json` 中合并状态 Hook，并安装 `.codebuddy/pannel-handle-codebuddy-hook.ps1` 或 `.sh`。
3. 首次启动后，在 CodeBuddy 中执行 `/hooks`，审核并确认 Pannel Handle 写入的项目 Hook。CodeBuddy 不会自动信任外部修改的 Hook 配置。
4. 提交提示词并执行工具，观察会话侧栏状态；需要查看原始事件时，可打开 Pannel Handle 的调试侧栏并筛选 `codebuddy`。

Hook 安装会保留已有 CodeBuddy 设置，并在覆盖配置或脚本前创建 `.pannel-handle.bak` 备份。CodeBuddy Hook 当前仍为 Beta，升级 CLI 后如果状态不再上报，可在 Hook 安装窗口执行“修复”并重新通过 `/hooks` 审核。

## Windows、WSL 与 SSH

- Windows 会话在本机项目中写入 PowerShell 转发脚本；该命令由 CodeBuddy 的 Git Bash Hook 执行器调用。
- WSL 会话在对应 Linux 项目中写入 Bash 转发脚本，需要 WSL 中可用 `python3`。
- SSH 会话把 Hook 配置和脚本写入远端项目，并通过 Pannel Handle 的 SSH Hook 隧道回传状态；远端需要可用 `python3`。
- SSH 的“本地运行 Agent”桥接仍只支持 Codex；CodeBuddy 使用远端 CLI 模式。

## 故障排查

- 提示找不到 `codebuddy`：在会话对应的 Windows、WSL 或 SSH 环境中安装 CLI，确认 `codebuddy --version` 可执行。
- CLI 正常但没有状态：执行 `/hooks` 确认项目 Hook 已审核启用，并在 Hook 安装窗口检查是否需要修复。
- Windows Hook 无法执行：确认 Git for Windows 已安装且 CodeBuddy 能找到 Git Bash。
- WSL/SSH Hook 报错：确认项目目录可写、`python3` 可用，并检查调试侧栏中的 Hook 事件。

官方资料：[CLI 概述](https://www.codebuddy.cn/docs/cli/overview)、[Hooks 参考](https://www.codebuddy.cn/docs/cli/hooks)、[设置配置](https://www.codebuddy.cn/docs/cli/settings)。
