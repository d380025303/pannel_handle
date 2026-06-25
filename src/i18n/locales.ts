export type Locale = "zh-CN" | "en-US";

export const DEFAULT_LOCALE: Locale = "zh-CN";

export type TranslationParams = Record<string, string | number>;

export type TranslationKey =
  | "app.noActiveSession"
  | "settings.title"
  | "settings.open"
  | "settings.autoRestore"
  | "settings.debugMode"
  | "settings.theme"
  | "settings.language"
  | "settings.close"
  | "settings.dingTalkTitle"
  | "settings.dingTalkDescription"
  | "settings.dingTalkEnabled"
  | "settings.dingTalkWebhook"
  | "settings.dingTalkSecret"
  | "settings.dingTalkSecretOptional"
  | "settings.dingTalkConfigured"
  | "settings.dingTalkTest"
  | "settings.dingTalkClear"
  | "settings.dingTalkSaved"
  | "settings.dingTalkCleared"
  | "settings.dingTalkTestSuccess"
  | "settings.completionTitle"
  | "settings.completionDescription"
  | "settings.completionEnabled"
  | "settings.completionBaseUrl"
  | "settings.completionModel"
  | "settings.completionApiKey"
  | "settings.completionApiKeyPlaceholder"
  | "settings.completionConfigured"
  | "settings.completionTest"
  | "settings.completionClear"
  | "settings.completionSaved"
  | "settings.completionCleared"
  | "settings.completionTestSuccess"
  | "settings.completionThinkingEnabled"
  | "settings.completionThinkingLevel"
  | "settings.completionThinkingLevelHigh"
  | "settings.completionThinkingLevelMax"
  | "language.zhCN"
  | "language.enUS"
  | "common.cancel"
  | "common.close"
  | "common.save"
  | "common.confirm"
  | "common.delete"
  | "common.clear"
  | "common.retry"
  | "common.refresh"
  | "common.search"
  | "common.searchOptions"
  | "common.noMatchingOptions"
  | "common.loading"
  | "common.none"
  | "common.select"
  | "common.import"
  | "common.importing"
  | "common.export"
  | "common.exporting"
  | "common.download"
  | "common.uploadFile"
  | "common.reload"
  | "common.saved"
  | "common.saving"
  | "common.unsavedChanges"
  | "confirm.discardUnsavedFileChanges"
  | "confirm.deleteEntry"
  | "window.minimize"
  | "window.maximize"
  | "window.restore"
  | "window.close"
  | "sidebar.title"
  | "sidebar.count"
  | "sidebar.countFiltered"
  | "sidebar.openLibrary"
  | "sidebar.newSession"
  | "sidebar.searchPlaceholder"
  | "sidebar.clearSearch"
  | "sidebar.empty"
  | "sidebar.installHooks"
  | "sidebar.editSession"
  | "sidebar.closeSession"
  | "sidebar.confirmClose"
  | "session.newTitle"
  | "session.editTitle"
  | "session.name"
  | "session.namePlaceholder"
  | "session.tags"
  | "session.host"
  | "session.hostPlaceholder"
  | "session.port"
  | "session.username"
  | "session.passwordOrKeyPassphrase"
  | "session.passwordCreatePlaceholder"
  | "session.passwordEditPlaceholder"
  | "session.clearSavedPassword"
  | "session.advancedSsh"
  | "session.identityFile"
  | "session.cwd"
  | "session.initialCommand"
  | "session.initialCommandPlaceholder"
  | "session.agentCli"
  | "session.normalTerminal"
  | "session.agentCwdRequired"
  | "session.preLaunchCommand"
  | "session.saving"
  | "session.updateFailed"
  | "session.sshArgs"
  | "session.remark"
  | "session.remarkPlaceholder"
  | "session.create"
  | "session.creating"
  | "session.createFailed"
  | "quickCommand.placeholder"
  | "quickCommand.heading"
  | "quickCommand.commandPlaceholder"
  | "quickCommand.write"
  | "quickCommand.autoEnter"
  | "quickCommand.oneTime"
  | "quickCommand.add"
  | "tag.remove"
  | "tag.placeholderEmpty"
  | "tag.placeholderAdd"
  | "agent.waitingForPermission"
  | "agent.waitingForPermissionTool"
  | "agent.idlePrompt"
  | "agent.completed"
  | "agent.failed"
  | "agent.running"
  | "agent.ended"
  | "agent.exited"
  | "terminal.exited"
  | "terminal.imagePasteFailed"
  | "composer.inputLabel"
  | "composer.placeholder"
  | "composer.send"
  | "composer.pasteImage"
  | "composer.searchWorkspace"
  | "composer.noMatches"
  | "composer.searchFailed"
  | "composer.uploadingImage"
  | "composer.noClipboardImage"
  | "composer.imageUploadFailed"
  | "composer.suggesting"
  | "composer.completionFailed"
  | "tabs.files"
  | "tabs.git"
  | "tabs.debug"
  | "tabs.completionDebug"
  | "debug.eventsCount"
  | "debug.clearEvents"
  | "debug.providerFilter"
  | "debug.allInstances"
  | "debug.noMatchedSession"
  | "debug.noEvents"
  | "debug.handled"
  | "debug.unhandled"
  | "completionDebug.eventsCount"
  | "completionDebug.clear"
  | "completionDebug.allSessions"
  | "completionDebug.noEvents"
  | "completionDebug.status.pending"
  | "completionDebug.status.success"
  | "completionDebug.status.error"
  | "completionDebug.expand"
  | "completionDebug.collapse"
  | "completionDebug.request"
  | "completionDebug.response"
  | "completionDebug.result"
  | "completionDebug.emptyResult"
  | "completionDebug.error"
  | "completionDebug.metricsTitle"
  | "completionDebug.metricsShown"
  | "completionDebug.metricsAccepted"
  | "completionDebug.metricsZeroEdit"
  | "completionDebug.metricsErrors"
  | "completionDebug.clearMetrics"
  | "files.title"
  | "files.noSession"
  | "files.availableAfterSession"
  | "files.parentDirectory"
  | "files.openInExplorer"
  | "files.directoryPath"
  | "files.outsideWorkingDirectory"
  | "files.searchPlaceholder"
  | "files.clearSearch"
  | "files.onlyLocalFiles"
  | "files.cannotResolveLocalPaths"
  | "files.uploading"
  | "files.preparingDownload"
  | "files.loading"
  | "files.emptyDirectory"
  | "files.noMatches"
  | "files.folder"
  | "files.addToTerminal"
  | "files.searchProject"
  | "files.searchFilesHere"
  | "files.searchTextHere"
  | "files.unsavedMarker"
  | "files.reloadFile"
  | "files.saveFile"
  | "files.closePreview"
  | "files.loadingPreview"
  | "files.conflict"
  | "files.searchPreview"
  | "files.previousMatch"
  | "files.nextMatch"
  | "files.clearPreviewSearch"
  | "files.editContent"
  | "files.deleteEntry"
  | "files.tooLarge"
  | "files.binary"
  | "system.loading"
  | "system.unavailable"
  | "system.metrics"
  | "system.networkTitle"
  | "system.diskTitle"
  | "system.diskMissing"
  | "system.diskLabel"
  | "system.diskRemaining"
  | "system.memoryTitle"
  | "picker.libraryTitle"
  | "picker.restoreTitle"
  | "picker.importCanceled"
  | "picker.imported"
  | "picker.importFailed"
  | "picker.exportCanceled"
  | "picker.exported"
  | "picker.exportFailed"
  | "picker.empty"
  | "picker.searchPlaceholder"
  | "picker.tagFilter"
  | "picker.noMatches"
  | "picker.runningCount"
  | "picker.deleteFromLibrary"
  | "picker.duplicateSession"
  | "picker.editSession"
  | "picker.confirmDelete"
  | "picker.startFresh"
  | "picker.launchSelected"
  | "picker.launching"
  | "picker.launchFailed"
  | "hooks.title"
  | "hooks.localProjectDirectory"
  | "hooks.remoteProjectDirectory"
  | "hooks.chooseWindowsPlaceholder"
  | "hooks.sshNote"
  | "hooks.notInstalled"
  | "hooks.installed"
  | "hooks.needsRepair"
  | "hooks.pendingCheck"
  | "hooks.codexTrustNote"
  | "hooks.installing"
  | "hooks.installOrRepair"
  | "hooks.install"
  | "hooks.repair"
  | "projectSearch.filesTitle"
  | "projectSearch.textTitle"
  | "projectSearch.filesPlaceholder"
  | "projectSearch.textPlaceholder"
  | "projectSearch.close"
  | "projectSearch.results"
  | "projectSearch.idleFiles"
  | "projectSearch.idleText"
  | "projectSearch.searching"
  | "projectSearch.noFiles"
  | "projectSearch.noText"
  | "projectSearch.fallbackEngine"
  | "projectSearch.mode"
  | "projectSearch.filesMode"
  | "projectSearch.textMode"
  | "projectSearch.directory"
  | "projectSearch.directoryPlaceholder"
  | "projectSearch.go"
  | "projectSearch.parentDirectory"
  | "projectSearch.loadingDirectories"
  | "git.noSession"
  | "git.availableAfterSession"
  | "git.refreshStatus"
  | "git.directory"
  | "git.directoryPlaceholder"
  | "git.changeDirectory"
  | "git.checkoutBranch"
  | "git.remoteBranch"
  | "git.stash"
  | "git.stashes"
  | "git.operationRunning"
  | "git.dismiss"
  | "git.loadingStatus"
  | "git.clean"
  | "git.notLoaded"
  | "git.openDiff"
  | "git.discardChanges"
  | "git.discardConfirm"
  | "git.closeDiff"
  | "git.searchDiff"
  | "git.searchDiffPlaceholder"
  | "git.diffSearchSide"
  | "git.all"
  | "git.head"
  | "git.workingTree"
  | "git.clearDiffSearch"
  | "git.loadingDiff"
  | "git.binaryDiff"
  | "git.noTextChanges"
  | "git.diffFor"
  | "git.closeStashes"
  | "git.noStashes"
  | "git.apply"
  | "git.pop"
  | "theme.darkSlate"
  | "theme.darkBlue"
  | "theme.darkGreen"
  | "theme.light";

