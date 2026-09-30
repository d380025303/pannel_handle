# OpenCode 图形会话历史操作

桌面 Windows、WSL、SSH 图形会话支持 OpenCode V2.0.18 及更新版本的原生历史控制。

- 用户消息下的“回退到此处”回退该消息及后续工作；会话菜单的“撤销上一轮”选择最后一条用户消息。
- 回退后可点击“恢复已撤销内容”。连续撤销可以继续向前移动回退位置。
- 发送新消息会确认暂存回退，之后不能恢复被撤销的分支。已有草稿不会被回退覆盖，可使用“取回原输入”。
- 历史列表中的“重命名”修改 OpenCode 保存的标题，重新打开会话后仍然有效。

文件恢复由 OpenCode 原生快照负责，范围取决于 OpenCode 实际记录的文件修改。运行中、等待权限或提问答复时不能执行历史控制。文件恢复失败会显示原始操作错误，并重新读取真实的回退状态。

ACP 继续负责会话与消息。历史控制通过目标环境的官方 `opencode api --standalone` 调用 `session.update`、`session.revert.stage/clear/commit`，完成后重载同一 ACP 会话。控制进程不启用本工具的 Hook、Question 或能力桥接。Windows 支持官方独立 EXE 与 `@opencode/cli` 的标准 npm 安装位置；WSL、SSH 使用目标环境登录 shell 中的 `opencode`。

参考：[原生撤销语义](https://opencode.ai/v2/docs/cli/tui/)、[V2 API](https://opencode.ai/v2/docs/api)。
