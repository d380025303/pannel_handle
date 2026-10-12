# HTTP 会话接口

点击最顶部标题栏的「接口调用」，进入独立调试工作区。服务默认关闭；启用后监听 `0.0.0.0`，默认端口为 `43125`，页面展示本机及局域网地址。服务随应用退出停止，已保存的启用状态和端口在应用启动时恢复。

接口使用独立令牌，与本机会话 MCP 的令牌和启用状态无关。所有请求需要 `Authorization: Bearer <ACCESS_TOKEN>`。页面可以查看、复制或重置令牌；重置立即使旧令牌失效。配置和令牌保存在 Electron `userData` 的 `session-api.json`，不会写入仓库。局域网设备使用页面展示的地址，访问仍受 Windows 防火墙和网络连通性影响。

## 查询模板

`GET /api/v1/session-templates` 返回 HTTP 200：

```json
{"templates":[{"templateId":"saved","title":"Work","agentProvider":"codex","type":"windows","graphicalSessionEnabled":true,"modelSource":"native","modelId":null}]}
```

仅返回配置了 Agent 的保存模板，不返回凭据、环境变量或启动命令。非图形模板也会列出，但不能用于创建接口。

```sh
curl 'http://127.0.0.1:43125/api/v1/session-templates' -H 'Authorization: Bearer <ACCESS_TOKEN>'
```

## 创建实例

`POST /api/v1/session-instances`，使用 `Content-Type: application/json`：

```json
{"templateId":"saved","mode":"plan","prompt":"分析项目并给出计划"}
```

`templateId`、`mode`、`prompt` 必填；模式为 `plan` 或 `default`（正常模式）。可选字段 `agentProvider`、`modelId`、`tools` 和 `toolCallback` 与 [MCP 创建工具](session-mcp.md) 共用实现及参数校验。未知字段会被拒绝，请求体上限为 256 KiB。

`agentProvider` 可覆盖模板 Agent，例如 `codex`、`codebuddy` 或 `opencode`。指定 Agent 或模型时使用原生模型；均省略时继承模板配置。创建参数不再支持 `modelSource`。

成功返回 HTTP 201：

```json
{"sessionId":"new","templateId":"saved","agentProvider":"codex","mode":"plan","modelSource":"native","modelId":null,"status":"started"}
```

每次调用真实启动新会话并提交任务，不修改来源模板。`started` 表示任务已提交，不表示任务完成。后续执行沿用现有 Agent 权限和审批流程。

```sh
curl -X POST 'http://127.0.0.1:43125/api/v1/session-instances' -H 'Authorization: Bearer <ACCESS_TOKEN>' -H 'Content-Type: application/json' --data-raw '{"templateId":"saved","mode":"plan","prompt":"分析项目并给出计划"}'
```

以上为 POSIX shell 示例；Windows PowerShell 可使用 `Invoke-RestMethod`：