export const LOCALE_OPTIONS: Array<{ id: Locale; labelKey: TranslationKey }> = [
  { id: "zh-CN", labelKey: "language.zhCN" },
  { id: "en-US", labelKey: "language.enUS" }
];

export const VALID_LOCALES = new Set<Locale>(LOCALE_OPTIONS.map((locale) => locale.id));

export const translations: Record<Locale, Record<TranslationKey, string>> = {
  "zh-CN": {
    "app.noActiveSession": "无活动会话",
    "settings.title": "设置",
    "settings.open": "打开设置",
    "settings.autoRestore": "启动时自动恢复",
    "settings.debugMode": "Debug 模式",
    "settings.theme": "主题",
    "settings.language": "语言",
    "settings.close": "关闭",
    "settings.dingTalkTitle": "钉钉机器人通知",
    "settings.dingTalkDescription": "仅推送等待授权、等待输入和执行失败状态。消息固定包含 Pannel Handle 关键词。",
    "settings.dingTalkEnabled": "启用钉钉通知",
    "settings.dingTalkWebhook": "机器人 Webhook",
    "settings.dingTalkSecret": "加签密钥",
    "settings.dingTalkSecretOptional": "可选，仅加签机器人需要",
    "settings.dingTalkConfigured": "已安全保存；留空表示保持不变",
    "settings.dingTalkTest": "发送测试消息",
    "settings.dingTalkClear": "清除凭据",
    "settings.dingTalkSaved": "钉钉配置已保存。",
    "settings.dingTalkCleared": "钉钉机器人凭据已清除。",
    "settings.dingTalkTestSuccess": "测试消息发送成功。",
    "settings.completionTitle": "智能输入补全",
    "settings.completionDescription": "停止输入后，根据 terminal-composer 中的当前草稿生成建议；按 Tab 接受。",
    "settings.completionEnabled": "启用智能补全",
    "settings.completionBaseUrl": "OpenAI 兼容 Base URL",
    "settings.completionModel": "模型名称",
    "settings.completionApiKey": "API Key",
    "settings.completionApiKeyPlaceholder": "例如 sk-...",
    "settings.completionConfigured": "已安全保存；留空表示保持不变",
    "settings.completionTest": "测试连接",
    "settings.completionClear": "清除 API Key",
    "settings.completionSaved": "智能补全配置已保存。",
    "settings.completionCleared": "智能补全 API Key 已清除。",
    "settings.completionTestSuccess": "模型连接测试成功。",
    "settings.completionThinkingEnabled": "启用深度思考",
    "settings.completionThinkingLevel": "思考强度",
    "settings.completionThinkingLevelHigh": "高（平衡速度与深度）",
    "settings.completionThinkingLevelMax": "最大（深入推理，适合复杂问题）",
    "language.zhCN": "中文",
    "language.enUS": "English",
    "common.cancel": "取消",
    "common.close": "关闭",
    "common.save": "保存",
    "common.confirm": "确认",
    "common.delete": "删除",
    "common.clear": "清除",
    "common.retry": "重试",
    "common.refresh": "刷新",
    "common.search": "搜索",
    "common.searchOptions": "搜索选项...",
    "common.noMatchingOptions": "没有匹配的选项",
    "common.loading": "加载中...",
    "common.none": "无",
    "common.select": "选择",
    "common.import": "导入",
    "common.importing": "导入中...",
    "common.export": "导出",
    "common.exporting": "导出中...",
    "common.download": "下载",
    "common.uploadFile": "上传文件",
    "common.reload": "重新加载",
    "common.saved": "已保存",
    "common.saving": "保存中...",
    "common.unsavedChanges": "未保存更改",
    "confirm.discardUnsavedFileChanges": "放弃未保存的文件更改？",
    "confirm.deleteEntry": "确定要删除 \"{name}\" 吗？此操作无法撤销。",
    "window.minimize": "最小化",
    "window.maximize": "最大化",
    "window.restore": "还原",
    "window.close": "关闭",
    "sidebar.title": "命令会话",
    "sidebar.count": "{count} 个窗口",
    "sidebar.countFiltered": "{count} 个窗口 / 显示 {filtered} 个",
    "sidebar.openLibrary": "从库中启动",
    "sidebar.newSession": "新建会话",
    "sidebar.searchPlaceholder": "搜索会话...",
    "sidebar.clearSearch": "清除搜索",
    "sidebar.empty": "没有匹配的会话",
    "sidebar.installHooks": "安装项目 Hook",
    "sidebar.editSession": "编辑会话",
    "sidebar.closeSession": "关闭",
    "sidebar.confirmClose": "再次点击确认关闭",
    "session.newTitle": "新建会话",
    "session.editTitle": "编辑会话",
    "session.name": "会话名称",
    "session.namePlaceholder": "输入会话名称",
    "session.tags": "标签",
    "session.host": "主机",
    "session.hostPlaceholder": "example.com 或 192.168.1.10",
    "session.port": "端口",
    "session.username": "用户名",
    "session.passwordOrKeyPassphrase": "密码或密钥口令",
    "session.passwordCreatePlaceholder": "加密保存，用于自动登录",
    "session.passwordEditPlaceholder": "已保存密码，留空保持不变",
    "session.clearSavedPassword": "清除已保存密码",
    "session.advancedSsh": "高级选项",
    "session.identityFile": "密钥路径",
    "session.cwd": "工作目录",
    "session.initialCommand": "初始命令",
    "session.initialCommandPlaceholder": "输入初始命令（可选），如：{example}",
    "session.agentCli": "Agent CLI",
    "session.normalTerminal": "普通终端",
    "session.agentCwdRequired": "选择 Agent CLI 时必须填写项目工作目录。",
    "session.preLaunchCommand": "CLI 启动前命令",
    "session.saving": "保存中...",
    "session.updateFailed": "保存会话失败",
    "session.sshArgs": "额外 SSH 参数",
    "session.remark": "备注",
    "session.remarkPlaceholder": "备注信息（可选）",
    "session.create": "创建",
    "session.creating": "创建中...",
    "session.createFailed": "创建会话失败",
    "quickCommand.placeholder": "快捷命令...",
    "quickCommand.heading": "快捷命令",
    "quickCommand.commandPlaceholder": "命令内容",
    "quickCommand.write": "手动写入",
    "quickCommand.autoEnter": "自动执行",
    "quickCommand.oneTime": "一次性",
    "quickCommand.add": "添加命令",
    "tag.remove": "删除标签 {tag}",
    "tag.placeholderEmpty": "输入标签，按 Enter 添加",
    "tag.placeholderAdd": "添加标签",
    "agent.waitingForPermission": "{agent} 等待确认",
    "agent.waitingForPermissionTool": "{agent} 等待确认: {tool}",
    "agent.idlePrompt": "{agent} 空闲中",
    "agent.completed": "{agent} 已完成",
    "agent.failed": "{agent} 失败",
    "agent.running": "{agent} 运行中",
    "agent.ended": "{agent} 已结束",
    "agent.exited": "进程已退出",
    "terminal.exited": "[进程已退出，退出码 {exitCode}]",
    "terminal.imagePasteFailed": "[图片粘贴失败: {message}]",
    "composer.inputLabel": "终端输入",
    "composer.placeholder": "输入内容，使用 @ 引用工作区文件...",
    "composer.send": "发送到终端",
    "composer.pasteImage": "上传剪贴板图片",
    "composer.searchWorkspace": "工作区文件与文件夹",
    "composer.noMatches": "没有匹配的文件或文件夹",
    "composer.searchFailed": "搜索失败：{message}",
    "composer.uploadingImage": "正在上传剪贴板图片...",
    "composer.noClipboardImage": "剪贴板中没有图片",
    "composer.imageUploadFailed": "图片上传失败：{message}",
    "composer.suggesting": "正在生成补全建议...",
    "composer.completionFailed": "智能补全失败：{message}",
    "tabs.files": "文件",
    "tabs.git": "Git",
    "tabs.debug": "Debug",
    "tabs.completionDebug": "补全 Debug",
    "debug.eventsCount": "{count} 个 hook 事件",
    "debug.clearEvents": "清除事件",
    "debug.providerFilter": "Provider 过滤",
    "debug.allInstances": "全部实例",
    "debug.noMatchedSession": "无匹配会话",
    "debug.noEvents": "暂无 hook 事件",
    "debug.handled": "已处理",
    "debug.unhandled": "未处理",
    "completionDebug.eventsCount": "{count} 个补全请求",
    "completionDebug.clear": "清除补全调试记录",
    "completionDebug.allSessions": "全部会话",
    "completionDebug.noEvents": "暂无补全请求",
    "completionDebug.status.pending": "进行中",
    "completionDebug.status.success": "成功",
    "completionDebug.status.error": "失败",
    "completionDebug.expand": "展开",
    "completionDebug.collapse": "收起",
    "completionDebug.request": "模型请求",
    "completionDebug.response": "原始响应",
    "completionDebug.result": "提取结果",
    "completionDebug.emptyResult": "（空字符串）",
    "completionDebug.error": "错误",
    "completionDebug.metricsTitle": "本地效果指标",
    "completionDebug.metricsShown": "展示 {count}",
    "completionDebug.metricsAccepted": "接受率 {rate}",
    "completionDebug.metricsZeroEdit": "零修改提交 {rate}",
    "completionDebug.metricsErrors": "错误 {count}",
    "completionDebug.clearMetrics": "清除补全效果指标",
    "files.title": "文件",
    "files.noSession": "未选择会话",
    "files.availableAfterSession": "选择会话后可浏览文件。",
    "files.parentDirectory": "上级目录",
    "files.openInExplorer": "在资源管理器中打开",
    "files.directoryPath": "目录路径",
    "files.outsideWorkingDirectory": "只能访问当前会话工作目录及其子目录。",
    "files.searchPlaceholder": "搜索当前目录...",
    "files.clearSearch": "清除搜索",
    "files.onlyLocalFiles": "只能上传本地文件。",
    "files.cannotResolveLocalPaths": "无法识别拖放的文件来源，仅支持从文件资源管理器拖入本地文件。",
    "files.uploading": "正在上传 {count} 个文件...",
    "files.preparingDownload": "正在准备下载...",
    "files.loading": "正在加载文件...",
    "files.emptyDirectory": "目录为空",
    "files.noMatches": "当前目录没有匹配的文件。",
    "files.folder": "文件夹",
    "files.addToTerminal": "添加到终端",
    "files.searchProject": "搜索当前目录",
    "files.searchFilesHere": "在此搜索文件名",
    "files.searchTextHere": "在此搜索内容",
    "files.unsavedMarker": "未保存更改",
    "files.reloadFile": "重新加载文件",
    "files.saveFile": "保存文件",
    "files.closePreview": "关闭预览",
    "files.loadingPreview": "正在加载预览...",
    "files.conflict": "文件在打开后发生变化，请重新加载后再编辑。",
    "files.searchPreview": "搜索预览内容",
    "files.previousMatch": "上一个匹配",
    "files.nextMatch": "下一个匹配",
    "files.clearPreviewSearch": "清除预览搜索",
    "files.editContent": "编辑文件内容",
    "files.deleteEntry": "删除",
    "files.tooLarge": "文件大小为 {size}。请下载后在本地查看。",
    "files.binary": "二进制文件。请下载后在本地查看。",
    "system.loading": "正在读取服务器状态...",
    "system.unavailable": "服务器监控不可用",
    "system.metrics": "SSH 服务器指标",
    "system.networkTitle": "网络：下载 {download}，上传 {upload}",
    "system.diskTitle": "磁盘 {mountPoint}：已用 {usedPercent}%，剩余 {available}",
    "system.diskMissing": "未找到磁盘指标",
    "system.diskLabel": "磁盘 --",
    "system.diskRemaining": "余 {available}",
    "system.memoryTitle": "内存：已用 {used} / {total}，{percent}",
    "picker.libraryTitle": "会话库",
    "picker.restoreTitle": "恢复会话",
    "picker.importCanceled": "已取消导入",
    "picker.imported": "已导入 {count} 个会话",
    "picker.importFailed": "导入失败：{error}",
    "picker.exportCanceled": "已取消导出",
    "picker.exported": "已导出 {count} 个会话：{path}",
    "picker.exportFailed": "导出失败：{error}",
    "picker.empty": "没有已保存的会话",
    "picker.searchPlaceholder": "搜索会话或标签...",
    "picker.tagFilter": "标签筛选",
    "picker.noMatches": "没有匹配的会话",
    "picker.runningCount": "运行中 {count}",
    "picker.deleteFromLibrary": "从库中删除",
    "picker.duplicateSession": "复制会话",
    "picker.editSession": "编辑会话",
    "picker.confirmDelete": "再次点击确认删除",
    "picker.startFresh": "重新开始",
    "picker.launchSelected": "启动所选 ({count})",
    "picker.launching": "启动中...",
    "picker.launchFailed": "启动会话失败",
    "hooks.title": "安装项目 Hook",
    "hooks.localProjectDirectory": "项目目录",
    "hooks.remoteProjectDirectory": "远程项目目录",
    "hooks.chooseWindowsPlaceholder": "选择 Windows 项目目录",
    "hooks.sshNote": "SSH Hook 会通过反向隧道监听远程事件，不需要服务器访问本机网络。",
    "hooks.notInstalled": "未安装",
    "hooks.installed": "已安装",
    "hooks.needsRepair": "需要修复",
    "hooks.pendingCheck": "待检查",
    "hooks.codexTrustNote": "Codex 首次使用项目 Hook 时，仍需在 Codex 的 /hooks 中确认信任。",
    "hooks.installing": "安装中...",
    "hooks.installOrRepair": "安装或修复",
    "hooks.install": "安装",
    "hooks.repair": "修复",
    "projectSearch.filesTitle": "搜索文件",
    "projectSearch.textTitle": "搜索文本",
    "projectSearch.filesPlaceholder": "输入文件名或路径...",
    "projectSearch.textPlaceholder": "输入要在项目中搜索的文本...",
    "projectSearch.close": "关闭搜索",
    "projectSearch.results": "{count} 个结果",
    "projectSearch.idleFiles": "开始输入以查找当前工作目录中的文件。",
    "projectSearch.idleText": "开始输入以搜索当前工作目录中的文本。",
    "projectSearch.searching": "搜索中...",
    "projectSearch.noFiles": "没有匹配的文件。",
    "projectSearch.noText": "没有文本匹配。",
    "projectSearch.fallbackEngine": "兼容搜索（WSL 未安装 ripgrep，速度较慢）",
    "projectSearch.mode": "搜索模式",
    "projectSearch.filesMode": "文件名",
    "projectSearch.textMode": "文件内容",
    "projectSearch.directory": "搜索目录",
    "projectSearch.directoryPlaceholder": "输入工作目录内的相对路径",
    "projectSearch.go": "转到",
    "projectSearch.parentDirectory": "上级目录",
    "projectSearch.loadingDirectories": "正在加载目录...",
    "git.noSession": "未选择会话",
    "git.availableAfterSession": "选择会话后可查看 Git 状态。",
    "git.refreshStatus": "刷新 Git 状态",
    "git.directory": "Git 工作目录",
    "git.directoryPlaceholder": "输入 Git 仓库绝对路径",
    "git.changeDirectory": "切换 Git 工作目录",
    "git.checkoutBranch": "切换分支",
    "git.remoteBranch": "（远程）",
    "git.stash": "储藏",
    "git.stashes": "储藏 ({count})",
    "git.operationRunning": "{label}...",
    "git.dismiss": "关闭",
    "git.loadingStatus": "正在加载 Git 状态...",
    "git.clean": "工作目录干净。",
    "git.notLoaded": "Git 状态尚未加载。",
    "git.openDiff": "打开差异：{file}",
    "git.discardChanges": "放弃更改：{file}",
    "git.discardConfirm": "放弃对 {file} 的更改？",
    "git.closeDiff": "关闭差异",
    "git.searchDiff": "搜索差异",
    "git.searchDiffPlaceholder": "搜索差异...",
    "git.diffSearchSide": "差异搜索范围",
    "git.all": "全部",
    "git.head": "HEAD",
    "git.workingTree": "工作区",
    "git.clearDiffSearch": "清除差异搜索",
    "git.loadingDiff": "正在加载差异...",
    "git.binaryDiff": "二进制文件，无法预览差异。",
    "git.noTextChanges": "没有可显示的文本更改。",
    "git.diffFor": "{file} 的差异",
    "git.closeStashes": "关闭储藏列表",
    "git.noStashes": "没有储藏。",
    "git.apply": "应用",
    "git.pop": "弹出",
    "theme.darkSlate": "深色石板",
    "theme.darkBlue": "深蓝色",
    "theme.darkGreen": "深绿色",
    "theme.light": "浅色"
  },
  "en-US": {
    "app.noActiveSession": "No active session",
    "settings.title": "Settings",
    "settings.open": "Open settings",
    "settings.autoRestore": "Auto restore on startup",
    "settings.debugMode": "Debug mode",
    "settings.theme": "Theme",
    "settings.language": "Language",
    "settings.close": "Close",
    "settings.dingTalkTitle": "DingTalk Robot Notifications",
    "settings.dingTalkDescription": "Only permission, input, and failure states are sent. Messages always include the Pannel Handle keyword.",
    "settings.dingTalkEnabled": "Enable DingTalk notifications",
    "settings.dingTalkWebhook": "Robot webhook",
    "settings.dingTalkSecret": "Signing secret",
    "settings.dingTalkSecretOptional": "Optional; required only when signing is enabled",
    "settings.dingTalkConfigured": "Stored securely; leave blank to keep unchanged",
    "settings.dingTalkTest": "Send test message",
    "settings.dingTalkClear": "Clear credentials",
    "settings.dingTalkSaved": "DingTalk configuration saved.",
    "settings.dingTalkCleared": "DingTalk robot credentials cleared.",
    "settings.dingTalkTestSuccess": "Test message sent successfully.",
    "settings.completionTitle": "AI Input Completion",
    "settings.completionDescription": "After you pause typing, suggest text from the current terminal-composer draft; press Tab to accept.",
    "settings.completionEnabled": "Enable AI completion",
    "settings.completionBaseUrl": "OpenAI-compatible Base URL",
    "settings.completionModel": "Model name",
    "settings.completionApiKey": "API Key",
    "settings.completionApiKeyPlaceholder": "For example, sk-...",
    "settings.completionConfigured": "Stored securely; leave blank to keep unchanged",
    "settings.completionTest": "Test connection",
    "settings.completionClear": "Clear API Key",
    "settings.completionSaved": "AI completion settings saved.",
    "settings.completionCleared": "AI completion API Key cleared.",
    "settings.completionTestSuccess": "Model connection test succeeded.",
    "settings.completionThinkingEnabled": "Enable thinking mode",
    "settings.completionThinkingLevel": "Thinking intensity",
    "settings.completionThinkingLevelHigh": "High (balanced speed & depth)",
    "settings.completionThinkingLevelMax": "Maximum (deepest reasoning)",
    "language.zhCN": "中文",
    "language.enUS": "English",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.save": "Save",
    "common.confirm": "Confirm",
    "common.delete": "Delete",
    "common.clear": "Clear",
    "common.retry": "Retry",
    "common.refresh": "Refresh",
    "common.search": "Search",
    "common.searchOptions": "Search options...",
    "common.noMatchingOptions": "No matching options",
    "common.loading": "Loading...",
    "common.none": "None",
    "common.select": "Select",
    "common.import": "Import",
    "common.importing": "Importing...",
    "common.export": "Export",
    "common.exporting": "Exporting...",
    "common.download": "Download",
    "common.uploadFile": "Upload file",
    "common.reload": "Reload",
    "common.saved": "Saved",
    "common.saving": "Saving...",
    "common.unsavedChanges": "Unsaved changes",
    "confirm.discardUnsavedFileChanges": "Discard unsaved file changes?",
    "confirm.deleteEntry": "Are you sure you want to delete \"{name}\"? This cannot be undone.",
    "window.minimize": "Minimize",
    "window.maximize": "Maximize",
    "window.restore": "Restore",
    "window.close": "Close",
    "sidebar.title": "Command Sessions",
    "sidebar.count": "{count} windows",
    "sidebar.countFiltered": "{count} windows / showing {filtered}",
    "sidebar.openLibrary": "Launch from library",
    "sidebar.newSession": "New session",
    "sidebar.searchPlaceholder": "Search sessions...",
    "sidebar.clearSearch": "Clear search",
    "sidebar.empty": "No matching sessions",
    "sidebar.installHooks": "Install project hooks",
    "sidebar.editSession": "Edit session",
    "sidebar.closeSession": "Close",
    "sidebar.confirmClose": "Click again to confirm close",
    "session.newTitle": "New Session",
    "session.editTitle": "Edit Session",
    "session.name": "Session name",
    "session.namePlaceholder": "Enter session name",
    "session.tags": "Tags",
    "session.host": "Host",
    "session.hostPlaceholder": "example.com or 192.168.1.10",
    "session.port": "Port",
    "session.username": "Username",
    "session.passwordOrKeyPassphrase": "Password or key passphrase",
    "session.passwordCreatePlaceholder": "Encrypted and saved for automatic login",
    "session.passwordEditPlaceholder": "Saved password exists; leave blank to keep it",
    "session.clearSavedPassword": "Clear saved password",
    "session.advancedSsh": "Advanced Settings",
    "session.identityFile": "Identity file",
    "session.cwd": "Working directory",
    "session.initialCommand": "Initial command",
    "session.initialCommandPlaceholder": "Enter an optional initial command, for example: {example}",
    "session.agentCli": "Agent CLI",
    "session.normalTerminal": "Terminal",
    "session.agentCwdRequired": "A project working directory is required when an Agent CLI is selected.",
    "session.preLaunchCommand": "Command before CLI startup",
    "session.saving": "Saving...",
    "session.updateFailed": "Failed to save session",
    "session.sshArgs": "Extra SSH arguments",
    "session.remark": "Remark",
    "session.remarkPlaceholder": "Optional remark",
    "session.create": "Create",
    "session.creating": "Creating...",
    "session.createFailed": "Failed to create session",
    "quickCommand.placeholder": "Quick command...",
    "quickCommand.heading": "Quick Commands",
    "quickCommand.commandPlaceholder": "Command",
    "quickCommand.write": "Write manually",
    "quickCommand.autoEnter": "Run automatically",
    "quickCommand.oneTime": "One time",
    "quickCommand.add": "Add command",
    "tag.remove": "Remove tag {tag}",
    "tag.placeholderEmpty": "Enter a tag, press Enter to add",
    "tag.placeholderAdd": "Add tag",
    "agent.waitingForPermission": "{agent} waiting for confirmation",
    "agent.waitingForPermissionTool": "{agent} waiting for confirmation: {tool}",
    "agent.idlePrompt": "{agent} idle",
    "agent.completed": "{agent} completed",
    "agent.failed": "{agent} failed",
    "agent.running": "{agent} running",
    "agent.ended": "{agent} ended",
    "agent.exited": "Process exited",
    "terminal.exited": "[Process exited with code {exitCode}]",
    "terminal.imagePasteFailed": "[Image paste failed: {message}]",
    "composer.inputLabel": "Terminal input",
    "composer.placeholder": "Type a message, use @ to reference workspace files...",
    "composer.send": "Send to terminal",
    "composer.pasteImage": "Upload clipboard image",
    "composer.searchWorkspace": "Workspace files and folders",
    "composer.noMatches": "No matching files or folders",
    "composer.searchFailed": "Search failed: {message}",
    "composer.uploadingImage": "Uploading clipboard image...",
    "composer.noClipboardImage": "No image found in the clipboard",
    "composer.imageUploadFailed": "Image upload failed: {message}",
    "composer.suggesting": "Generating a completion...",
    "composer.completionFailed": "AI completion failed: {message}",
    "tabs.files": "Files",
    "tabs.git": "Git",
    "tabs.debug": "Debug",
    "tabs.completionDebug": "Completion Debug",
    "debug.eventsCount": "{count} hook events",
    "debug.clearEvents": "Clear events",
    "debug.providerFilter": "Provider filter",
    "debug.allInstances": "All instances",
    "debug.noMatchedSession": "No matched session",
    "debug.noEvents": "No hook events yet",
    "debug.handled": "handled",
    "debug.unhandled": "unhandled",
    "completionDebug.eventsCount": "{count} completion requests",
    "completionDebug.clear": "Clear completion debug entries",
    "completionDebug.allSessions": "All sessions",
    "completionDebug.noEvents": "No completion requests yet",
    "completionDebug.status.pending": "pending",
    "completionDebug.status.success": "success",
    "completionDebug.status.error": "failed",
    "completionDebug.expand": "Expand",
    "completionDebug.collapse": "Collapse",
    "completionDebug.request": "Model request",
    "completionDebug.response": "Raw response",
    "completionDebug.result": "Extracted result",
    "completionDebug.emptyResult": "(empty string)",
    "completionDebug.error": "Error",
    "completionDebug.metricsTitle": "Local effectiveness metrics",
    "completionDebug.metricsShown": "Shown {count}",
    "completionDebug.metricsAccepted": "Acceptance {rate}",
    "completionDebug.metricsZeroEdit": "Zero-edit submits {rate}",
    "completionDebug.metricsErrors": "Errors {count}",
    "completionDebug.clearMetrics": "Clear completion metrics",
    "files.title": "Files",
    "files.noSession": "No session selected",
    "files.availableAfterSession": "Files are available after selecting a session.",
    "files.parentDirectory": "Parent directory",
    "files.openInExplorer": "Open in Explorer",
    "files.directoryPath": "Directory path",
    "files.outsideWorkingDirectory": "Only the current session working directory and its subdirectories can be accessed.",
    "files.searchPlaceholder": "Search current directory...",
    "files.clearSearch": "Clear search",
    "files.onlyLocalFiles": "Only local files can be uploaded.",
    "files.cannotResolveLocalPaths": "Cannot recognize the dropped items. Only files dragged from the file explorer are supported.",
    "files.uploading": "Uploading {count} files...",
    "files.preparingDownload": "Preparing download...",
    "files.loading": "Loading files...",
    "files.emptyDirectory": "Directory is empty",
    "files.noMatches": "No matching files in this directory.",
    "files.folder": "Folder",
    "files.addToTerminal": "Add to terminal",
    "files.searchProject": "Search current directory",
    "files.searchFilesHere": "Search file names here",
    "files.searchTextHere": "Search file contents here",
    "files.unsavedMarker": "Unsaved changes",
    "files.reloadFile": "Reload file",
    "files.saveFile": "Save file",
    "files.closePreview": "Close preview",
    "files.loadingPreview": "Loading preview...",
    "files.conflict": "The file changed after it was opened. Reload it before editing again.",
    "files.searchPreview": "Search preview content",
    "files.previousMatch": "Previous match",
    "files.nextMatch": "Next match",
    "files.clearPreviewSearch": "Clear preview search",
    "files.editContent": "Edit file content",
    "files.deleteEntry": "Delete",
    "files.tooLarge": "File is {size}. Download it to view locally.",
    "files.binary": "Binary file. Download it to view locally.",
    "system.loading": "Reading server status...",
    "system.unavailable": "Server monitoring is unavailable",
    "system.metrics": "SSH server metrics",
    "system.networkTitle": "Network: down {download}, up {upload}",
    "system.diskTitle": "Disk {mountPoint}: used {usedPercent}%, remaining {available}",
    "system.diskMissing": "No disk metrics found",
    "system.diskLabel": "Disk --",
    "system.diskRemaining": "{available} left",
    "system.memoryTitle": "Memory: used {used} / {total}, {percent}",
    "picker.libraryTitle": "Session Library",
    "picker.restoreTitle": "Restore Sessions",
    "picker.importCanceled": "Import canceled",
    "picker.imported": "Imported {count} sessions",
    "picker.importFailed": "Import failed: {error}",
    "picker.exportCanceled": "Export canceled",
    "picker.exported": "Exported {count} sessions: {path}",
    "picker.exportFailed": "Export failed: {error}",
    "picker.empty": "No saved sessions",
    "picker.searchPlaceholder": "Search sessions or tags...",
    "picker.tagFilter": "Tag filter",
    "picker.noMatches": "No matching sessions",
    "picker.runningCount": "Running {count}",
    "picker.deleteFromLibrary": "Delete from library",
    "picker.duplicateSession": "Duplicate session",
    "picker.editSession": "Edit session",
    "picker.confirmDelete": "Click again to confirm delete",
    "picker.startFresh": "Start fresh",
    "picker.launchSelected": "Launch selected ({count})",
    "picker.launching": "Launching...",
    "picker.launchFailed": "Failed to launch session",
    "hooks.title": "Install Project Hooks",
    "hooks.localProjectDirectory": "Project directory",
    "hooks.remoteProjectDirectory": "Remote project directory",
    "hooks.chooseWindowsPlaceholder": "Choose a Windows project directory",
    "hooks.sshNote": "SSH hooks listen for remote events through a reverse tunnel, so the server does not need network access to this machine.",
    "hooks.notInstalled": "Not installed",
    "hooks.installed": "Installed",
    "hooks.needsRepair": "Needs repair",
    "hooks.pendingCheck": "Pending check",
    "hooks.codexTrustNote": "When Codex uses project hooks for the first time, you still need to trust them in Codex /hooks.",
    "hooks.installing": "Installing...",
    "hooks.installOrRepair": "Install or repair",
    "hooks.install": "Install",
    "hooks.repair": "Repair",
    "projectSearch.filesTitle": "Search Files",
    "projectSearch.textTitle": "Search Text",
    "projectSearch.filesPlaceholder": "Type a file name or path...",
    "projectSearch.textPlaceholder": "Type text to search in project...",
    "projectSearch.close": "Close search",
    "projectSearch.results": "{count} results",
    "projectSearch.idleFiles": "Start typing to find files in this working directory.",
    "projectSearch.idleText": "Start typing to search text in this working directory.",
    "projectSearch.searching": "Searching...",
    "projectSearch.noFiles": "No matching files.",
    "projectSearch.noText": "No text matches.",
    "projectSearch.fallbackEngine": "Compatibility search (ripgrep is not installed in WSL and may be slower)",
    "projectSearch.mode": "Search mode",
    "projectSearch.filesMode": "File names",
    "projectSearch.textMode": "File contents",
    "projectSearch.directory": "Search directory",
    "projectSearch.directoryPlaceholder": "Enter a path inside the working directory",
    "projectSearch.go": "Go",
    "projectSearch.parentDirectory": "Parent directory",
    "projectSearch.loadingDirectories": "Loading directories...",
    "git.noSession": "No session selected",
    "git.availableAfterSession": "Git status is available after selecting a session.",
    "git.refreshStatus": "Refresh Git status",
    "git.directory": "Git working directory",
    "git.directoryPlaceholder": "Enter an absolute Git repository path",
    "git.changeDirectory": "Change Git working directory",
    "git.checkoutBranch": "Checkout branch",
    "git.remoteBranch": " (remote)",
    "git.stash": "Stash",
    "git.stashes": "Stashes ({count})",
    "git.operationRunning": "{label}...",
    "git.dismiss": "Dismiss",
    "git.loadingStatus": "Loading Git status...",
    "git.clean": "Working directory is clean.",
    "git.notLoaded": "Git status has not been loaded.",
    "git.openDiff": "Open diff: {file}",
    "git.discardChanges": "Discard changes: {file}",
    "git.discardConfirm": "Discard changes to {file}?",
    "git.closeDiff": "Close diff",
    "git.searchDiff": "Search diff",
    "git.searchDiffPlaceholder": "Search diff...",
    "git.diffSearchSide": "Diff search side",
    "git.all": "All",
    "git.head": "HEAD",
    "git.workingTree": "Working tree",
    "git.clearDiffSearch": "Clear diff search",
    "git.loadingDiff": "Loading diff...",
    "git.binaryDiff": "Binary file. Diff preview is not available.",
    "git.noTextChanges": "No textual changes to display.",
    "git.diffFor": "Diff for {file}",
    "git.closeStashes": "Close stash list",
    "git.noStashes": "No stashes found.",
    "git.apply": "Apply",
    "git.pop": "Pop",
    "theme.darkSlate": "Dark slate",
    "theme.darkBlue": "Dark blue",
    "theme.darkGreen": "Dark green",
    "theme.light": "Light"
  }
};

export function normalizeLocale(locale: unknown): Locale {
  return typeof locale === "string" && VALID_LOCALES.has(locale as Locale)
    ? locale as Locale
    : DEFAULT_LOCALE;
}
