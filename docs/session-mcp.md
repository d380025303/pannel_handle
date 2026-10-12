# 本机会话 MCP

在「MCP 管理 → 本机会话 MCP」中启用服务并查看令牌。地址为 `http://127.0.0.1:43124/mcp`，仅监听本机，需要 `Authorization: Bearer <TOKEN>`。现有令牌和启用配置继续有效。

持有令牌的客户端可以查询会话、创建实例并自动提交任务。创建不额外弹出桌面确认；后续 Agent 操作仍使用现有权限和审批流程。模板配置的启动命令也会通过原有启动流程执行。

## 工具

`create_session_instance` 也接受配套的 `tools` 和 `toolCallback`，定义、回调协议及生命周期与 [HTTP 工具注入](session-api.md#注入自定义工具) 一致。仅支持本机 Windows Codex 图形会话；Plan 和正常模式均直接执行注入工具，不弹出桌面审批。

| 工具 | 用途 |
| --- | --- |
| `list_session_instances` | 查询运行中的会话、Agent 状态和最近摘要 |
| `get_session_instance_status` | 按 `sessionId` 查询单个运行实例 |
| `list_session_templates` | 仅查询配置了 Agent 的已保存模板 |
| `create_session_instance` | 从图形 Agent 模板创建新实例，选择模型和模式并提交首条任务 |

模板查询返回 `templateId`、`title`、`agentProvider`、`type`、`graphicalSessionEnabled`、`modelSource` 和 `modelId`，不返回凭据、环境变量和启动命令。非图形模板不能用于创建。

## 创建实例

先查询模板 ID，再调用 `create_session_instance`：

```json
{"templateId":"<TEMPLATE_ID>","agentProvider":"codex","mode":"plan","prompt":"分析项目并给出计划","modelId":"<MODEL_ID>"}
```

`templateId`、`mode`、`prompt` 必填，模式为 `plan` 或 `default`，任务必须非空。不支持附件或覆盖工作目录、连接、环境和执行权限。

`agentProvider` 和 `modelId` 可选：

- 均省略：继承模板 Agent 和模型配置。
- `agentProvider` 支持 `codex`、`codebuddy`、`opencode`、`claude`、`qoder`、`gemini`、`grok`；指定后覆盖模板 Agent，使用原生模型。
- `modelId` 选择最终 Agent 的原生模型，并清除继承的外部模型配置。
- 切换 Agent 时清除原 Agent 专属配置，保留工作目录、连接、环境及启动前命令，不修改保存的模板。
- 创建参数不再接受 `modelSource`；模板查询和响应仍返回实际模型来源。

不支持的来源、模型或模式会明确报错，不自动换用其他模型或正常模式。Plan 不自动转入执行阶段；正常模式不主动选择绕过审批的原生模式。

成功结果示例：

```json
{
  "sessionId": "<NEW_INSTANCE_ID>",
  "templateId": "<TEMPLATE_ID>",
  "agentProvider": "codex",
  "mode": "plan",
  "modelSource": "native",
  "modelId": "<ACTUAL_MODEL_ID>",
  "status": "started"
}
```

`started` 表示首条任务已提交，不表示任务完成。ACP 在任务消息交给 CLI 传输后返回，后续协议或执行失败通过会话状态报告；Codex 在 `turn/start` 响应后返回。无法获取原生模型 ID 时返回 `null`。

新实例会出现在现有桌面和移动端会话列表中。实例继承模板配置但不关联模板持久化，模型和模式变化不会写回原模板；结果中的 `templateId` 表示创建来源，状态查询中的实例 `templateId` 为空。

启动、模型或模式设置，以及提交前失败时关闭本次实例，保留模板。任务提交后不自动关闭或重发。每次调用都创建一个新实例；调用超时后应先查询运行实例，确认后再决定是否重试。
