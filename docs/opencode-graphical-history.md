# OpenCode 图形会话历史操作

桌面 Windows、WSL、SSH 图形会话支持 OpenCode V2.0.18 及更新版本的原生历史控制。

- 用户消息下的“回退到此处”回退该消息及后续工作；会话菜单的“撤销上一轮”选择最后一条用户消息。
- 回退后可点击“恢复已撤销内容”。连续撤销可以继续向前移动回退位置。
- 发送新消息会确认暂存回退，之后不能恢复被撤销的分支。已有草稿不会被回退覆盖，可使用“取回原输入”。
- 历史列表中的“重命名”修改 OpenCode 保存的标题，重新打开会话后仍然有效。

文件恢复由 OpenCode 原生快照负责，范围取决于 OpenCode 实际记录的文件修改。运行中、等待权限或提问答复时不能执行历史控制。文件恢复失败会显示原始操作错误，并重新读取真实的回退状态。

ACP 继续负责会话与消息。历史控制通过目标环境的官方 `opencode api --standalone` 调用 `session.update`、`session.revert.stage/clear/commit`，完成后重载同一 ACP 会话。控制进程不启用本工具的 Hook 或能力桥接。Windows 支持官方独立 EXE 与 `@opencode/cli` 的标准 npm 安装位置；WSL、SSH 使用目标环境登录 shell 中的 `opencode`。

## 原生表单提问

图形会话声明 ACP `elicitation.form`，使用 OpenCode 内置 `question` 工具通过 `elicitation/create` 发来的表单。桌面端和移动端均支持单选、多选、自由文本、自定义答案、提交和取消。单选的自定义答案替代选项，多选的自定义答案附加到选项；取消后由 OpenCode 结束该问题。停止或关闭会话会清理待回答问题。

不再注入自定义提问 MCP、覆盖 `question` 工具或禁用内置提问。不支持原生表单提问的旧版 OpenCode 不再使用旧桥接回退。

已有项目在正常 Hook 安装/修复时会清理本工具原样生成的 `.opencode/plugins/pannel-handle-question.js`（Windows、WSL、SSH）。修改过的同名插件会保留并报告路径；请检查并移走覆盖原生提问的插件后重试。通知和能力列表插件仍会安装。

参考：[OpenCode ACP 表单提问](https://opencode.ai/v2/docs/cli/acp/#questions)。

参考：[原生撤销语义](https://opencode.ai/v2/docs/cli/tui/)、[V2 API](https://opencode.ai/v2/docs/api)。

## 额外目录授权

桌面新建或编辑 OpenCode 图形会话时，可在“额外授权目录”中每行填写一个绝对路径。Windows 和 SSH 本机 Agent 使用盘符或 UNC 路径；WSL、Linux SSH 使用对应环境中的 POSIX 路径。路径不会自动转换或展开，不能包含通配符。授权仍受 OpenCode 的读写和 Shell 权限约束。

配置保存在本应用的会话库中，移动端沿用同一配置。编辑保存不会打断当前任务；下一次新建、加载、恢复、分叉或重新连接时，通过 ACP `additionalDirectories` 应用当前列表。空列表会替换历史会话原有授权。旧版 CLI 未声明该能力时，空配置继续兼容；非空配置明确报错，需升级 CLI 或清空配置。

参考：[OpenCode ACP 额外目录](https://opencode.ai/v2/docs/cli/acp/#additional-directories)。