```powershell
$headers = @{ Authorization = 'Bearer <ACCESS_TOKEN>' }
Invoke-RestMethod -Uri 'http://127.0.0.1:43125/api/v1/session-templates' -Headers $headers
$body = @{ templateId = 'saved'; mode = 'plan'; prompt = '分析项目并给出计划' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:43125/api/v1/session-instances' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

## 注入自定义工具

本机 Windows Codex 图形会话支持创建时注入工具；其他 Agent、WSL 和 SSH 携带工具时返回 422。需要支持动态工具的 Codex App Server，本机协议版本为 0.159.2。

```json
{
  "templateId": "saved",
  "mode": "plan",
  "prompt": "调用 lookup_order 查询订单 123",
  "tools": [{
    "name": "lookup_order",
    "description": "查询订单",
    "inputSchema": {
      "type": "object",
      "properties": { "orderId": { "type": "string" } },
      "required": ["orderId"]
    }
  }],
  "toolCallback": {
    "url": "http://127.0.0.1:8080/tools",
    "bearerToken": "可选的独立回调令牌",
    "timeoutMs": 60000
  }
}
```

`tools` 和 `toolCallback` 必须一起提供；工具数量为 1–64，名称为 1–64 个 ASCII 字母、数字、下划线或连字符，不能重复，也不能与 Codex 保留工具名称冲突。参数 schema 顶层必须为 `object`；更深层的 schema 由 Codex 校验。回调地址支持 HTTP/HTTPS、本机和局域网，不能内嵌凭据，不跟随重定向。超时默认 60000 毫秒，允许 1000–120000 毫秒。

Pannel 向统一回调地址发送 POST JSON，通过工具名称分发；仅在提供 `bearerToken` 时发送 `Authorization: Bearer <bearerToken>`，不会转发创建接口令牌：

```json
{"sessionId":"run","threadId":"thread","turnId":"turn","callId":"call","tool":"lookup_order","arguments":{"orderId":"123"}}
```

回调返回 HTTP 200 和 JSON：

```json
{"success":true,"output":"订单已发货"}
```

`success` 必须为布尔值，`output` 必须为字符串；业务失败返回 `success: false` 和原因。首版仅支持文本结果，请求和响应均限制为 256 KiB。网络错误、超时、非 200 或无效响应会作为工具失败交给模型。同一调用最多发出一次回调，不自动重试；不同调用可并发。

Plan 和正常模式均直接执行注入工具，无需桌面审批；回调服务负责限制副作用。注入工具不改变现有内置工具的审批策略。会话中断、关闭或进程退出会取消本地请求，但无法撤销回调服务已经执行的操作。

配置仅绑定当前实例，来源模板不变。回调地址和凭据仅保留在主进程内存；同一实例的 Codex 重启保留配置，应用退出后不恢复。复制、分叉、切换历史和新线程不继承回调执行授权；历史中残留的工具定义调用时会返回配置失效错误。Codex 自身可能保存工具定义及调用内容到线程历史。

调试表单首版没有工具字段，请使用 HTTP 或 MCP 客户端提交完整参数。工具定义、参数和文本结果会通过现有桌面工具时间线展示。

## 调试与错误

工作区先发送模板查询，或在创建页面点击「刷新模板」，再选择模板和填写任务。默认 Plan 模式并继承模板模型。发送后展示实际 URL、方法、HTTP 状态、耗时和响应，成功可点击「打开会话」。工作区切换保留表单和结果，关闭应用后不保存调试内容。复制的 cURL 使用令牌占位符。

错误格式为 `{"error":{"code":"invalid_parameters","message":"…"}}`。状态码：400 参数或 JSON 错误，401 令牌无效，403 浏览器 Origin 被拒绝，404 模板或接口不存在，405 方法错误，413 请求过大，422 不支持的配置，500 启动、提交或内部错误。不开放浏览器跨域访问。

调试请求通过主进程真实调用本机 HTTP 接口，最长等待 120 秒，不自动重试。超时或响应丢失不能证明创建失败，请先检查桌面会话列表，再决定是否重试。首版没有 HTTP 会话状态查询接口；运行状态可从已有桌面、移动端或 MCP 查询。

## 查询实例

`GET /api/v1/session-instances` 返回 HTTP 200 和 `{ "sessions": [...] }`，没有实例时返回空数组。范围与 MCP 一致，包含所有仍打开的会话，不限于 HTTP 创建的实例。

`GET /api/v1/session-instances/:sessionId` 返回 HTTP 200 和单个实例对象。例如：

```json
{"sessionId":"new","title":"Work","templateId":"saved","runtimeMode":"app-server","type":"windows","agentProvider":"codex","sshConnectionState":null,"workState":"running","summary":"正在执行任务","queriedAt":1791696000000}
```

状态计算与 MCP 共用，但查询不要求启用 MCP。`workState` 可为 `connecting`、`reconnecting`、`disconnected`、`waiting_for_input`、`waiting_for_permission`、`waiting_for_plan`、`failed`、`running`、`idle` 或 `unknown`；`idle` 不等同于任务成功完成。会话关闭后不保留历史记录，查询返回 HTTP 404，错误码为 `session_not_found`。

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:43125/api/v1/session-instances' -Headers $headers
Invoke-RestMethod -Uri 'http://127.0.0.1:43125/api/v1/session-instances/new' -Headers $headers
```

会话 ID 作为 URL 路径段编码。非法路径编码返回 HTTP 400。调试页面提供两个 GET 入口和 ID 输入框；创建成功后点击「查询状态」直接查询返回的 ID。采用手动查询，不自动轮询。
