# Claude Code 图形会话

在创建 Claude 会话时默认开启“使用图形会话”。已有 Claude 模板仍按终端模式运行，可在编辑模板时手动开启图形模式。

图形模式使用 `claude-agent-acp` 连接 Claude Agent SDK。请在 Agent 实际运行的环境安装 `@agentclientprotocol/claude-agent-acp`，并保证该环境已有可用的 Claude 凭据。Windows、WSL 和 SSH 远端运行分别使用各自环境的安装与凭据；SSH 本机 Agent 桥接使用 Windows 本机的安装与凭据。应用内不提供 Claude 登录页，也不会自动下载安装适配器。

SSH 本机桥接仅支持图形模式。该模式通过会话专属的远端 MCP 通道访问 SSH 工作区，并在 Claude ACP 会话中关闭本机内置文件与命令工具；若远端桥接配置不完整，会拒绝启动。首次使用时，应在目标环境中实际发送一轮消息，确认工具调用的路径与权限符合预期。

模式、模型、思考强度和历史记录等入口以适配器返回的能力为准。桌面和手机端均可处理 ACP 权限请求与表单提问。安装检查、单元测试和构建无法代替真实 Claude 凭据及 SSH 环境中的运行验收。
