export type Locale = "zh-CN" | "en-US";

export const DEFAULT_LOCALE: Locale = "zh-CN";

export type TranslationParams = Record<string, string | number>;

export type TranslationKey =
  | "agentCapabilities.pannelHandleRemote"
  | "app.noActiveSession"
  | "app.openTerminal"
  | "projectAssistant.title"
  | "projectAssistant.open"
  | "projectAssistant.newConversation"
  | "projectAssistant.description"
  | "projectAssistant.empty"
  | "projectAssistant.you"
  | "projectAssistant.application"
  | "projectAssistant.thinking"
  | "projectAssistant.confirm"
  | "projectAssistant.reject"
  | "projectAssistant.execute"
  | "projectAssistant.placeholder"
  | "projectAssistant.stop"
  | "projectAssistant.send"
  | "projectAssistant.codexSessions"
  | "projectAssistant.selectCodexSession"
  | "projectAssistant.noCodexSessions"
  | "projectAssistant.switchMode"
  | "projectAssistant.questionHint"
  | "projectAssistant.codexPlaceholder"
  | "projectAssistant.sendToCodex"
  | "codexVersion.title"
  | "codexVersion.checking"
  | "codexVersion.current"
  | "codexVersion.latest"
  | "codexVersion.unknown"
  | "codexVersion.upToDate"
  | "codexVersion.restart"
  | "codexVersion.manual"
  | "codexVersion.check"
  | "codexVersion.update"
  | "codexVersion.confirmTitle"
  | "codexVersion.confirm"
  | "codexVersion.cancel"
  | "codexVersion.confirmUpdate"
  | "codexVersion.updating"
  | "codexVersion.progress.checking"
  | "codexVersion.progress.installing"
  | "codexVersion.progress.verifying"
  | "codexVersion.progress.complete"
  | "codexVersion.progress.failed"
  | "codexVersion.progress.output"
  | "codeBuddyVersion.title"
  | "codeBuddyVersion.update"
  | "codeBuddyVersion.confirmTitle"
  | "codeBuddyVersion.confirm"
  | "codeBuddyVersion.updating"
  | "projectAssistant.statusUnknown"
  | "sessionOverview.title"
  | "sessionOverview.openOverview"
  | "sessionOverview.description"
  | "sessionOverview.empty"
  | "sessionOverview.emptyHint"
  | "sessionOverview.selectSession"
  | "sessionOverview.open"
  | "sessionOverview.connecting"
  | "sessionOverview.connected"
  | "sessionOverview.reconnecting"
  | "sessionOverview.disconnected"
  | "sessionOverview.noAgent"
  | "sessionOverview.noAgentStatus"
  | "sessionOverview.summary"
  | "sessionOverview.noSummary"
  | "settings.title"
  | "settings.subtitle"
  | "settings.categories"
  | "settings.generalDescription"
  | "settings.environmentTitle"
  | "settings.environmentNavDescription"
  | "settings.modelsTitle"
  | "settings.modelsDescription"
  | "settings.mobileNavDescription"
  | "settings.notificationsTitle"
  | "settings.notificationsDescription"
  | "settings.environmentProfiles"
  | "settings.environmentProfileCount"
  | "settings.environmentNewProfile"
  | "settings.environmentNewProfileHint"
  | "settings.environmentVariableCount"
  | "settings.environmentReferenceCount"
  | "settings.environmentDescription"
  | "settings.environmentUnsaved"
  | "settings.environmentProfileName"
  | "settings.environmentProfileNamePlaceholder"
  | "settings.environmentVariables"
  | "settings.environmentAddVariable"
  | "settings.environmentVariableName"
  | "settings.environmentVariableValue"
  | "settings.environmentRemoveVariable"
  | "settings.environmentEmpty"
  | "settings.environmentAddFirstVariable"
  | "settings.environmentPasteTitle"
  | "settings.environmentPasteHint"
  | "settings.environmentPasteAria"
  | "settings.environmentAppend"
  | "settings.environmentPasteError"
  | "settings.environmentReferencedBy"
  | "settings.environmentReferenceSeparator"
  | "settings.environmentDeleteReferencedHint"
  | "settings.environmentSave"
  | "settings.environmentCopy"
  | "settings.environmentDelete"
  | "settings.environmentConfirmDelete"
  | "settings.environmentSaved"
  | "settings.environmentDeleted"
  | "settings.environmentCopySuffix"
  | "settings.environmentUnsavedTitle"
  | "settings.environmentUnsavedDescription"
  | "settings.environmentSaveAndContinue"
  | "settings.environmentDiscardAndContinue"
  | "settings.environmentKeepEditing"
  | "settings.mobileTitle"
  | "settings.mobileRunning"
  | "settings.mobileStopped"
  | "settings.mobileHttpWarning"
  | "settings.mobileInterface"
  | "settings.mobilePort"
  | "settings.mobilePassword"
  | "settings.mobileSetPassword"
  | "settings.mobileChangePassword"
  | "settings.mobilePasswordSet"
  | "settings.mobilePasswordNeeded"
  | "settings.mobilePasswordSaved"
  | "settings.mobileOpenHint"
  | "settings.mobileActiveDevice"
  | "settings.mobileDisconnect"
  | "settings.mobileNoActiveDevice"
  | "settings.mobileAudit"
  | "settings.open"
  | "settings.generalTitle"
  | "settings.autoRestore"
  | "session.graphicalMode"
  | "session.graphicalModeHint"
  | "settings.autoWorkBuddyCheckin"
  | "settings.debugMode"
  | "settings.screenshotTitle"
  | "settings.screenshotDescription"
  | "settings.screenshotEnabled"
  | "settings.screenshotShortcut"
  | "settings.screenshotShortcutRecording"
  | "settings.screenshotShortcutHint"
  | "settings.screenshotShortcutReserved"
  | "settings.screenshotShortcutModifierRequired"
  | "settings.screenshotShortcutUnsupported"
  | "settings.terminalBackgroundTitle"
  | "settings.terminalBackgroundDescription"
  | "settings.terminalBackgroundChoose"
  | "settings.terminalBackgroundClear"
  | "settings.terminalBackgroundOpacity"
  | "settings.terminalBackgroundBlur"
  | "settings.terminalBackgroundNone"
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
  | "settings.openRouterConfigured"
  | "settings.openRouterNotConfigured"
  | "settings.openRouterDescription"
  | "settings.openRouterKeyStored"
  | "settings.openRouterSaved"
  | "settings.openRouterTest"
  | "settings.openRouterTestSuccess"
  | "settings.openRouterClear"
  | "settings.openRouterCleared"
  | "settings.openRouterRefreshModels"
  | "settings.openRouterModelsRefreshed"
  | "settings.openRouterFavorites"
  | "settings.openRouterFreeModelsOnly"
  | "settings.openRouterNoMatchingModels"
  | "settings.openRouterDefaultModel"
  | "settings.openRouterRefreshHint"
  | "settings.openRouterSaveFavorites"
  | "settings.openRouterFavoritesSaved"
  | "settings.openRouterNewSessionsHint"
  | "settings.openRouterPriceInput"
  | "settings.openRouterPriceOutput"
  | "settings.openRouterPriceUnavailable"
  | "settings.openRouterVerificationPending"
  | "settings.openRouterVerificationPassed"
  | "settings.openRouterVerificationPartial"
  | "settings.openRouterVerificationFailed"
  | "settings.openRouterVerificationUnavailable"
  | "settings.openRouterVerificationPartialSuccess"
  | "settings.openRouterVerificationPartialRateLimit"
  | "settings.openRouterResponsesRejected"
  | "settings.openRouterProviderDetail"
  | "settings.openRouterStageResponses"
  | "settings.openRouterStageFunctionTools"
  | "settings.openRouterStageCodexTools"
  | "settings.openRouterVerifyRetry"
  | "settings.openRouterVerifying"
  | "settings.openRouterVerificationSuccess"
  | "settings.openRouterRateLimitHint"
  | "settings.naraRouterDescription"
  | "settings.naraRouterSaved"
  | "settings.naraRouterTestSuccess"
  | "settings.naraRouterCleared"
  | "settings.naraRouterModelsRefreshed"
  | "settings.naraRouterFavoritesSaved"
  | "settings.naraRouterRefreshHint"
  | "settings.naraRouterVerificationSuccess"
  | "settings.naraRouterRateLimitHint"
  | "settings.miniMaxDescription"
  | "settings.miniMaxSaved"
  | "settings.miniMaxTestSuccess"
  | "settings.miniMaxCleared"
  | "settings.miniMaxModelsRefreshed"
  | "settings.miniMaxFavoritesSaved"
  | "settings.miniMaxRefreshHint"
  | "settings.miniMaxVerificationSuccess"
  | "settings.miniMaxRateLimitHint"
  | "settings.codeBuddyCodexTitle"
  | "settings.codeBuddyCodexNotConfigured"
  | "settings.codeBuddyCodexDescription"
  | "settings.codeBuddyCodexRefreshModels"
  | "settings.codeBuddyCodexModelsRefreshed"
  | "settings.codeBuddyCodexModels"
  | "settings.codeBuddyCodexVerified"
  | "settings.codeBuddyCodexVerificationPending"
  | "settings.codeBuddyCodexVerificationFailed"
  | "settings.codeBuddyCodexVerificationSuccess"
  | "settings.codeBuddyCodexVerify"
  | "settings.codeBuddyCodexVerifying"
  | "settings.codeBuddyCodexDefaultModel"
  | "settings.codeBuddyCodexRefreshHint"
  | "settings.codeBuddyCodexSaveFavorites"
  | "settings.codeBuddyCodexFavoritesSaved"
  | "settings.codeBuddyCodexAcknowledge"
  | "settings.codeBuddyCodexAcknowledgementSaved"
  | "settings.codeBuddyCodexNewSessionsHint"
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
  | "confirm.trashEntry"
  | "confirm.deleteEntries"
  | "confirm.trashEntries"
  | "window.minimize"
  | "window.maximize"
  | "window.restore"
  | "window.close"
  | "screenshot.capture"
  | "screenshot.captureFailed"
  | "sidebar.title"
  | "sidebar.count"
  | "sidebar.countFiltered"
  | "sidebar.openLibrary"
  | "sidebar.newSession"
  | "sidebar.searchPlaceholder"
  | "sidebar.clearSearch"
  | "sidebar.empty"
  | "sidebar.installHooks"
  | "sidebar.duplicateSession"
  | "sidebar.duplicatingSession"
  | "sidebar.editSession"
  | "sidebar.closeSession"
  | "sidebar.confirmClose"
  | "sidebar.sshConnecting"
  | "sidebar.sshReconnecting"
  | "sidebar.sshDisconnected"
  | "sidebar.sshReconnectNow"
  | "session.newTitle"
  | "session.editTitle"
  | "session.newSubtitle"
  | "session.editSubtitle"
  | "session.basicSection"
  | "session.connectionSection"
  | "session.startupSection"
  | "session.environment"
  | "session.environmentHint"
  | "session.environmentProfile"
  | "session.environmentProfileNone"
  | "session.environmentPreview"
  | "session.environmentVariable"
  | "session.environmentValue"
  | "session.environmentSource"
  | "session.environmentEmptyValue"
  | "session.environmentPrecedenceHint"
  | "session.environmentLocalSshHint"
  | "session.environmentRemoteSshHint"
  | "session.configured"
  | "session.notConfigured"
  | "session.itemsConfigured"
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
  | "session.remoteCwd"
  | "session.remotePlatform"
  | "session.remotePlatformAuto"
  | "session.localAgentCwd"
  | "session.localAgentCwdPlaceholder"
  | "session.localAgentCwdHint"
  | "session.initialCommand"
  | "session.initialCommandPlaceholder"
  | "session.agentCli"
  | "session.normalTerminal"
  | "session.quickAgent"
  | "session.quickAgentMenu"
  | "agentSwitch.title"
  | "agentSwitch.menu"
  | "agentSwitch.switching"
  | "agentSwitch.localSshUnavailable"
  | "codexBackendSwitch.title"
  | "codexBackendSwitch.menu"
  | "codexBackendSwitch.switching"
  | "session.agentCwdRequired"
  | "settings.defaultWindowsShell"
  | "settings.defaultWindowsShellHint"
  | "session.defaultShell"
  | "session.shellSyntaxHint"
  | "session.preLaunchCommand"
  | "session.codexBackend"
  | "session.codexBackendOpenAI"
  | "session.codexModel"
  | "session.codexModelSelect"
  | "session.openRouterKeyRequired"
  | "session.openRouterFavoriteRequired"
  | "session.openRouterModelHint"
  | "session.openRouterVerifiedRequired"
  | "session.openRouterExperimentalAcknowledge"
  | "session.openRouterExperimentalRequired"
  | "session.naraRouterModel"
  | "session.naraRouterKeyRequired"
  | "session.naraRouterFavoriteRequired"
  | "session.naraRouterModelHint"
  | "session.naraRouterVerifiedRequired"
  | "session.miniMaxModel"
  | "session.miniMaxKeyRequired"
  | "session.miniMaxFavoriteRequired"
  | "session.miniMaxModelHint"
  | "session.miniMaxVerifiedRequired"
  | "session.codeBuddyCodexModel"
  | "session.codeBuddyCodexConfigRequired"
  | "session.codeBuddyCodexModelHint"
  | "session.agentLocation"
  | "session.agentLocationLocal"
  | "session.agentLocationRemote"
  | "session.agentLocationLocalHint"
  | "session.agentLocationUnsupported"
  | "remoteAgent.auditTitle"
  | "remoteAgent.auditEphemeral"
  | "remoteAgent.auditWaiting"
  | "remoteAgent.approvalTitle"
  | "remoteAgent.approvalSource"
  | "remoteAgent.approvalRemaining"
  | "remoteAgent.approvalDeny"
  | "remoteAgent.approvalOnce"
  | "remoteAgent.approvalSession"
  | "remoteAgent.approvalFailed"
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
  | "quickCommand.more"
  | "quickCommand.dialog"
  | "quickCommand.empty"
  | "quickCommand.pin"
  | "quickCommand.unpin"
  | "quickCommand.pinLimit"
  | "tag.remove"
  | "tag.placeholderEmpty"
  | "tag.placeholderAdd"
  | "agent.waitingForPermission"
  | "agent.waitingForPermissionTool"
  | "agent.waitingForAnswer"
  | "agent.waitingForPlanConfirmation"
  | "agent.idlePrompt"
  | "agent.completed"
  | "agent.failed"
  | "agent.running"
  | "agent.ended"
  | "agent.exited"
  | "agent.openCodeEmptyResponse"
  | "usage.loading"
  | "usage.unavailable"
  | "usage.retry"
  | "usage.remaining"
  | "usage.title"
  | "usage.refresh"
  | "usage.refreshing"
  | "usage.close"
  | "usage.limitRemaining"
  | "usage.used"
  | "usage.resetsAt"
  | "usage.resetUnavailable"
  | "usage.resetCreditsTitle"
  | "usage.resetCreditsAvailable"
  | "usage.resetCreditsEmpty"
  | "usage.resetCreditFallback"
  | "usage.resetCreditGrantedAt"
  | "usage.resetCreditGrantedLabel"
  | "usage.resetCreditExpiresLabel"
  | "usage.resetCreditExpiresAt"
  | "usage.resetCreditNoExpiration"
  | "usage.resetCreditStatus.available"
  | "usage.resetCreditStatus.redeeming"
  | "usage.resetCreditStatus.redeemed"
  | "usage.resetCreditStatus.unknown"
  | "usage.resetCreditDetailsUnavailable"
  | "usage.resetCreditAction"
  | "usage.resetCreditConfirm"
  | "usage.resetCreditResetting"
  | "usage.resetCreditRetry"
  | "usage.resetCreditSuccess"
  | "usage.resetCreditAlreadyRedeemed"
  | "usage.resetCreditNothingToReset"
  | "usage.resetCreditNoCredit"
  | "usage.resetCreditFailed"
  | "usage.resetCreditRefreshFailed"
  | "usage.updatedAt"
  | "usage.codebuddyLoading"
  | "usage.codebuddyUnavailable"
  | "usage.codebuddyRetry"
  | "usage.codebuddyRemaining"
  | "usage.codebuddyTitle"
  | "usage.codebuddyTotal"
  | "usage.qoderLoading"
  | "usage.qoderUnavailable"
  | "usage.qoderRetry"
  | "usage.qoderRemaining"
  | "usage.qoderTitle"
  | "usage.geminiLoading"
  | "usage.geminiUnavailable"
  | "usage.geminiRetry"
  | "usage.geminiTitle"
  | "usage.qoderTotal"
  | "usage.miniMaxLoading"
  | "usage.miniMaxUnavailable"
  | "usage.miniMaxRetry"
  | "usage.miniMaxRemaining"
  | "usage.miniMaxTitle"
  | "usage.miniMaxBalance"
  | "usage.miniMaxBalanceDetails"
  | "usage.unlimited"
  | "usage.notInPlan"
  | "usage.copilotUnavailable"
  | "usage.grokUnavailable"
  | "usage.qoderActivities"
  | "usage.qoderActivityUnavailable"
  | "usage.qoderActivityEmpty"
  | "usage.activityUsed"
  | "usage.activityRemaining"
  | "usage.activityExpiresAt"
  | "usage.activityNoExpiration"
  | "usage.creditRemaining"
  | "usage.creditUsed"
  | "usage.expiresAt"
  | "usage.expirationUnavailable"
  | "usage.noCreditResources"
  | "usage.category.base"
  | "usage.category.extra"
  | "usage.category.bonus"
  | "usage.category.organization"
  | "usage.category.other"
  | "usage.resourceUnavailable"
  | "usage.workbuddyCheckinTitle"
  | "usage.workbuddyCheckinLoading"
  | "usage.workbuddyCheckinUnavailable"
  | "usage.workbuddyCheckinRetry"
  | "usage.workbuddyCheckinInactive"
  | "usage.workbuddyCheckinReward"
  | "usage.workbuddyCheckedIn"
  | "usage.workbuddyCheckinButton"
  | "usage.workbuddyCheckedInButton"
  | "usage.workbuddyCheckingIn"
  | "tokenStats.title"
  | "tokenStats.open"
  | "tokenStats.description"
  | "tokenStats.range"
  | "tokenStats.last7Days"
  | "tokenStats.last30Days"
  | "tokenStats.allTime"
  | "tokenStats.provider"
  | "tokenStats.allProviders"
  | "tokenStats.clear"
  | "tokenStats.confirmClear"
  | "tokenStats.total"
  | "tokenStats.sessions"
  | "tokenStats.trackedSessions"
  | "tokenStats.average"
  | "tokenStats.perSession"
  | "tokenStats.inputOutput"
  | "tokenStats.inputOutputHint"
  | "tokenStats.input"
  | "tokenStats.cached"
  | "tokenStats.output"
  | "tokenStats.dailyTrend"
  | "tokenStats.noTrend"
  | "tokenStats.providerCompare"
  | "tokenStats.sessionsUnit"
  | "tokenStats.sessionDetails"
  | "tokenStats.totalRecords"
  | "tokenStats.noData"
  | "tokenStats.noDataHint"
  | "tokenStats.time"
  | "tokenStats.session"
  | "tokenStats.location"
  | "tokenStats.model"
  | "tokenStats.tokens"
  | "tokenStats.previous"
  | "tokenStats.next"
  | "tokenStats.skillCalls"
  | "tokenStats.mcpCalls"
  | "tokenStats.callsUnit"
  | "tokenStats.topSkills"
  | "tokenStats.topMcp"
  | "tokenStats.skillUsage"
  | "tokenStats.mcpUsage"
  | "tokenStats.expandUsage"
  | "tokenStats.collapseUsage"
  | "tokenStats.capabilityUnavailable"
  | "tokenStats.noSkills"
  | "tokenStats.noMcp"
  | "tokenStats.transcriptDetected"
  | "skills.title"
  | "skills.open"
  | "skills.description"
  | "skills.provider"
  | "skills.search"
  | "skills.empty"
  | "skills.codebuddyEmptyHint"
  | "skills.codexInheritanceHint"
  | "skills.noMatches"
  | "mcp.title"
  | "mcp.open"
  | "mcp.description"
  | "mcp.codexInheritanceHint"
  | "mcp.provider"
  | "mcp.scope"
  | "mcp.scopeUser"
  | "mcp.scopeProject"
  | "mcp.scopeProjectLocal"
  | "mcp.scopeProjectShared"
  | "mcp.projectUnavailable"
  | "mcp.sharedWarning"
  | "mcp.search"
  | "mcp.add"
  | "mcp.empty"
  | "mcp.noMatches"
  | "mcp.selectHint"
  | "mcp.newServer"
  | "mcp.name"
  | "mcp.transport"
  | "mcp.command"
  | "mcp.args"
  | "mcp.argsHint"
  | "mcp.cwd"
  | "mcp.env"
  | "mcp.envKey"
  | "mcp.url"
  | "mcp.bearerEnv"
  | "mcp.headers"
  | "mcp.headerKey"
  | "mcp.startupTimeout"
  | "mcp.toolTimeout"
  | "mcp.enabled"
  | "mcp.disabled"
  | "mcp.masked"
  | "mcp.reveal"
  | "mcp.saving"
  | "mcp.saved"
  | "mcp.removed"
  | "mcp.conflict"
  | "mcp.discardChanges"
  | "mcp.unsavedClose"
  | "mcp.confirmDelete"
  | "mcp.restartHint"
  | "tokenLive.title"
  | "tokenLive.loading"
  | "tokenLive.waiting"
  | "tokenLive.unavailable"
  | "tokenLive.unavailableHint"
  | "tokenLive.sessionInput"
  | "tokenLive.sessionOutput"
  | "tokenLive.cachedInput"
  | "tokenLive.reasoningOutput"
  | "tokenLive.turnOutput"
  | "tokenLive.outputRate"
  | "tokenLive.model"
  | "tokenLive.updatedAt"
  | "tokenLive.skillUsage"
  | "tokenLive.mcpUsage"
  | "tokenLive.callsUnit"
  | "tokenLive.noSkills"
  | "tokenLive.noMcp"
  | "tokenLive.capabilityUnavailable"
  | "tokenLive.transcriptDetected"
  | "tokenLive.state.waiting"
  | "tokenLive.state.generating"
  | "tokenLive.state.completed"
  | "tokenLive.state.unavailable"
  | "terminal.exited"
  | "terminal.imagePasteFailed"
  | "composer.inputLabel"
  | "composer.placeholder"
  | "composer.send"
  | "composer.pasteImage"
  | "composer.uploadImage"
  | "composer.searchWorkspace"
  | "composer.searching"
  | "composer.searchUnavailable"
  | "composer.noMatches"
  | "composer.searchFailed"
  | "composer.uploadingImage"
  | "composer.noClipboardImage"
  | "composer.imageUploadFailed"
  | "composer.shortcuts"
  | "composer.shortcutsAgent"
  | "tabs.files"
  | "tabs.git"
  | "tabs.terminal"
  | "tabs.workspace"
  | "tabs.debug"
  | "tabs.conversation"
  | "conversation.unread"
  | "tabs.idea"
  | "idea.subtitle"
  | "idea.refresh"
  | "idea.notConnected"
  | "idea.installHint"
  | "idea.noProjects"
  | "idea.noConfigurations"
  | "idea.temporary"
  | "idea.run"
  | "idea.debug"
  | "idea.stop"
  | "idea.stopAll"
  | "idea.restart"
  | "idea.all"
  | "idea.parallelBlocked"
  | "idea.status.starting"
  | "idea.status.running"
  | "idea.status.stopping"
  | "idea.status.terminated"
  | "debug.eventsCount"
  | "debug.clearEvents"
  | "debug.providerFilter"
  | "debug.allInstances"
  | "debug.noMatchedSession"
  | "debug.noEvents"
  | "debug.handled"
  | "debug.unhandled"
  | "files.title"
  | "files.noSession"
  | "files.availableAfterSession"
  | "files.parentDirectory"
  | "files.openInExplorer"
  | "files.directoryPath"
  | "files.changeRoot"
  | "files.searchPlaceholder"
  | "files.clearSearch"
  | "files.onlyLocalFiles"
  | "files.cannotResolveLocalPaths"
  | "files.uploading"
  | "files.preparingDownload"
  | "files.downloadCompleted"
  | "files.downloadCanceled"
  | "files.downloadFailed"
  | "files.loading"
  | "files.emptyDirectory"
  | "files.noMatches"
  | "files.folder"
  | "files.addToTerminal"
  | "files.addToGraphicalInput"
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
  | "files.languageMode"
  | "files.languageAuto"
  | "files.languageAutoDetected"
  | "files.languagePlainText"
  | "files.deleteEntry"
  | "files.selectedItems"
  | "files.cannotMoveIntoSelf"
  | "files.tooLarge"
  | "files.binary"
  | "files.loadingOfficePreview"
  | "files.officeLoadFailed"
  | "files.officeUnsupportedHint"
  | "files.officeWorksheets"
  | "files.officeSpreadsheetTruncated"
  | "files.officeEmptyWorkbook"
  | "files.previewMode"
  | "files.editMode"
  | "files.newFile"
  | "files.newDirectory"
  | "files.enableAutoCollapse"
  | "files.disableAutoCollapse"
  | "files.back"
  | "files.forward"
  | "files.sortBy"
  | "files.sortNameAsc"
  | "files.sortNameDesc"
  | "files.sortModified"
  | "files.sortSize"
  | "files.rename"
  | "files.name"
  | "files.move"
  | "files.copyPath"
  | "files.copyName"
  | "files.targetDirectory"
  | "files.nameConflict"
  | "files.overwrite"
  | "files.skip"
  | "files.autoRename"
  | "files.saveAs"
  | "files.forceOverwrite"
  | "files.localChanges"
  | "files.remoteChanges"
  | "files.transfers"
  | "files.clearCompleted"
  | "files.noTransfers"
  | "files.activeTransfers"
  | "files.transferHistory"
  | "files.closeGuardTitle"
  | "files.unsavedFiles"
  | "files.activeTransfersExit"
  | "files.discardAndExit"
  | "files.saveAllAndExit"
  | "files.closeSshTransfers"
  | "tabs.monitor"
  | "system.sampledAt"
  | "system.memory"
  | "system.network"
  | "system.disk"
  | "system.download"
  | "system.upload"
  | "system.ioBusy"
  | "system.read"
  | "system.write"
  | "system.loading"
  | "system.unavailable"
  | "system.metrics"
  | "system.networkTitle"
  | "system.cpuTitle"
  | "system.diskTitle"
  | "system.diskMissing"
  | "system.diskLabel"
  | "system.diskRemaining"
  | "system.diskSelect"
  | "system.diskListTitle"
  | "system.diskUsage"
  | "system.diskIo"
  | "system.memoryTitle"
  | "system.historyChart"
  | "system.networkHistoryChart"
  | "system.collectingHistory"
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
  | "picker.frequent"
  | "picker.deleteFromLibrary"
  | "picker.duplicateSession"
  | "picker.editSession"
  | "picker.confirmDelete"
  | "picker.startFresh"
  | "picker.launchSelected"
  | "picker.launching"
  | "picker.launchFailed"
  | "picker.sessionTemplatesTab"
  | "picker.launchTemplatesTab"
  | "launchTemplate.name"
  | "launchTemplate.namePlaceholder"
  | "launchTemplate.nameExists"
  | "launchTemplate.selectedMembers"
  | "launchTemplate.noMembersSelected"
  | "launchTemplate.members"
  | "launchTemplate.description"
  | "launchTemplate.new"
  | "launchTemplate.partialFailure"
  | "launchTemplate.empty"
  | "launchTemplate.noMembers"
  | "launchTemplate.memberCount"
  | "launchTemplate.launch"
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
  | "hooks.codebuddyTrustNote"
  | "hooks.installing"
  | "hooks.installOrRepair"
  | "hooks.install"
  | "hooks.repair"
  | "projectSearch.filesTitle"
  | "projectSearch.textTitle"
  | "projectSearch.filesPlaceholder"
  | "projectSearch.textPlaceholder"
  | "projectSearch.close"
  | "projectSearch.caseSensitive"
  | "projectSearch.wholeWord"
  | "projectSearch.regex"
  | "projectSearch.includeIgnored"
  | "projectSearch.sshTextUnavailable"
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
  | "git.selectRepository"
  | "git.scanRepositories"
  | "git.scanningRepositories"
  | "git.noRepositories"
  | "git.workspaceSummary"
  | "git.repositoryLoadFailed"
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
  | "git.changesTab"
  | "git.historyTab"
  | "git.syncSection"
  | "git.commitSection"
  | "git.changesSection"
  | "git.expandSection"
  | "git.collapseSection"
  | "git.stagedCount"
  | "git.commitDraftPresent"
  | "git.changeCount"
  | "git.diffTruncated"
  | "git.stashManager"
  | "git.stashMessage"
  | "git.createStash"
  | "git.preview"
  | "git.drop"
  | "git.statusModified"
  | "git.statusAdded"
  | "git.statusDeleted"
  | "git.statusRenamed"
  | "git.statusCopied"
  | "git.statusConflict"
  | "git.statusTypeChanged"
  | "git.statusUntracked"
  | "git.cancelOperation"
  | "git.details"
  | "git.operationSucceeded"
  | "git.operationFailed"
  | "git.operationState"
  | "git.operationStateGuidance"
  | "git.createBranch"
  | "git.branchName"
  | "git.createAndCheckout"
  | "git.detachedHead"
  | "git.unbornBranch"
  | "git.noBranch"
  | "git.noUpstream"
  | "git.selectRemote"
  | "git.noRemotes"
  | "git.fetch"
  | "git.pull"
  | "git.push"
  | "git.commitSubject"
  | "git.commitBody"
  | "git.commitChanges"
  | "git.conflicts"
  | "git.stageResolved"
  | "git.stagedChanges"
  | "git.workingChanges"
  | "git.unstage"
  | "git.unstageAll"
  | "git.stage"
  | "git.stageAll"
  | "git.discardTitle"
  | "git.deleteUntrackedConfirm"
  | "git.discardWorkingConfirm"
  | "git.discard"
  | "git.recentCommits"
  | "git.loadingHistory"
  | "git.noHistory"
  | "git.loadMore"
  | "git.dropStashTitle"
  | "git.dropStashConfirm"
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
    "agentCapabilities.pannelHandleRemote": "Pannel Handle 远程桥",
    "app.noActiveSession": "无活动会话",
    "app.openTerminal": "打开终端",
    "projectAssistant.title": "项目助手",
    "projectAssistant.open": "打开项目助手",
    "projectAssistant.newConversation": "新对话",
    "projectAssistant.description": "查看并操控运行中的 Codex 对话，也可查询本机会话、模板和用量。",
    "projectAssistant.empty": "试试：“当前 Codex 在做什么？”或“让当前 Codex 继续检查”。",
    "projectAssistant.you": "你",
    "projectAssistant.application": "应用",
    "projectAssistant.thinking": "正在查询并思考…",
    "projectAssistant.confirm": "等待确认",
    "projectAssistant.reject": "拒绝",
    "projectAssistant.execute": "确认执行",
    "projectAssistant.placeholder": "询问 Codex 进展，或描述希望它执行的操作",
    "projectAssistant.stop": "停止生成",
    "projectAssistant.send": "发送消息",
    "projectAssistant.codexSessions": "Codex 实时对话",
    "projectAssistant.selectCodexSession": "选择 Codex 会话",
    "projectAssistant.noCodexSessions": "暂无运行中的 Codex 会话",
    "projectAssistant.switchMode": "切换 Plan / 默认模式",
    "projectAssistant.questionHint": "Codex 提问时，点击上方终端，用键盘选择或输入答案。",
    "projectAssistant.codexPlaceholder": "向当前 Codex 会话输入内容",
    "projectAssistant.sendToCodex": "发送给 Codex",
    "codexVersion.title": "Codex CLI 更新",
    "codexVersion.checking": "正在检测版本…",
    "codexVersion.current": "当前版本：{version}",
    "codexVersion.latest": "最新版本：{version}",
    "codexVersion.unknown": "当前版本不可用",
    "codexVersion.upToDate": "已是最新版本",
    "codexVersion.restart": "更新已安装，手动重启会话后生效",
    "codexVersion.manual": "安装来源不明，请按原安装方式手动更新",
    "codexVersion.check": "检查更新",
    "codexVersion.update": "更新 Codex",
    "codexVersion.confirmTitle": "确认更新 Codex",
    "codexVersion.confirm": "将更新 {environment} 中的 Codex 至 {version}。当前会话继续运行，重启后生效。",
    "codexVersion.cancel": "取消",
    "codexVersion.confirmUpdate": "确认更新",
    "codexVersion.updating": "正在更新 Codex…",
    "codexVersion.progress.checking": "进度：检测当前安装",
    "codexVersion.progress.installing": "进度：正在安装",
    "codexVersion.progress.verifying": "进度：验证更新结果",
    "codexVersion.progress.complete": "更新完成",
    "codexVersion.progress.failed": "更新失败",
    "codexVersion.progress.output": "安装输出",
    "codeBuddyVersion.title": "CodeBuddy CLI 更新",
    "codeBuddyVersion.update": "更新 CodeBuddy",
    "codeBuddyVersion.confirmTitle": "确认更新 CodeBuddy",
    "codeBuddyVersion.confirm": "将更新 {environment} 中的 CodeBuddy 至 {version}。当前会话继续运行，重启后生效。",
    "codeBuddyVersion.updating": "正在更新 CodeBuddy…",
    "projectAssistant.statusUnknown": "状态未知",
    "sessionOverview.title": "实例总览",
    "sessionOverview.openOverview": "打开实例总览",
    "sessionOverview.description": "当前打开 {count} 个终端实例",
    "sessionOverview.empty": "暂无终端实例",
    "sessionOverview.emptyHint": "创建或启动会话后，实例会显示在这里。",
    "sessionOverview.selectSession": "选择实例：{name}",
    "sessionOverview.open": "会话已打开",
    "sessionOverview.connecting": "SSH 连接中",
    "sessionOverview.connected": "SSH 已连接",
    "sessionOverview.reconnecting": "SSH 重连中",
    "sessionOverview.disconnected": "SSH 已断开",
    "sessionOverview.noAgent": "未配置 Agent",
    "sessionOverview.noAgentStatus": "暂无 Agent 状态",
    "sessionOverview.summary": "活动摘要",
    "sessionOverview.noSummary": "暂无活动摘要",
    "settings.title": "设置",
    "settings.subtitle": "管理应用行为、模型服务与本地连接",
    "settings.categories": "设置分类",
    "settings.generalDescription": "调整终端启动、界面和调试选项。",
    "settings.environmentTitle": "环境变量",
    "settings.environmentNavDescription": "集中管理可供会话复用的普通环境变量配置。",
    "settings.modelsTitle": "模型服务",
    "settings.modelsDescription": "配置模型服务凭据、在线模型和默认选择。",
    "settings.mobileNavDescription": "配置局域网访问、设备密码与连接安全。",
    "settings.notificationsTitle": "通知",
    "settings.notificationsDescription": "配置会话状态的外部通知渠道。",
    "settings.environmentProfiles": "配置组",
    "settings.environmentProfileCount": "共 {count} 组",
    "settings.environmentNewProfile": "新建配置组",
    "settings.environmentNewProfileHint": "创建一组可复用变量",
    "settings.environmentVariableCount": "{count} 个变量",
    "settings.environmentReferenceCount": "{count} 个引用",
    "settings.environmentDescription": "普通配置以明文保存在本机，请勿填写密钥；修改在下次启动会话时生效。",
    "settings.environmentUnsaved": "未保存",
    "settings.environmentProfileName": "配置组名称",
    "settings.environmentProfileNamePlaceholder": "例如：本地开发代理",
    "settings.environmentVariables": "环境变量",
    "settings.environmentAddVariable": "添加变量",
    "settings.environmentVariableName": "变量名",
    "settings.environmentVariableValue": "值",
    "settings.environmentRemoveVariable": "删除变量",
    "settings.environmentEmpty": "此配置组还没有环境变量。",
    "settings.environmentAddFirstVariable": "添加第一个变量",
    "settings.environmentPasteTitle": "批量粘贴 KEY=VALUE",
    "settings.environmentPasteHint": "每行填写一个变量；空行和以 # 开头的注释会被忽略。",
    "settings.environmentPasteAria": "批量环境变量",
    "settings.environmentAppend": "追加到变量表",
    "settings.environmentPasteError": "每行应为 KEY=VALUE。",
    "settings.environmentReferencedBy": "引用会话",
    "settings.environmentReferenceSeparator": "、",
    "settings.environmentDeleteReferencedHint": "该配置组正在使用中，解除所有会话引用后才能删除。",
    "settings.environmentSave": "保存配置组",
    "settings.environmentCopy": "复制为新组",
    "settings.environmentDelete": "删除配置组",
    "settings.environmentConfirmDelete": "确认删除",
    "settings.environmentSaved": "已保存，下次启动会话生效。",
    "settings.environmentDeleted": "配置组已删除。",
    "settings.environmentCopySuffix": " - 副本",
    "settings.environmentUnsavedTitle": "保存环境变量更改？",
    "settings.environmentUnsavedDescription": "当前配置组有未保存的修改。保存后继续，或放弃修改并执行刚才的操作。",
    "settings.environmentSaveAndContinue": "保存并继续",
    "settings.environmentDiscardAndContinue": "放弃更改",
    "settings.environmentKeepEditing": "继续编辑",
    "settings.mobileTitle": "局域网移动终端",
    "settings.mobileRunning": "运行中",
    "settings.mobileStopped": "已停止",
    "settings.mobileHttpWarning": "当前使用 HTTP 明文传输，移动访问密码也会经局域网明文发送。只能在可信私人局域网中启用，禁止映射到互联网。",
    "settings.mobileInterface": "局域网网卡",
    "settings.mobilePort": "端口",
    "settings.mobilePassword": "移动访问密码（8–128 个字符）",
    "settings.mobileSetPassword": "设置密码",
    "settings.mobileChangePassword": "修改密码",
    "settings.mobilePasswordSet": "密码已设置。修改后，所有在线连接须重新验证。",
    "settings.mobilePasswordNeeded": "请先设置密码，再启用移动访问。",
    "settings.mobilePasswordSaved": "密码已保存，在线连接已断开。",
    "settings.mobileOpenHint": "手机可打开前两个局域网地址；在本机打开 127.0.0.1 地址。连接时输入移动访问密码。",
    "settings.mobileActiveDevice": "在线连接",
    "settings.mobileDisconnect": "断开",
    "settings.mobileNoActiveDevice": "当前没有手机在线。",
    "settings.mobileAudit": "安全事件",
    "settings.open": "打开设置",
    "settings.generalTitle": "常用配置",
    "settings.autoRestore": "启动时自动恢复",
    "session.graphicalMode": "使用图形会话",
    "session.graphicalModeHint": "勾选后使用 {mode}；取消勾选后使用终端。仅影响此模板之后启动的会话。",
    "settings.autoWorkBuddyCheckin": "CodeBuddy 自动签到",
    "settings.debugMode": "Debug 模式",
    "settings.screenshotTitle": "截图",
    "settings.screenshotDescription": "调用 Windows 原生区域截图，完成后图片会复制到系统剪贴板。",
    "settings.screenshotEnabled": "启用截图功能",
    "settings.screenshotShortcut": "截图快捷键",
    "settings.screenshotShortcutRecording": "请按新的组合键…",
    "settings.screenshotShortcutHint": "支持 Ctrl、Alt、Shift 加字母、数字或 F1-F12；按 Esc 取消录制。",
    "settings.screenshotShortcutReserved": "该组合键已被应用占用，请使用其他快捷键。",
    "settings.screenshotShortcutModifierRequired": "快捷键至少需要一个 Ctrl、Alt 或 Shift 修饰键。",
    "settings.screenshotShortcutUnsupported": "不支持该按键，请使用修饰键加字母、数字或 F1-F12。",
    "settings.terminalBackgroundTitle": "终端背景",
    "settings.terminalBackgroundDescription": "为所有终端设置统一的背景图片，并调节不透明度与模糊程度。",
    "settings.terminalBackgroundChoose": "选择图片",
    "settings.terminalBackgroundClear": "清除",
    "settings.terminalBackgroundOpacity": "不透明度",
    "settings.terminalBackgroundBlur": "模糊",
    "settings.terminalBackgroundNone": "未设置背景图片",
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
    "settings.openRouterConfigured": "API Key 已配置",
    "settings.openRouterNotConfigured": "尚未配置",
    "settings.openRouterDescription": "使用 OpenRouter 作为 Codex 的模型后端。API Key 由系统安全存储加密，只在启动进程时注入环境变量。",
    "settings.openRouterKeyStored": "已安全保存；输入新值可替换",
    "settings.openRouterSaved": "OpenRouter API Key 已安全保存。",
    "settings.openRouterTest": "测试连接",
    "settings.openRouterTestSuccess": "OpenRouter 连接成功。",
    "settings.openRouterClear": "清除 API Key",
    "settings.openRouterCleared": "OpenRouter API Key 已清除。",
    "settings.openRouterRefreshModels": "刷新在线模型",
    "settings.openRouterModelsRefreshed": "OpenRouter 模型目录已刷新。",
    "settings.openRouterFavorites": "兼容模型与收藏",
    "settings.openRouterFreeModelsOnly": "仅看免费模型",
    "settings.openRouterNoMatchingModels": "没有匹配的兼容模型。",
    "settings.openRouterDefaultModel": "设为默认模型",
    "settings.openRouterRefreshHint": "请先刷新在线模型目录。仅显示支持 tools 和 tool_choice 的模型。",
    "settings.openRouterSaveFavorites": "保存收藏与默认模型",
    "settings.openRouterFavoritesSaved": "OpenRouter 收藏模型已保存。",
    "settings.openRouterNewSessionsHint": "收藏目录更新只影响新启动的会话；运行中的会话仍可使用 Codex 原生 /model 在本目录内切换。",
    "settings.openRouterPriceInput": "输入",
    "settings.openRouterPriceOutput": "输出",
    "settings.openRouterPriceUnavailable": "价格未知",
    "settings.openRouterVerificationPending": "待检测",
    "settings.openRouterVerificationPassed": "已验证",
    "settings.openRouterVerificationPartial": "部分兼容",
    "settings.openRouterVerificationFailed": "检测失败",
    "settings.openRouterVerificationUnavailable": "暂时不可用",
    "settings.openRouterVerificationPartialSuccess": "普通函数工具检测通过；完整 Codex 工具协议未通过或暂未确认，可作为实验模型使用。",
    "settings.openRouterVerificationPartialRateLimit": "普通函数工具已通过；完整 Codex 工具协议因上游限流暂未确认，可作为实验模型使用。",
    "settings.openRouterResponsesRejected": "当前模型未通过 Codex 所需的 Responses 请求，请更换模型。",
    "settings.openRouterProviderDetail": "服务端详情",
    "settings.openRouterStageResponses": "基础 Responses",
    "settings.openRouterStageFunctionTools": "普通函数工具",
    "settings.openRouterStageCodexTools": "完整 Codex 工具协议",
    "settings.openRouterVerifyRetry": "检测",
    "settings.openRouterVerifying": "检测中…",
    "settings.openRouterVerificationSuccess": "OpenRouter 模型兼容性检测通过。",
    "settings.openRouterRateLimitHint": "OpenRouter 请求受限。免费模型可能已达到频率或每日额度限制，请 60 秒后重试；若仍失败，请等待额度恢复、增加 OpenRouter 额度或更换模型。",
    "settings.naraRouterDescription": "使用 NaraRouter 作为 Codex 的模型后端。API Key 由系统安全存储加密，只在启动进程时注入环境变量。",
    "settings.naraRouterSaved": "NaraRouter API Key 已安全保存。",
    "settings.naraRouterTestSuccess": "NaraRouter 连接成功。",
    "settings.naraRouterCleared": "NaraRouter API Key 已清除。",
    "settings.naraRouterModelsRefreshed": "NaraRouter 模型目录已刷新。",
    "settings.naraRouterFavoritesSaved": "NaraRouter 收藏模型已保存。",
    "settings.naraRouterRefreshHint": "请先配置 API Key 并刷新当前账号可用的在线模型目录。",
    "settings.naraRouterVerificationSuccess": "NaraRouter 模型兼容性检测通过。",
    "settings.naraRouterRateLimitHint": "NaraRouter 请求受限。当前模型档位可能已达到频率或每日额度限制，请 60 秒后重试或更换其他可用模型。",
    "settings.miniMaxDescription": "使用 MiniMax 作为 Codex 模型后端，支持 Token Plan 与普通按量 API Key。密钥仅加密保存在本机。",
    "settings.miniMaxSaved": "MiniMax API Key 已安全保存。",
    "settings.miniMaxTestSuccess": "MiniMax 连接成功。",
    "settings.miniMaxCleared": "MiniMax API Key 已清除。",
    "settings.miniMaxModelsRefreshed": "MiniMax 模型目录已刷新。",
    "settings.miniMaxFavoritesSaved": "MiniMax 收藏模型已保存。",
    "settings.miniMaxRefreshHint": "请先配置 API Key 并刷新当前密钥可用的在线模型目录。",
    "settings.miniMaxVerificationSuccess": "MiniMax 模型兼容性检测通过。",
    "settings.miniMaxRateLimitHint": "MiniMax 请求受限。请等待当前速率或 Token Plan 额度窗口恢复后重试。",
    "settings.codeBuddyCodexTitle": "CodeBuddy Codex",
    "settings.codeBuddyCodexNotConfigured": "尚未配置",
    "settings.codeBuddyCodexDescription": "集中加载并验证 CodeBuddy 模型。会话只读取这里保存的模型，不再执行实时检测。",
    "settings.codeBuddyCodexRefreshModels": "刷新本机模型",
    "settings.codeBuddyCodexModelsRefreshed": "CodeBuddy 模型目录已刷新。",
    "settings.codeBuddyCodexModels": "已检测模型与收藏",
    "settings.codeBuddyCodexVerified": "已验证",
    "settings.codeBuddyCodexVerificationPending": "待检测",
    "settings.codeBuddyCodexVerificationFailed": "检测失败",
    "settings.codeBuddyCodexVerificationSuccess": "CodeBuddy 模型兼容性检测通过。",
    "settings.codeBuddyCodexVerify": "检测",
    "settings.codeBuddyCodexVerifying": "检测中…",
    "settings.codeBuddyCodexDefaultModel": "设为默认模型",
    "settings.codeBuddyCodexRefreshHint": "请先刷新本机 CodeBuddy 模型目录。",
    "settings.codeBuddyCodexSaveFavorites": "保存收藏与默认模型",
    "settings.codeBuddyCodexFavoritesSaved": "CodeBuddy 收藏模型已保存。",
    "settings.codeBuddyCodexAcknowledge": "我已了解该私有桥不预设 CLI 兼容版本；升级后同名且已检测通过的模型继续视为可用，新模型仍需检测。",
    "settings.codeBuddyCodexAcknowledgementSaved": "CodeBuddy 实验风险确认已更新。",
    "settings.codeBuddyCodexNewSessionsHint": "会话仅可选择这里已验证并收藏的模型；CLI 版本变化不会重置同名模型的检测、收藏和风险确认。",
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
    "confirm.trashEntry": "确定将 \"{name}\" 移到回收站吗？",
    "confirm.deleteEntries": "确定要删除选中的 {count} 项吗？此操作无法撤销。",
    "confirm.trashEntries": "确定将选中的 {count} 项移到回收站吗？",
    "window.minimize": "最小化",
    "window.maximize": "最大化",
    "window.restore": "还原",
    "window.close": "关闭",
    "screenshot.capture": "区域截图",
    "screenshot.captureFailed": "无法启动区域截图：{message}",
    "sidebar.title": "命令会话",
    "sidebar.count": "{count} 个窗口",
    "sidebar.countFiltered": "{count} 个窗口 / 显示 {filtered} 个",
    "sidebar.openLibrary": "从库中启动",
    "sidebar.newSession": "新建会话",
    "sidebar.searchPlaceholder": "搜索会话...",
    "sidebar.clearSearch": "清除搜索",
    "sidebar.empty": "没有匹配的会话",
    "sidebar.installHooks": "安装项目 Hook",
    "sidebar.duplicateSession": "复制并在后台启动新会话",
    "sidebar.duplicatingSession": "正在复制会话",
    "sidebar.editSession": "编辑会话",
    "sidebar.closeSession": "关闭",
    "sidebar.confirmClose": "再次点击确认关闭",
    "sidebar.sshConnecting": "SSH 连接中",
    "sidebar.sshReconnecting": "SSH 重连中（第 {attempt} 次）",
    "sidebar.sshDisconnected": "SSH 已断开",
    "sidebar.sshReconnectNow": "立即重连 SSH",
    "session.newTitle": "新建会话",
    "session.editTitle": "编辑会话",
    "session.newSubtitle": "配置终端、工作目录与 Agent",
    "session.editSubtitle": "调整会话信息与启动配置",
    "session.basicSection": "会话信息",
    "session.connectionSection": "SSH 连接",
    "session.startupSection": "启动命令",
    "session.environment": "环境变量",
    "session.environmentHint": "在设置中维护配置组；会话变量覆盖组内同名变量。下次启动生效。",
    "session.environmentProfile": "配置组",
    "session.environmentProfileNone": "不使用配置组",
    "session.environmentPreview": "待注入配置（不含系统继承值）",
    "session.environmentVariable": "变量",
    "session.environmentValue": "值",
    "session.environmentSource": "来源",
    "session.environmentEmptyValue": "（空字符串）",
    "session.environmentPrecedenceHint": "应用运行变量及模型服务注入的同名变量优先；Shell 启动脚本可继续修改环境。仅保存普通配置，不支持密钥。",
    "session.environmentLocalSshHint": "变量将注入本地 Agent 进程。",
    "session.environmentRemoteSshHint": "远端注入仅支持 Linux / Bash，不影响 SFTP 和独立后台命令。",
    "session.configured": "已配置",
    "session.notConfigured": "未配置",
    "session.itemsConfigured": "已配置 {count} 项",
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
    "session.remoteCwd": "远端工作目录",
    "session.remotePlatform": "远程操作系统",
    "session.remotePlatformAuto": "自动检测",
    "session.localAgentCwd": "本机 Agent 工作目录（可选）",
    "session.localAgentCwdPlaceholder": "未选择时使用应用临时目录",
    "session.localAgentCwdHint": "本机 Agent 将从此目录启动；远端操作范围仍由远端工作目录决定。",
    "session.initialCommand": "初始命令",
    "session.initialCommandPlaceholder": "输入初始命令（可选），如：{example}",
    "session.agentCli": "Agent CLI",
    "session.normalTerminal": "普通终端",
    "session.quickAgent": "快速创建本机 Agent 会话",
    "session.quickAgentMenu": "选择本机 Agent",
    "agentSwitch.title": "切换当前会话的 Agent",
    "agentSwitch.menu": "选择要切换到的 Agent",
    "agentSwitch.switching": "正在切换到 {provider}",
    "agentSwitch.localSshUnavailable": "本机 SSH 桥接仅支持在 Codex、CodeBuddy 与 OpenCode 之间切换",
    "codexBackendSwitch.title": "切换当前 Codex 会话的模型后端",
    "codexBackendSwitch.menu": "选择要切换到的 Codex 模型后端",
    "codexBackendSwitch.switching": "正在切换到 {backend}",
    "session.agentCwdRequired": "选择 Agent CLI 时必须填写项目工作目录。",
    "settings.defaultWindowsShell": "Windows 默认 Shell",
    "settings.defaultWindowsShellHint": "保存后对新建会话生效，已有会话和模板保留原 Shell。PowerShell 7 需要单独安装。",
    "session.defaultShell": "默认（{shell}）",
    "session.shellSyntaxHint": "请使用 {shell} 语法；选择 CLI 后会自动追加启动命令。",
    "session.preLaunchCommand": "CLI 启动前命令",
    "session.codexBackend": "Codex 模型后端",
    "session.codexBackendOpenAI": "OpenAI（Codex 默认）",
    "session.codexModel": "OpenRouter 默认模型",
    "session.codexModelSelect": "选择已收藏模型",
    "session.openRouterKeyRequired": "请先在设置中配置 OpenRouter API Key。",
    "session.openRouterFavoriteRequired": "请先在设置中收藏兼容模型并选择默认模型。",
    "session.openRouterModelHint": "进入会话后可使用 Codex 原生 /model 随时切换收藏目录中的模型。",
    "session.openRouterVerifiedRequired": "请先在设置中检测并保存至少一个兼容模型。",
    "session.openRouterExperimentalAcknowledge": "该模型仅部分兼容。我了解 Codex 可能在首轮请求或编辑操作时失败，并同意实验启动。",
    "session.openRouterExperimentalRequired": "请先确认部分兼容模型的实验风险。",
    "session.naraRouterModel": "NaraRouter 默认模型",
    "session.naraRouterKeyRequired": "请先在设置中配置 NaraRouter API Key。",
    "session.naraRouterFavoriteRequired": "请先在设置中收藏兼容模型并选择默认模型。",
    "session.naraRouterModelHint": "进入会话后可使用 Codex 原生 /model 随时切换收藏目录中的模型。",
    "session.naraRouterVerifiedRequired": "请先在设置中检测并保存至少一个兼容模型。",
    "session.miniMaxModel": "MiniMax 默认模型",
    "session.miniMaxKeyRequired": "请先在设置中配置 MiniMax API Key。",
    "session.miniMaxFavoriteRequired": "请先在设置中收藏兼容模型并选择默认模型。",
    "session.miniMaxModelHint": "进入会话后可使用 Codex 原生 /model 切换已收藏的 MiniMax 模型。",
    "session.miniMaxVerifiedRequired": "请先在设置中检测并保存至少一个兼容模型。",
    "session.codeBuddyCodexModel": "CodeBuddy 模型",
    "session.codeBuddyCodexConfigRequired": "请先在全局设置中验证、收藏 CodeBuddy 模型并确认实验风险。",
    "session.codeBuddyCodexModelHint": "仅显示全局设置中已验证并收藏的模型。",
    "session.agentLocation": "Agent 运行位置",
    "session.agentLocationLocal": "本地桥接",
    "session.agentLocationRemote": "远端运行",
    "session.agentLocationLocalHint": "本机运行 Codex、CodeBuddy 或 OpenCode，通过安全桥接操作远程工作区",
    "session.agentLocationUnsupported": "本地桥接仅支持 Codex、CodeBuddy 和 OpenCode",
    "remoteAgent.auditTitle": "远程操作",
    "remoteAgent.auditEphemeral": "仅保留当前会话",
    "remoteAgent.auditWaiting": "等待 Agent 调用远程工具…",
    "remoteAgent.approvalTitle": "允许 Agent 操作远程服务器？",
    "remoteAgent.approvalSource": "来自 {source}",
    "remoteAgent.approvalRemaining": "另有 {count} 项",
    "remoteAgent.approvalDeny": "拒绝",
    "remoteAgent.approvalOnce": "仅本次允许",
    "remoteAgent.approvalSession": "本会话允许",
    "remoteAgent.approvalFailed": "授权请求已失效，请重试。",
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
    "quickCommand.more": "更多",
    "quickCommand.dialog": "全部快捷命令",
    "quickCommand.empty": "暂无快捷命令，可在下方添加临时命令",
    "quickCommand.pin": "置顶",
    "quickCommand.unpin": "取消置顶",
    "quickCommand.pinLimit": "最多置顶 3 个命令",
    "tag.remove": "删除标签 {tag}",
    "tag.placeholderEmpty": "输入标签，按 Enter 添加",
    "tag.placeholderAdd": "添加标签",
    "agent.waitingForPermission": "{agent} 等待确认",
    "agent.waitingForPermissionTool": "{agent} 等待确认: {tool}",
    "agent.waitingForAnswer": "{agent} 等待回答",
    "agent.waitingForPlanConfirmation": "{agent} 等待确认计划",
    "agent.idlePrompt": "{agent} 空闲中",
    "agent.completed": "{agent} 已完成",
    "agent.failed": "{agent} 失败",
    "agent.running": "{agent} 运行中",
    "agent.ended": "{agent} 已结束",
    "agent.exited": "进程已退出",
    "agent.openCodeEmptyResponse": "OpenCode 在远程工具成功执行后返回了空回复。桥接本身正常，请在 OpenCode 中切换模型、输入 /compact，或新建会话后重试。",
    "usage.loading": "正在读取 Codex 用量...",
    "usage.unavailable": "Codex 用量不可用",
    "usage.retry": "重试读取 Codex 用量",
    "usage.remaining": "Codex 剩余 {remaining}%",
    "usage.title": "Codex 用量",
    "usage.refresh": "刷新用量",
    "usage.refreshing": "正在刷新",
    "usage.close": "关闭用量明细",
    "usage.limitRemaining": "剩余 {remaining}%",
    "usage.used": "已用 {used}%",
    "usage.resetsAt": "{time} 重置",
    "usage.resetUnavailable": "重置时间未知",
    "usage.resetCreditsTitle": "重置额度",
    "usage.resetCreditsAvailable": "{count} 个可用",
    "usage.resetCreditsEmpty": "当前没有可用重置额度",
    "usage.resetCreditFallback": "重置额度",
    "usage.resetCreditGrantedAt": "授予于 {time}",
    "usage.resetCreditGrantedLabel": "发放时间",
    "usage.resetCreditExpiresLabel": "过期时间",
    "usage.resetCreditExpiresAt": "有效期至 {time}",
    "usage.resetCreditNoExpiration": "长期有效",
    "usage.resetCreditStatus.available": "可用",
    "usage.resetCreditStatus.redeeming": "兑换中",
    "usage.resetCreditStatus.redeemed": "已兑换",
    "usage.resetCreditStatus.unknown": "状态未知",
    "usage.resetCreditDetailsUnavailable": "Codex 仅返回了可用数量，暂无可操作的额度明细",
    "usage.resetCreditAction": "重置限额",
    "usage.resetCreditConfirm": "再次点击确认重置",
    "usage.resetCreditResetting": "正在重置...",
    "usage.resetCreditRetry": "重试重置",
    "usage.resetCreditSuccess": "Codex 使用限额已重置",
    "usage.resetCreditAlreadyRedeemed": "本次重置已完成",
    "usage.resetCreditNothingToReset": "当前没有符合条件的限额需要重置",
    "usage.resetCreditNoCredit": "当前没有可用的重置额度",
    "usage.resetCreditFailed": "重置失败：{message}",
    "usage.resetCreditRefreshFailed": "{result}，但刷新最新限额失败：{message}",
    "usage.updatedAt": "更新于 {time}",
    "usage.codebuddyLoading": "正在读取 CodeBuddy 额度...",
    "usage.codebuddyUnavailable": "CodeBuddy 额度暂不可用",
    "usage.codebuddyRetry": "重试读取 CodeBuddy 额度",
    "usage.codebuddyRemaining": "CodeBuddy 剩余 {remaining} Credits",
    "usage.codebuddyTitle": "CodeBuddy 额度",
    "usage.codebuddyTotal": "全部可用额度",
    "usage.qoderLoading": "正在读取 Qoder 额度...",
    "usage.qoderUnavailable": "Qoder 额度暂不可用",
    "usage.qoderRetry": "请确认当前环境已登录并升级 Qoder CLI 后重试",
    "usage.qoderRemaining": "Qoder 剩余 {remaining} Credits",
    "usage.qoderTitle": "Qoder 额度",
    "usage.geminiLoading": "正在读取 Gemini 配额...",
    "usage.geminiUnavailable": "Gemini 配额不可用",
    "usage.geminiRetry": "Gemini 配额不可用，点击重试",
    "usage.geminiTitle": "Gemini 配额",
    "usage.qoderTotal": "全部可用额度",
    "usage.miniMaxLoading": "正在读取 MiniMax 额度...",
    "usage.miniMaxUnavailable": "MiniMax 额度暂不可用",
    "usage.miniMaxRetry": "重试读取 MiniMax 额度",
    "usage.miniMaxRemaining": "MiniMax 剩余 {remaining}%",
    "usage.miniMaxTitle": "MiniMax 额度",
    "usage.miniMaxBalance": "MiniMax 可用余额 ¥{available}",
    "usage.miniMaxBalanceDetails": "现金 ¥{cash} · 代金券 ¥{voucher} · 授信 ¥{credit} · 欠款 ¥{owed}",
    "usage.unlimited": "不限量",
    "usage.notInPlan": "不在当前套餐",
    "usage.copilotUnavailable": "GitHub Copilot 暂无稳定的账户额度接口",
    "usage.grokUnavailable": "Grok CLI 暂无稳定的账户额度接口",
    "usage.qoderActivities": "活动额度",
    "usage.qoderActivityUnavailable": "活动额度暂不可用，请刷新后重试",
    "usage.qoderActivityEmpty": "当前没有可用活动额度",
    "usage.activityUsed": "{used} / {total} Credits",
    "usage.activityRemaining": "剩余 {remaining} Credits",
    "usage.activityExpiresAt": "将于 {time} 结束",
    "usage.activityNoExpiration": "暂无结束时间",
    "usage.creditRemaining": "剩余 {remaining} / {total} Credits",
    "usage.creditUsed": "已用 {used} / {total} Credits",
    "usage.expiresAt": "{time} 到期",
    "usage.expirationUnavailable": "到期时间未知",
    "usage.noCreditResources": "当前没有可用额度包",
    "usage.category.base": "基础套餐",
    "usage.category.extra": "加量包",
    "usage.category.bonus": "奖励额度",
    "usage.category.organization": "组织资源包",
    "usage.category.other": "其他额度",
    "usage.resourceUnavailable": "当前不可使用",
    "usage.workbuddyCheckinTitle": "WorkBuddy 每日签到",
    "usage.workbuddyCheckinLoading": "正在读取签到状态...",
    "usage.workbuddyCheckinUnavailable": "暂时无法读取 WorkBuddy 签到状态",
    "usage.workbuddyCheckinRetry": "重试",
    "usage.workbuddyCheckinInactive": "当前签到活动未开放",
    "usage.workbuddyCheckinReward": "今日可领取 {credit} Credits",
    "usage.workbuddyCheckedIn": "今日已领取 {credit} Credits，连续签到 {days} 天",
    "usage.workbuddyCheckinButton": "立即签到",
    "usage.workbuddyCheckedInButton": "今日已签到",
    "usage.workbuddyCheckingIn": "签到中...",
    "tokenStats.title": "Token 统计",
    "tokenStats.open": "打开 Token 统计",
    "tokenStats.description": "查看 OpenCode 等 Agent 的会话消耗趋势和明细",
    "tokenStats.range": "统计时间范围",
    "tokenStats.last7Days": "最近 7 天",
    "tokenStats.last30Days": "最近 30 天",
    "tokenStats.allTime": "全部时间",
    "tokenStats.provider": "Agent 类型",
    "tokenStats.allProviders": "全部 Agent",
    "tokenStats.clear": "清空统计",
    "tokenStats.confirmClear": "再次点击确认清空",
    "tokenStats.total": "总 Token",
    "tokenStats.sessions": "会话数",
    "tokenStats.trackedSessions": "已统计 Agent 会话",
    "tokenStats.average": "平均消耗",
    "tokenStats.perSession": "每个会话",
    "tokenStats.inputOutput": "输入 / 输出",
    "tokenStats.inputOutputHint": "Token 构成",
    "tokenStats.input": "输入",
    "tokenStats.cached": "缓存输入",
    "tokenStats.output": "输出",
    "tokenStats.dailyTrend": "每日 Token 趋势",
    "tokenStats.noTrend": "暂无趋势数据",
    "tokenStats.providerCompare": "Agent 对比",
    "tokenStats.sessionsUnit": "个会话",
    "tokenStats.sessionDetails": "会话明细",
    "tokenStats.totalRecords": "共 {count} 条",
    "tokenStats.noData": "还没有 Token 统计",
    "tokenStats.noDataHint": "从 Pannel Handle 启动支持的 Agent，收到真实 Token 用量后会自动记录。",
    "tokenStats.time": "更新时间",
    "tokenStats.session": "会话",
    "tokenStats.location": "位置",
    "tokenStats.model": "模型",
    "tokenStats.tokens": "总计（输入 / 输出）",
    "tokenStats.previous": "上一页",
    "tokenStats.next": "下一页",
    "tokenStats.skillCalls": "技能调用",
    "tokenStats.mcpCalls": "MCP 调用",
    "tokenStats.callsUnit": "次",
    "tokenStats.topSkills": "常用技能",
    "tokenStats.topMcp": "常用 MCP",
    "tokenStats.skillUsage": "技能使用",
    "tokenStats.mcpUsage": "MCP 使用",
    "tokenStats.expandUsage": "查看技能与 MCP",
    "tokenStats.collapseUsage": "收起技能与 MCP",
    "tokenStats.capabilityUnavailable": "当前 transcript 无法识别此类调用",
    "tokenStats.noSkills": "本会话未检测到技能调用",
    "tokenStats.noMcp": "本会话未检测到 MCP 调用",
    "tokenStats.transcriptDetected": "基于 transcript 保守识别",
    "skills.title": "Skills",
    "skills.open": "打开 Skills",
    "skills.description": "浏览 Codex 与 CodeBuddy 技能",
    "skills.provider": "Skill 提供方",
    "skills.search": "搜索 Skills",
    "skills.empty": "尚未发现 Skills",
    "skills.codebuddyEmptyHint": "在 ~/.codebuddy/skills 中添加 Skill 后会显示在这里。",
    "skills.codexInheritanceHint": "Pannel Handle 启动的 CodeBuddy 会话还会继承 Codex 用户级和项目级 Skills，使用 /codex:名称 调用；此处仅管理 CodeBuddy 原生 Skills。",
    "skills.noMatches": "没有匹配的 Skills",
    "mcp.title": "MCP 管理",
    "mcp.open": "打开 MCP 管理",
    "mcp.description": "查看和编辑 Codex、CodeBuddy 的用户与项目 MCP 配置",
    "mcp.codexInheritanceHint": "Pannel Handle 启动的 CodeBuddy 会话会继承 Codex 用户级和项目级 MCP；同名时 Codex 配置优先。此处编辑的是原生配置。",
    "mcp.provider": "MCP 提供方",
    "mcp.scope": "配置作用域",
    "mcp.scopeUser": "用户级",
    "mcp.scopeProject": "项目级",
    "mcp.scopeProjectLocal": "项目私有",
    "mcp.scopeProjectShared": "项目共享",
    "mcp.projectUnavailable": "请选择一个运行中的 Windows 会话",
    "mcp.sharedWarning": "此作用域会修改当前工作目录中的仓库配置文件。",
    "mcp.search": "搜索 MCP 服务",
    "mcp.add": "新增 MCP 服务",
    "mcp.empty": "当前作用域没有 MCP 服务",
    "mcp.noMatches": "没有匹配的 MCP 服务",
    "mcp.selectHint": "选择或新增一个 MCP 服务",
    "mcp.newServer": "新建 MCP 服务",
    "mcp.name": "服务名称",
    "mcp.transport": "传输方式",
    "mcp.command": "启动命令",
    "mcp.args": "命令参数",
    "mcp.argsHint": "每行一个参数",
    "mcp.cwd": "工作目录（可选）",
    "mcp.env": "环境变量",
    "mcp.envKey": "环境变量名",
    "mcp.url": "服务 URL",
    "mcp.bearerEnv": "Bearer Token 环境变量名（可选）",
    "mcp.headers": "HTTP Headers",
    "mcp.headerKey": "Header 名称",
    "mcp.startupTimeout": "启动超时（秒）",
    "mcp.toolTimeout": "工具超时（秒）",
    "mcp.enabled": "已启用",
    "mcp.disabled": "已停用",
    "mcp.masked": "敏感值已隐藏",
    "mcp.reveal": "揭示敏感值",
    "mcp.saving": "保存中…",
    "mcp.saved": "MCP 配置已保存。",
    "mcp.removed": "MCP 服务已删除。",
    "mcp.conflict": "配置文件已被其它程序修改。当前草稿未覆盖磁盘内容，请刷新后重试。",
    "mcp.discardChanges": "当前 MCP 配置有未保存修改，确定放弃吗？",
    "mcp.unsavedClose": "当前 MCP 配置有未保存修改。",
    "mcp.confirmDelete": "确定删除 MCP 服务“{name}”吗？删除后可从 .pannel-handle.bak 备份恢复。",
    "mcp.restartHint": "保存后需重启对应 Agent 会话才能确保加载新配置。",
    "tokenLive.title": "{provider} 实时 Token",
    "tokenLive.loading": "正在读取 Token...",
    "tokenLive.waiting": "等待 Token 数据",
    "tokenLive.unavailable": "Token 暂不可用",
    "tokenLive.unavailableHint": "暂时无法读取会话 transcript，Agent 和终端运行不受影响。",
    "tokenLive.sessionInput": "会话累计输入",
    "tokenLive.sessionOutput": "会话累计输出",
    "tokenLive.cachedInput": "缓存输入",
    "tokenLive.reasoningOutput": "推理输出",
    "tokenLive.turnOutput": "本轮输出",
    "tokenLive.outputRate": "平均输出速率",
    "tokenLive.model": "模型",
    "tokenLive.updatedAt": "更新时间",
    "tokenLive.skillUsage": "技能使用",
    "tokenLive.mcpUsage": "MCP 使用",
    "tokenLive.callsUnit": "次",
    "tokenLive.noSkills": "本会话未检测到技能调用",
    "tokenLive.noMcp": "本会话未检测到 MCP 调用",
    "tokenLive.capabilityUnavailable": "当前 transcript 无法识别此类调用",
    "tokenLive.transcriptDetected": "基于 transcript 保守识别",
    "tokenLive.state.waiting": "等待首次 usage 数据",
    "tokenLive.state.generating": "当前轮次生成中",
    "tokenLive.state.completed": "当前轮次已完成",
    "tokenLive.state.unavailable": "实时数据暂不可用",
    "terminal.exited": "[进程已退出，退出码 {exitCode}]",
    "terminal.imagePasteFailed": "[图片粘贴失败: {message}]",
    "composer.inputLabel": "终端输入",
    "composer.placeholder": "输入内容，使用 @ 引用工作区文件...",
    "composer.send": "发送到终端",
    "composer.pasteImage": "上传剪贴板图片",
    "composer.uploadImage": "上传图片",
    "composer.searchWorkspace": "工作区文件与文件夹",
    "composer.searching": "正在搜索工作区...",
    "composer.searchUnavailable": "搜索暂时不可用",
    "composer.noMatches": "没有匹配的文件或文件夹",
    "composer.searchFailed": "搜索失败：{message}",
    "composer.uploadingImage": "正在上传图片...",
    "composer.noClipboardImage": "剪贴板中没有图片",
    "composer.imageUploadFailed": "图片上传失败：{message}",
    "composer.shortcuts": "Enter 发送 · Shift+Enter 换行 · @ 引用文件",
    "composer.shortcutsAgent": "Enter 发送 · Shift+Enter 换行 · @ 引用文件 · 输入 / 使用 Agent 命令联想 · Shift+Tab 切换模式",
    "tabs.files": "文件",
    "tabs.git": "Git",
    "tabs.terminal": "终端",
    "tabs.workspace": "工作区标签",
    "tabs.debug": "Debug",
    "tabs.conversation": "对话",
    "conversation.unread": "有新的 Agent 回复",
    "tabs.idea": "IDEA",
    "idea.subtitle": "运行与调试配置",
    "idea.refresh": "刷新 IDEA 状态",
    "idea.notConnected": "未连接到 IDEA",
    "idea.installHint": "请构建并通过“从磁盘安装插件”安装 Pannel Handle Bridge，然后重启 IDEA。插件 ZIP 位于：",
    "idea.noProjects": "当前 IDEA 中没有已打开的项目。",
    "idea.noConfigurations": "项目中没有可运行的配置。",
    "idea.temporary": "临时",
    "idea.run": "运行",
    "idea.debug": "调试",
    "idea.stop": "停止",
    "idea.stopAll": "全部停止",
    "idea.restart": "重启",
    "idea.all": "全部",
    "idea.parallelBlocked": "此配置不允许并行运行，请先停止或重启现有实例。",
    "idea.status.starting": "启动中",
    "idea.status.running": "运行中",
    "idea.status.stopping": "停止中",
    "idea.status.terminated": "已结束",
    "debug.eventsCount": "{count} 个 hook 事件",
    "debug.clearEvents": "清除事件",
    "debug.providerFilter": "Provider 过滤",
    "debug.allInstances": "全部实例",
    "debug.noMatchedSession": "无匹配会话",
    "debug.noEvents": "暂无 hook 事件",
    "debug.handled": "已处理",
    "debug.unhandled": "未处理",
    "files.title": "文件",
    "files.noSession": "未选择会话",
    "files.availableAfterSession": "选择会话后可浏览文件。",
    "files.parentDirectory": "上级目录",
    "files.openInExplorer": "在资源管理器中打开",
    "files.directoryPath": "目录路径",
    "files.changeRoot": "更换文件根目录",
    "files.searchPlaceholder": "搜索当前目录...",
    "files.clearSearch": "清除搜索",
    "files.onlyLocalFiles": "只能上传本地文件。",
    "files.cannotResolveLocalPaths": "无法识别拖放的文件来源，仅支持从文件资源管理器拖入本地文件。",
    "files.uploading": "正在上传 {count} 个文件...",
    "files.preparingDownload": "正在准备下载...",
    "files.downloadCompleted": "下载完成",
    "files.downloadCanceled": "已取消",
    "files.downloadFailed": "下载失败",
    "files.loading": "正在加载文件...",
    "files.emptyDirectory": "目录为空",
    "files.noMatches": "当前目录没有匹配的文件。",
    "files.folder": "文件夹",
    "files.addToTerminal": "添加到终端",
    "files.addToGraphicalInput": "添加到输入框",
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
    "files.languageMode": "语言模式",
    "files.languageAuto": "自动识别",
    "files.languageAutoDetected": "自动识别（{language}）",
    "files.languagePlainText": "纯文本",
    "files.deleteEntry": "删除",
    "files.selectedItems": "{count} 项",
    "files.cannotMoveIntoSelf": "无法将 {name} 移入其自身。",
    "files.tooLarge": "文件大小为 {size}。请下载后在本地查看。",
    "files.binary": "二进制文件。请下载后在本地查看。",
    "files.loadingOfficePreview": "正在加载 Office 预览...",
    "files.officeLoadFailed": "无法加载 Office 预览。",
    "files.officeUnsupportedHint": "文件可能已损坏、加密，或包含暂不支持的内容。",
    "files.officeWorksheets": "工作表",
    "files.officeSpreadsheetTruncated": "工作表较大，仅显示前 10,000 个单元格范围。",
    "files.officeEmptyWorkbook": "工作簿中没有可预览的工作表。",
    "files.previewMode": "预览模式",
    "files.editMode": "编辑模式",
    "files.newFile": "新建文件",
    "files.newDirectory": "新建文件夹",
    "files.enableAutoCollapse": "开启自动折叠单目录链",
    "files.disableAutoCollapse": "关闭自动折叠单目录链",
    "files.back": "后退",
    "files.forward": "前进",
    "files.sortBy": "文件排序",
    "files.sortNameAsc": "名称升序",
    "files.sortNameDesc": "名称降序",
    "files.sortModified": "最近修改",
    "files.sortSize": "大小降序",
    "files.rename": "重命名",
    "files.name": "名称",
    "files.move": "移动",
    "files.copyPath": "复制路径",
    "files.copyName": "复制文件名",
    "files.targetDirectory": "目标目录",
    "files.nameConflict": "目标中已存在同名项目",
    "files.overwrite": "覆盖",
    "files.skip": "跳过",
    "files.autoRename": "自动重命名",
    "files.saveAs": "另存为",
    "files.forceOverwrite": "保留本地并覆盖",
    "files.localChanges": "本地修改",
    "files.remoteChanges": "磁盘最新内容",
    "files.transfers": "文件传输",
    "files.clearCompleted": "清除已完成",
    "files.noTransfers": "暂无文件传输任务。",
    "files.activeTransfers": "{count} 个任务进行中",
    "files.transferHistory": "最近 {count} 个任务",
    "files.closeGuardTitle": "退出前处理文件工作区",
    "files.unsavedFiles": "未保存文件",
    "files.activeTransfersExit": "退出将取消仍在进行或排队的文件传输。",
    "files.discardAndExit": "放弃并退出",
    "files.saveAllAndExit": "全部保存并退出",
    "files.closeSshTransfers": "该 SSH 会话仍有文件传输。确定取消这些任务并关闭会话吗？",
    "tabs.monitor": "监控",
    "system.sampledAt": "采样时间：{time}",
    "system.memory": "内存",
    "system.network": "网络",
    "system.disk": "磁盘",
    "system.download": "下载",
    "system.upload": "上传",
    "system.ioBusy": "I/O 忙碌",
    "system.read": "读取",
    "system.write": "写入",
    "system.loading": "正在读取服务器状态...",
    "system.unavailable": "服务器监控不可用",
    "system.metrics": "SSH 服务器指标",
    "system.networkTitle": "网络：下载 {download}，上传 {upload}",
    "system.cpuTitle": "CPU：当前利用率 {percent}",
    "system.diskTitle": "磁盘 {mountPoint}：已用 {usedPercent}%，剩余 {available}；I/O 忙碌 {ioBusy}，读 {read}，写 {write}",
    "system.diskMissing": "未找到磁盘指标",
    "system.diskLabel": "磁盘 --",
    "system.diskRemaining": "余 {available}",
    "system.diskSelect": "选择要展示的磁盘，当前为 {mountPoint}",
    "system.diskListTitle": "全部磁盘目录",
    "system.diskUsage": "已用 {used} / {total}，剩余 {available}",
    "system.diskIo": "I/O 忙碌 {busy}，读 {read}，写 {write}",
    "system.memoryTitle": "内存：已用 {used} / {total}，{percent}",
    "system.historyChart": "{metric} 最近 5 分钟利用率，当前 {percent}",
    "system.networkHistoryChart": "网络最近 5 分钟速率，当前下载 {download}，上传 {upload}",
    "system.collectingHistory": "正在积累历史数据...",
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
    "picker.frequent": "常用",
    "picker.deleteFromLibrary": "从库中删除",
    "picker.duplicateSession": "复制会话",
    "picker.editSession": "编辑会话",
    "picker.confirmDelete": "再次点击确认删除",
    "picker.startFresh": "重新开始",
    "picker.launchSelected": "启动所选 ({count})",
    "picker.launching": "启动中...",
    "picker.launchFailed": "启动会话失败",
    "picker.sessionTemplatesTab": "会话模板",
    "picker.launchTemplatesTab": "开启模板",
    "launchTemplate.name": "名称",
    "launchTemplate.namePlaceholder": "例如：日常开发",
    "launchTemplate.nameExists": "开启模板名称已存在",
    "launchTemplate.selectedMembers": "启动顺序（可拖拽）",
    "launchTemplate.noMembersSelected": "尚未选择会话模板",
    "launchTemplate.members": "选择会话模板",
    "launchTemplate.description": "保存常用会话组合，并按配置顺序一键开启。",
    "launchTemplate.new": "新建开启模板",
    "launchTemplate.partialFailure": "有 {count} 个会话模板启动失败",
    "launchTemplate.empty": "还没有开启模板",
    "launchTemplate.noMembers": "未配置会话模板",
    "launchTemplate.memberCount": "{count} 个会话模板",
    "launchTemplate.launch": "开启全部会话",
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
    "hooks.codebuddyTrustNote": "CodeBuddy 首次使用项目 Hook 时，仍需在 CodeBuddy 的 /hooks 中审核并确认。Hook 功能目前为 Beta。",
    "hooks.installing": "安装中...",
    "hooks.installOrRepair": "安装或修复",
    "hooks.install": "安装",
    "hooks.repair": "修复",
    "projectSearch.filesTitle": "搜索文件",
    "projectSearch.textTitle": "搜索文本",
    "projectSearch.filesPlaceholder": "输入文件名或路径...",
    "projectSearch.textPlaceholder": "输入要在项目中搜索的文本...",
    "projectSearch.close": "关闭搜索",
    "projectSearch.caseSensitive": "区分大小写",
    "projectSearch.wholeWord": "全词匹配",
    "projectSearch.regex": "使用正则表达式",
    "projectSearch.includeIgnored": "包含已忽略文件",
    "projectSearch.sshTextUnavailable": "SSH 会话暂不支持内容搜索",
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
    "git.selectRepository": "选择 Git 仓库",
    "git.scanRepositories": "重新扫描仓库并刷新状态",
    "git.scanningRepositories": "正在扫描仓库…",
    "git.noRepositories": "当前目录及一级子目录中未发现 Git 仓库",
    "git.workspaceSummary": "{repositories} 个仓库 · {changes} 项修改",
    "git.repositoryLoadFailed": "仓库状态加载失败",
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
    "git.changesTab": "更改",
    "git.historyTab": "历史",
    "git.syncSection": "同步",
    "git.commitSection": "提交",
    "git.changesSection": "变更",
    "git.expandSection": "展开{section}",
    "git.collapseSection": "收起{section}",
    "git.stagedCount": "{count} 个已暂存",
    "git.commitDraftPresent": "有草稿",
    "git.changeCount": "{count} 个文件",
    "git.diffTruncated": "差异过大，已显示安全范围内的预览。请在终端中审阅完整差异。",
    "git.stashManager": "储藏管理",
    "git.stashMessage": "储藏说明（可选）",
    "git.createStash": "创建储藏",
    "git.preview": "预览",
    "git.drop": "删除",
    "git.statusModified": "已修改",
    "git.statusAdded": "已添加",
    "git.statusDeleted": "已删除",
    "git.statusRenamed": "已重命名",
    "git.statusCopied": "已复制",
    "git.statusConflict": "存在冲突",
    "git.statusTypeChanged": "类型已更改",
    "git.statusUntracked": "未跟踪",
    "git.cancelOperation": "取消操作",
    "git.details": "详情",
    "git.operationSucceeded": "操作已完成。",
    "git.operationFailed": "操作失败。",
    "git.operationState": "仓库正在执行 {state}",
    "git.operationStateGuidance": "可继续审阅和暂存；请在对应终端中继续或中止该操作。",
    "git.createBranch": "新建分支",
    "git.branchName": "输入新分支名称",
    "git.createAndCheckout": "新建并切换",
    "git.detachedHead": "游离 HEAD",
    "git.unbornBranch": "尚无提交",
    "git.noBranch": "未识别当前分支",
    "git.noUpstream": "未设置上游",
    "git.selectRemote": "选择远端",
    "git.noRemotes": "没有远端",
    "git.fetch": "获取",
    "git.pull": "拉取",
    "git.push": "推送",
    "git.commitSubject": "提交标题",
    "git.commitBody": "提交正文（可选）",
    "git.commitChanges": "提交已暂存更改",
    "git.conflicts": "冲突",
    "git.stageResolved": "暂存已解决文件",
    "git.stagedChanges": "已暂存的更改",
    "git.workingChanges": "未暂存的更改",
    "git.unstage": "取消暂存",
    "git.unstageAll": "全部取消暂存",
    "git.stage": "暂存",
    "git.stageAll": "全部暂存",
    "git.discardTitle": "放弃工作区更改",
    "git.deleteUntrackedConfirm": "永久删除未跟踪文件 {file}？此操作无法由应用恢复。",
    "git.discardWorkingConfirm": "放弃 {file} 的未暂存更改？已暂存内容会保留。",
    "git.discard": "放弃",
    "git.recentCommits": "最近提交",
    "git.loadingHistory": "正在加载提交历史...",
    "git.noHistory": "当前 HEAD 没有可显示的提交。",
    "git.loadMore": "加载更多",
    "git.dropStashTitle": "删除储藏",
    "git.dropStashConfirm": "永久删除 {stash}？此操作无法由应用恢复。",
    "theme.darkSlate": "深色石板",
    "theme.darkBlue": "深蓝色",
    "theme.darkGreen": "深绿色",
    "theme.light": "浅色"
  },
  "en-US": {
    "agentCapabilities.pannelHandleRemote": "Pannel Handle Remote Bridge",
    "app.noActiveSession": "No active session",
    "app.openTerminal": "Open terminal",
    "projectAssistant.title": "Project Assistant",
    "projectAssistant.open": "Open project assistant",
    "projectAssistant.newConversation": "New conversation",
    "projectAssistant.description": "View and control running Codex conversations, or ask about local sessions, templates, and usage.",
    "projectAssistant.empty": "Try “What is Codex doing?” or “Ask Codex to continue checking.”",
    "projectAssistant.you": "You",
    "projectAssistant.application": "App",
    "projectAssistant.thinking": "Reading local data and thinking…",
    "projectAssistant.confirm": "Awaiting confirmation",
    "projectAssistant.reject": "Decline",
    "projectAssistant.execute": "Confirm and run",
    "projectAssistant.placeholder": "Ask about Codex progress or describe an action",
    "projectAssistant.stop": "Stop generating",
    "projectAssistant.send": "Send message",
    "projectAssistant.codexSessions": "Live Codex conversation",
    "projectAssistant.selectCodexSession": "Select Codex session",
    "projectAssistant.noCodexSessions": "No running Codex sessions",
    "projectAssistant.switchMode": "Switch Plan / Default mode",
    "projectAssistant.questionHint": "When Codex asks a question, click the terminal above and answer with the keyboard.",
    "projectAssistant.codexPlaceholder": "Enter text for the current Codex session",
    "projectAssistant.sendToCodex": "Send to Codex",
    "codexVersion.title": "Codex CLI updates",
    "codexVersion.checking": "Checking version…",
    "codexVersion.current": "Installed: {version}",
    "codexVersion.latest": "Latest: {version}",
    "codexVersion.unknown": "Installed version unavailable",
    "codexVersion.upToDate": "Up to date",
    "codexVersion.restart": "Update installed. Restart this session to use it.",
    "codexVersion.manual": "Installation source unknown. Update using the original installer.",
    "codexVersion.check": "Check for updates",
    "codexVersion.update": "Update Codex",
    "codexVersion.confirmTitle": "Confirm Codex update",
    "codexVersion.confirm": "Update Codex in {environment} to {version}. The current session will keep running until restarted.",
    "codexVersion.cancel": "Cancel",
    "codexVersion.confirmUpdate": "Confirm update",
    "codexVersion.updating": "Updating Codex…",
    "codexVersion.progress.checking": "Progress: checking installation",
    "codexVersion.progress.installing": "Progress: installing",
    "codexVersion.progress.verifying": "Progress: verifying update",
    "codexVersion.progress.complete": "Update complete",
    "codexVersion.progress.failed": "Update failed",
    "codexVersion.progress.output": "Installation output",
    "codeBuddyVersion.title": "CodeBuddy CLI updates",
    "codeBuddyVersion.update": "Update CodeBuddy",
    "codeBuddyVersion.confirmTitle": "Confirm CodeBuddy update",
    "codeBuddyVersion.confirm": "Update CodeBuddy in {environment} to {version}. The current session will keep running until restarted.",
    "codeBuddyVersion.updating": "Updating CodeBuddy…",
    "projectAssistant.statusUnknown": "Status unknown",
    "sessionOverview.title": "Instance overview",
    "sessionOverview.openOverview": "Open instance overview",
    "sessionOverview.description": "{count} terminal instances open",
    "sessionOverview.empty": "No terminal instances",
    "sessionOverview.emptyHint": "Create or launch a session to see it here.",
    "sessionOverview.selectSession": "Select instance: {name}",
    "sessionOverview.open": "Session open",
    "sessionOverview.connecting": "SSH connecting",
    "sessionOverview.connected": "SSH connected",
    "sessionOverview.reconnecting": "SSH reconnecting",
    "sessionOverview.disconnected": "SSH disconnected",
    "sessionOverview.noAgent": "No Agent configured",
    "sessionOverview.noAgentStatus": "No Agent status yet",
    "sessionOverview.summary": "Activity summary",
    "sessionOverview.noSummary": "No activity summary yet",
    "settings.title": "Settings",
    "settings.subtitle": "Manage app behavior, model services, and local connections",
    "settings.categories": "Settings categories",
    "settings.generalDescription": "Configure terminal startup, appearance, and diagnostics.",
    "settings.environmentTitle": "Environment variables",
    "settings.environmentNavDescription": "Manage reusable non-secret environment variables for sessions.",
    "settings.modelsTitle": "Model services",
    "settings.modelsDescription": "Configure provider credentials, online models, and defaults.",
    "settings.mobileNavDescription": "Configure LAN access, the device password, and connection security.",
    "settings.notificationsTitle": "Notifications",
    "settings.notificationsDescription": "Configure external notifications for session states.",
    "settings.environmentProfiles": "Profiles",
    "settings.environmentProfileCount": "{count} profiles",
    "settings.environmentNewProfile": "New profile",
    "settings.environmentNewProfileHint": "Create a reusable variable set",
    "settings.environmentVariableCount": "{count} variables",
    "settings.environmentReferenceCount": "{count} references",
    "settings.environmentDescription": "Non-secret values are stored locally as plain text. Changes apply when a session is next launched.",
    "settings.environmentUnsaved": "Unsaved",
    "settings.environmentProfileName": "Profile name",
    "settings.environmentProfileNamePlaceholder": "For example: Local development proxy",
    "settings.environmentVariables": "Environment variables",
    "settings.environmentAddVariable": "Add variable",
    "settings.environmentVariableName": "Variable name",
    "settings.environmentVariableValue": "Value",
    "settings.environmentRemoveVariable": "Remove variable",
    "settings.environmentEmpty": "This profile has no environment variables yet.",
    "settings.environmentAddFirstVariable": "Add the first variable",
    "settings.environmentPasteTitle": "Paste KEY=VALUE in bulk",
    "settings.environmentPasteHint": "Enter one variable per line. Blank lines and comments beginning with # are ignored.",
    "settings.environmentPasteAria": "Bulk environment variables",
    "settings.environmentAppend": "Append to variables",
    "settings.environmentPasteError": "Each line must use KEY=VALUE.",
    "settings.environmentReferencedBy": "Referenced by sessions",
    "settings.environmentReferenceSeparator": ", ",
    "settings.environmentDeleteReferencedHint": "Remove every session reference before deleting this profile.",
    "settings.environmentSave": "Save profile",
    "settings.environmentCopy": "Duplicate profile",
    "settings.environmentDelete": "Delete profile",
    "settings.environmentConfirmDelete": "Confirm deletion",
    "settings.environmentSaved": "Saved. Changes apply when a session is next launched.",
    "settings.environmentDeleted": "Profile deleted.",
    "settings.environmentCopySuffix": " - Copy",
    "settings.environmentUnsavedTitle": "Save environment changes?",
    "settings.environmentUnsavedDescription": "The current profile has unsaved changes. Save them before continuing, or discard them and continue with the previous action.",
    "settings.environmentSaveAndContinue": "Save and continue",
    "settings.environmentDiscardAndContinue": "Discard changes",
    "settings.environmentKeepEditing": "Keep editing",
    "settings.mobileTitle": "LAN Mobile Terminal",
    "settings.mobileRunning": "Running",
    "settings.mobileStopped": "Stopped",
    "settings.mobileHttpWarning": "Traffic, including the mobile access password, is sent over unencrypted HTTP. Enable this only on a trusted private LAN and never expose it to the Internet.",
    "settings.mobileInterface": "LAN adapter",
    "settings.mobilePort": "Port",
    "settings.mobilePassword": "Mobile access password (8–128 characters)",
    "settings.mobileSetPassword": "Set password",
    "settings.mobileChangePassword": "Change password",
    "settings.mobilePasswordSet": "Password is set. Changing it disconnects all mobile connections.",
    "settings.mobilePasswordNeeded": "Set a password before enabling mobile access.",
    "settings.mobilePasswordSaved": "Password saved. Active connections were disconnected.",
    "settings.mobileOpenHint": "Open either of the first two LAN addresses on your phone, or the 127.0.0.1 address on this computer. Enter the mobile password to connect.",
    "settings.mobileActiveDevice": "Active connections",
    "settings.mobileDisconnect": "Disconnect",
    "settings.mobileNoActiveDevice": "No mobile device is online.",
    "settings.mobileAudit": "Security events",
    "settings.open": "Open settings",
    "settings.generalTitle": "General settings",
    "settings.autoRestore": "Auto restore on startup",
    "session.graphicalMode": "Use graphical session",
    "session.graphicalModeHint": "Checked uses {mode}; unchecked uses the terminal. Applies to future sessions started from this template.",
    "settings.autoWorkBuddyCheckin": "CodeBuddy automatic check-in",
    "settings.debugMode": "Debug mode",
    "settings.screenshotTitle": "Screenshot",
    "settings.screenshotDescription": "Open the Windows region snipping UI and copy the result to the system clipboard.",
    "settings.screenshotEnabled": "Enable screenshots",
    "settings.screenshotShortcut": "Screenshot shortcut",
    "settings.screenshotShortcutRecording": "Press a new shortcut…",
    "settings.screenshotShortcutHint": "Use Ctrl, Alt, or Shift with a letter, number, or F1-F12. Press Esc to cancel.",
    "settings.screenshotShortcutReserved": "That shortcut is already used by the app. Choose another one.",
    "settings.screenshotShortcutModifierRequired": "The shortcut must include Ctrl, Alt, or Shift.",
    "settings.screenshotShortcutUnsupported": "Use a modifier with a letter, number, or F1-F12.",
    "settings.terminalBackgroundTitle": "Terminal background",
    "settings.terminalBackgroundDescription": "Set a shared background image for all terminals, with opacity and blur controls.",
    "settings.terminalBackgroundChoose": "Choose image",
    "settings.terminalBackgroundClear": "Clear",
    "settings.terminalBackgroundOpacity": "Opacity",
    "settings.terminalBackgroundBlur": "Blur",
    "settings.terminalBackgroundNone": "No background image set",
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
    "settings.openRouterConfigured": "API key configured",
    "settings.openRouterNotConfigured": "Not configured",
    "settings.openRouterDescription": "Use OpenRouter as the model backend for Codex. The API key is encrypted by the system secure store and injected only into the launched process environment.",
    "settings.openRouterKeyStored": "Stored securely; enter a new value to replace it",
    "settings.openRouterSaved": "OpenRouter API key saved securely.",
    "settings.openRouterTest": "Test connection",
    "settings.openRouterTestSuccess": "OpenRouter connection succeeded.",
    "settings.openRouterClear": "Clear API key",
    "settings.openRouterCleared": "OpenRouter API key cleared.",
    "settings.openRouterRefreshModels": "Refresh online models",
    "settings.openRouterModelsRefreshed": "OpenRouter model catalog refreshed.",
    "settings.openRouterFavorites": "Compatible models and favorites",
    "settings.openRouterFreeModelsOnly": "Free models only",
    "settings.openRouterNoMatchingModels": "No matching compatible models.",
    "settings.openRouterDefaultModel": "Set as default model",
    "settings.openRouterRefreshHint": "Refresh the online catalog first. Only models supporting tools and tool_choice are shown.",
    "settings.openRouterSaveFavorites": "Save favorites and default",
    "settings.openRouterFavoritesSaved": "OpenRouter favorite models saved.",
    "settings.openRouterNewSessionsHint": "Catalog changes apply to newly launched sessions. In a running session, use Codex's native /model command to switch within this catalog.",
    "settings.openRouterPriceInput": "input",
    "settings.openRouterPriceOutput": "output",
    "settings.openRouterPriceUnavailable": "Pricing unavailable",
    "settings.openRouterVerificationPending": "Not verified",
    "settings.openRouterVerificationPassed": "Verified",
    "settings.openRouterVerificationPartial": "Partially compatible",
    "settings.openRouterVerificationFailed": "Verification failed",
    "settings.openRouterVerificationUnavailable": "Temporarily unavailable",
    "settings.openRouterVerificationPartialSuccess": "Function tools passed; the full Codex tool protocol failed or could not be confirmed yet. This model can be used experimentally.",
    "settings.openRouterVerificationPartialRateLimit": "Function tools passed; the full Codex tool protocol could not be confirmed because the upstream provider was rate limited. This model can be used experimentally.",
    "settings.openRouterResponsesRejected": "This model did not pass the Responses request required by Codex. Choose another model.",
    "settings.openRouterProviderDetail": "Provider details",
    "settings.openRouterStageResponses": "Basic Responses",
    "settings.openRouterStageFunctionTools": "Function tools",
    "settings.openRouterStageCodexTools": "Full Codex tool protocol",
    "settings.openRouterVerifyRetry": "Verify",
    "settings.openRouterVerifying": "Verifying…",
    "settings.openRouterVerificationSuccess": "OpenRouter model compatibility verified.",
    "settings.openRouterRateLimitHint": "The OpenRouter request was rate limited. Free-model frequency or daily limits may be exhausted. Retry after 60 seconds; if it still fails, wait for the quota to reset, add OpenRouter credits, or choose another model.",
    "settings.naraRouterDescription": "Use NaraRouter as the model backend for Codex. The API key is encrypted by the system secure store and injected only into the launched process environment.",
    "settings.naraRouterSaved": "NaraRouter API key saved securely.",
    "settings.naraRouterTestSuccess": "NaraRouter connection succeeded.",
    "settings.naraRouterCleared": "NaraRouter API key cleared.",
    "settings.naraRouterModelsRefreshed": "NaraRouter model catalog refreshed.",
    "settings.naraRouterFavoritesSaved": "NaraRouter favorite models saved.",
    "settings.naraRouterRefreshHint": "Configure an API key and refresh the online models available to this account.",
    "settings.naraRouterVerificationSuccess": "NaraRouter model compatibility verified.",
    "settings.naraRouterRateLimitHint": "The NaraRouter request was rate limited. This model tier may have reached its request or daily quota; retry after 60 seconds or choose another available model.",
    "settings.miniMaxDescription": "Use MiniMax as the Codex model backend with either a Token Plan key or a pay-as-you-go API key. The key is encrypted locally.",
    "settings.miniMaxSaved": "MiniMax API key saved securely.",
    "settings.miniMaxTestSuccess": "MiniMax connection succeeded.",
    "settings.miniMaxCleared": "MiniMax API key cleared.",
    "settings.miniMaxModelsRefreshed": "MiniMax model catalog refreshed.",
    "settings.miniMaxFavoritesSaved": "MiniMax favorite models saved.",
    "settings.miniMaxRefreshHint": "Configure an API key and refresh the online models available to this key.",
    "settings.miniMaxVerificationSuccess": "MiniMax model compatibility verified.",
    "settings.miniMaxRateLimitHint": "The MiniMax request was rate limited. Wait for the rate or Token Plan quota window to recover, then retry.",
    "settings.codeBuddyCodexTitle": "CodeBuddy Codex",
    "settings.codeBuddyCodexNotConfigured": "Not configured",
    "settings.codeBuddyCodexDescription": "Load and verify CodeBuddy models once in Settings. Session forms only read saved models and never run live verification.",
    "settings.codeBuddyCodexRefreshModels": "Refresh local models",
    "settings.codeBuddyCodexModelsRefreshed": "CodeBuddy model catalog refreshed.",
    "settings.codeBuddyCodexModels": "Verified models and favorites",
    "settings.codeBuddyCodexVerified": "Verified",
    "settings.codeBuddyCodexVerificationPending": "Not verified",
    "settings.codeBuddyCodexVerificationFailed": "Verification failed",
    "settings.codeBuddyCodexVerificationSuccess": "CodeBuddy model compatibility verified.",
    "settings.codeBuddyCodexVerify": "Verify",
    "settings.codeBuddyCodexVerifying": "Verifying…",
    "settings.codeBuddyCodexDefaultModel": "Set as default model",
    "settings.codeBuddyCodexRefreshHint": "Refresh the local CodeBuddy model catalog first.",
    "settings.codeBuddyCodexSaveFavorites": "Save favorites and default",
    "settings.codeBuddyCodexFavoritesSaved": "CodeBuddy favorite models saved.",
    "settings.codeBuddyCodexAcknowledge": "I understand this private bridge does not assume CLI version compatibility; after an upgrade, unchanged models that already passed verification remain available, while new models still require verification.",
    "settings.codeBuddyCodexAcknowledgementSaved": "CodeBuddy experimental acknowledgement updated.",
    "settings.codeBuddyCodexNewSessionsHint": "Sessions can only select verified favorites saved here. CLI version changes preserve verification, favorites, and risk acknowledgement for unchanged models.",
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
    "confirm.trashEntry": "Move \"{name}\" to the Recycle Bin?",
    "confirm.deleteEntries": "Delete the {count} selected items? This cannot be undone.",
    "confirm.trashEntries": "Move the {count} selected items to the Recycle Bin?",
    "window.minimize": "Minimize",
    "window.maximize": "Maximize",
    "window.restore": "Restore",
    "window.close": "Close",
    "screenshot.capture": "Region screenshot",
    "screenshot.captureFailed": "Could not start region screenshot: {message}",
    "sidebar.title": "Command Sessions",
    "sidebar.count": "{count} windows",
    "sidebar.countFiltered": "{count} windows / showing {filtered}",
    "sidebar.openLibrary": "Launch from library",
    "sidebar.newSession": "New session",
    "sidebar.searchPlaceholder": "Search sessions...",
    "sidebar.clearSearch": "Clear search",
    "sidebar.empty": "No matching sessions",
    "sidebar.installHooks": "Install project hooks",
    "sidebar.duplicateSession": "Duplicate and start in background",
    "sidebar.duplicatingSession": "Duplicating session",
    "sidebar.editSession": "Edit session",
    "sidebar.closeSession": "Close",
    "sidebar.confirmClose": "Click again to confirm close",
    "sidebar.sshConnecting": "Connecting to SSH",
    "sidebar.sshReconnecting": "Reconnecting to SSH (attempt {attempt})",
    "sidebar.sshDisconnected": "SSH disconnected",
    "sidebar.sshReconnectNow": "Reconnect SSH now",
    "session.newTitle": "New Session",
    "session.editTitle": "Edit Session",
    "session.newSubtitle": "Configure the terminal, working directory, and Agent",
    "session.editSubtitle": "Update session details and launch settings",
    "session.basicSection": "Session details",
    "session.connectionSection": "SSH connection",
    "session.startupSection": "Startup command",
    "session.environment": "Environment variables",
    "session.environmentHint": "Manage profiles in Settings. Session variables override values with the same name and apply on the next launch.",
    "session.environmentProfile": "Profile",
    "session.environmentProfileNone": "Do not use a profile",
    "session.environmentPreview": "Variables to inject (excluding inherited system values)",
    "session.environmentVariable": "Variable",
    "session.environmentValue": "Value",
    "session.environmentSource": "Source",
    "session.environmentEmptyValue": "(empty string)",
    "session.environmentPrecedenceHint": "App runtime and model service variables take precedence. Shell startup scripts can still modify the environment. Only plain configuration is stored; secrets are not supported.",
    "session.environmentLocalSshHint": "Variables are injected into the local Agent process.",
    "session.environmentRemoteSshHint": "Remote injection supports Linux and Bash only and does not affect SFTP or standalone background commands.",
    "session.configured": "Configured",
    "session.notConfigured": "Not configured",
    "session.itemsConfigured": "{count} configured",
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
    "session.remoteCwd": "Remote working directory",
    "session.remotePlatform": "Remote operating system",
    "session.remotePlatformAuto": "Auto-detect",
    "session.localAgentCwd": "Local Agent working directory (optional)",
    "session.localAgentCwdPlaceholder": "Use the app-managed temporary directory when empty",
    "session.localAgentCwdHint": "The local Agent starts here; remote operations remain scoped to the remote working directory.",
    "session.initialCommand": "Initial command",
    "session.initialCommandPlaceholder": "Enter an optional initial command, for example: {example}",
    "session.agentCli": "Agent CLI",
    "session.normalTerminal": "Terminal",
    "session.quickAgent": "Quick-create local Agent session",
    "session.quickAgentMenu": "Choose local Agent",
    "agentSwitch.title": "Switch the Agent in this session",
    "agentSwitch.menu": "Choose an Agent to switch to",
    "agentSwitch.switching": "Switching to {provider}",
    "agentSwitch.localSshUnavailable": "Local SSH bridge sessions can only switch between Codex, CodeBuddy, and OpenCode",
    "codexBackendSwitch.title": "Switch the model backend for this Codex session",
    "codexBackendSwitch.menu": "Choose a Codex model backend",
    "codexBackendSwitch.switching": "Switching to {backend}",
    "session.agentCwdRequired": "A project working directory is required when an Agent CLI is selected.",
    "settings.defaultWindowsShell": "Default Windows shell",
    "settings.defaultWindowsShellHint": "Applies to new sessions after saving. Existing sessions and templates keep their shell. PowerShell 7 requires a separate installation.",
    "session.defaultShell": "Default ({shell})",
    "session.shellSyntaxHint": "Use {shell} syntax. The selected CLI startup command is appended automatically.",
    "session.preLaunchCommand": "Command before CLI startup",
    "session.codexBackend": "Codex model backend",
    "session.codexBackendOpenAI": "OpenAI (Codex default)",
    "session.codexModel": "Default OpenRouter model",
    "session.codexModelSelect": "Select a favorite model",
    "session.openRouterKeyRequired": "Configure an OpenRouter API key in Settings first.",
    "session.openRouterFavoriteRequired": "Favorite a compatible model and select a default in Settings first.",
    "session.openRouterModelHint": "After launch, use Codex's native /model command to switch among favorite models.",
    "session.openRouterVerifiedRequired": "Verify and save at least one compatible model in Settings first.",
    "session.openRouterExperimentalAcknowledge": "This model is only partially compatible. I understand Codex may fail on its first request or while editing, and accept experimental launch.",
    "session.openRouterExperimentalRequired": "Acknowledge the experimental risk for this partially compatible model first.",
    "session.naraRouterModel": "Default NaraRouter model",
    "session.naraRouterKeyRequired": "Configure a NaraRouter API key in Settings first.",
    "session.naraRouterFavoriteRequired": "Favorite a compatible model and select a default in Settings first.",
    "session.naraRouterModelHint": "After launch, use Codex's native /model command to switch among favorite models.",
    "session.naraRouterVerifiedRequired": "Verify and save at least one compatible model in Settings first.",
    "session.miniMaxModel": "Default MiniMax model",
    "session.miniMaxKeyRequired": "Configure a MiniMax API key in Settings first.",
    "session.miniMaxFavoriteRequired": "Favorite a compatible model and select a default in Settings first.",
    "session.miniMaxModelHint": "After launch, use Codex's native /model command to switch among favorite MiniMax models.",
    "session.miniMaxVerifiedRequired": "Verify and save at least one compatible model in Settings first.",
    "session.codeBuddyCodexModel": "CodeBuddy model",
    "session.codeBuddyCodexConfigRequired": "Verify and favorite CodeBuddy models and acknowledge the experimental risk in Settings first.",
    "session.codeBuddyCodexModelHint": "Only verified favorites from global Settings are shown.",
    "session.agentLocation": "Agent location",
    "session.agentLocationLocal": "Local bridge",
    "session.agentLocationRemote": "Run remotely",
    "session.agentLocationLocalHint": "Run Codex, CodeBuddy, or OpenCode locally and operate the SSH workspace through a scoped bridge",
    "session.agentLocationUnsupported": "The local bridge only supports Codex, CodeBuddy, and OpenCode",
    "remoteAgent.auditTitle": "Remote operations",
    "remoteAgent.auditEphemeral": "Current session only",
    "remoteAgent.auditWaiting": "Waiting for the Agent to call a remote tool…",
    "remoteAgent.approvalTitle": "Allow the Agent to operate the remote server?",
    "remoteAgent.approvalSource": "From {source}",
    "remoteAgent.approvalRemaining": "{count} more pending",
    "remoteAgent.approvalDeny": "Deny",
    "remoteAgent.approvalOnce": "Allow once",
    "remoteAgent.approvalSession": "Allow for session",
    "remoteAgent.approvalFailed": "This approval request has expired. Try again.",
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
    "quickCommand.more": "More",
    "quickCommand.dialog": "All quick commands",
    "quickCommand.empty": "No quick commands yet. Add a temporary command below.",
    "quickCommand.pin": "Pin",
    "quickCommand.unpin": "Unpin",
    "quickCommand.pinLimit": "You can pin up to 3 commands",
    "tag.remove": "Remove tag {tag}",
    "tag.placeholderEmpty": "Enter a tag, press Enter to add",
    "tag.placeholderAdd": "Add tag",
    "agent.waitingForPermission": "{agent} waiting for confirmation",
    "agent.waitingForPermissionTool": "{agent} waiting for confirmation: {tool}",
    "agent.waitingForAnswer": "{agent} waiting for an answer",
    "agent.waitingForPlanConfirmation": "{agent} waiting for plan confirmation",
    "agent.idlePrompt": "{agent} idle",
    "agent.completed": "{agent} completed",
    "agent.failed": "{agent} failed",
    "agent.running": "{agent} running",
    "agent.ended": "{agent} ended",
    "agent.exited": "Process exited",
    "agent.openCodeEmptyResponse": "OpenCode returned an empty response after the remote tool completed successfully. The bridge is working; switch models in OpenCode, enter /compact, or start a new session and retry.",
    "usage.loading": "Reading Codex usage...",
    "usage.unavailable": "Codex usage unavailable",
    "usage.retry": "Retry Codex usage",
    "usage.remaining": "Codex {remaining}% left",
    "usage.title": "Codex usage",
    "usage.refresh": "Refresh usage",
    "usage.refreshing": "Refreshing",
    "usage.close": "Close usage details",
    "usage.limitRemaining": "{remaining}% remaining",
    "usage.used": "{used}% used",
    "usage.resetsAt": "Resets {time}",
    "usage.resetUnavailable": "Reset time unavailable",
    "usage.resetCreditsTitle": "Reset credits",
    "usage.resetCreditsAvailable": "{count} available",
    "usage.resetCreditsEmpty": "No reset credits available",
    "usage.resetCreditFallback": "Reset credit",
    "usage.resetCreditGrantedAt": "Granted {time}",
    "usage.resetCreditGrantedLabel": "Granted",
    "usage.resetCreditExpiresLabel": "Expires",
    "usage.resetCreditExpiresAt": "Expires {time}",
    "usage.resetCreditNoExpiration": "No expiration",
    "usage.resetCreditStatus.available": "Available",
    "usage.resetCreditStatus.redeeming": "Redeeming",
    "usage.resetCreditStatus.redeemed": "Redeemed",
    "usage.resetCreditStatus.unknown": "Status unknown",
    "usage.resetCreditDetailsUnavailable": "Codex returned only the available count, so no reset credit can be selected yet",
    "usage.resetCreditAction": "Reset limits",
    "usage.resetCreditConfirm": "Click again to confirm",
    "usage.resetCreditResetting": "Resetting...",
    "usage.resetCreditRetry": "Retry reset",
    "usage.resetCreditSuccess": "Codex usage limits were reset",
    "usage.resetCreditAlreadyRedeemed": "This reset already completed",
    "usage.resetCreditNothingToReset": "No eligible rate-limit window needs a reset",
    "usage.resetCreditNoCredit": "No reset credit is currently available",
    "usage.resetCreditFailed": "Reset failed: {message}",
    "usage.resetCreditRefreshFailed": "{result}, but refreshing the latest limits failed: {message}",
    "usage.updatedAt": "Updated {time}",
    "usage.codebuddyLoading": "Reading CodeBuddy quota...",
    "usage.codebuddyUnavailable": "CodeBuddy quota unavailable",
    "usage.codebuddyRetry": "Retry CodeBuddy quota",
    "usage.codebuddyRemaining": "CodeBuddy {remaining} Credits left",
    "usage.codebuddyTitle": "CodeBuddy quota",
    "usage.codebuddyTotal": "Total available quota",
    "usage.qoderLoading": "Reading Qoder quota...",
    "usage.qoderUnavailable": "Qoder quota unavailable",
    "usage.qoderRetry": "Sign in or update Qoder CLI, then retry",
    "usage.qoderRemaining": "Qoder {remaining} Credits left",
    "usage.qoderTitle": "Qoder quota",
    "usage.geminiLoading": "Reading Gemini quota...",
    "usage.geminiUnavailable": "Gemini quota unavailable",
    "usage.geminiRetry": "Gemini quota unavailable. Click to retry.",
    "usage.geminiTitle": "Gemini quota",
    "usage.qoderTotal": "Total available quota",
    "usage.miniMaxLoading": "Reading MiniMax quota...",
    "usage.miniMaxUnavailable": "MiniMax quota unavailable",
    "usage.miniMaxRetry": "Retry MiniMax quota",
    "usage.miniMaxRemaining": "MiniMax {remaining}% left",
    "usage.miniMaxTitle": "MiniMax quota",
    "usage.miniMaxBalance": "MiniMax available balance ¥{available}",
    "usage.miniMaxBalanceDetails": "Cash ¥{cash} · vouchers ¥{voucher} · credit ¥{credit} · owed ¥{owed}",
    "usage.unlimited": "Unlimited",
    "usage.notInPlan": "Not in current plan",
    "usage.copilotUnavailable": "GitHub Copilot does not expose a stable account quota API",
    "usage.grokUnavailable": "Grok CLI does not expose a stable account quota API",
    "usage.qoderActivities": "Promotional quota",
    "usage.qoderActivityUnavailable": "Promotional quota is unavailable. Refresh to retry.",
    "usage.qoderActivityEmpty": "No promotional quota is currently available",
    "usage.activityUsed": "{used} / {total} Credits",
    "usage.activityRemaining": "{remaining} Credits left",
    "usage.activityExpiresAt": "Ends at {time}",
    "usage.activityNoExpiration": "No expiration reported",
    "usage.creditRemaining": "{remaining} / {total} Credits left",
    "usage.creditUsed": "{used} / {total} Credits used",
    "usage.expiresAt": "Expires {time}",
    "usage.expirationUnavailable": "Expiration unavailable",
    "usage.noCreditResources": "No available credit packages",
    "usage.category.base": "Base plan",
    "usage.category.extra": "Add-on packages",
    "usage.category.bonus": "Bonus credits",
    "usage.category.organization": "Organization resource package",
    "usage.category.other": "Other credits",
    "usage.resourceUnavailable": "Currently unavailable",
    "usage.workbuddyCheckinTitle": "WorkBuddy daily check-in",
    "usage.workbuddyCheckinLoading": "Reading check-in status...",
    "usage.workbuddyCheckinUnavailable": "WorkBuddy check-in is unavailable",
    "usage.workbuddyCheckinRetry": "Retry",
    "usage.workbuddyCheckinInactive": "The daily check-in activity is not active",
    "usage.workbuddyCheckinReward": "Claim {credit} Credits today",
    "usage.workbuddyCheckedIn": "Claimed {credit} Credits today · {days}-day streak",
    "usage.workbuddyCheckinButton": "Check in",
    "usage.workbuddyCheckedInButton": "Checked in today",
    "usage.workbuddyCheckingIn": "Checking in...",
    "tokenStats.title": "Token statistics",
    "tokenStats.open": "Open token statistics",
    "tokenStats.description": "Review session usage, trends, and details for OpenCode and other supported agents",
    "tokenStats.range": "Statistics date range",
    "tokenStats.last7Days": "Last 7 days",
    "tokenStats.last30Days": "Last 30 days",
    "tokenStats.allTime": "All time",
    "tokenStats.provider": "Agent provider",
    "tokenStats.allProviders": "All agents",
    "tokenStats.clear": "Clear statistics",
    "tokenStats.confirmClear": "Click again to clear",
    "tokenStats.total": "Total tokens",
    "tokenStats.sessions": "Sessions",
    "tokenStats.trackedSessions": "Tracked Agent sessions",
    "tokenStats.average": "Average usage",
    "tokenStats.perSession": "Per session",
    "tokenStats.inputOutput": "Input / output",
    "tokenStats.inputOutputHint": "Token composition",
    "tokenStats.input": "Input",
    "tokenStats.cached": "Cached input",
    "tokenStats.output": "Output",
    "tokenStats.dailyTrend": "Daily token trend",
    "tokenStats.noTrend": "No trend data yet",
    "tokenStats.providerCompare": "Agent comparison",
    "tokenStats.sessionsUnit": "sessions",
    "tokenStats.sessionDetails": "Session details",
    "tokenStats.totalRecords": "{count} records",
    "tokenStats.noData": "No token statistics yet",
    "tokenStats.noDataHint": "Start a supported agent from Pannel Handle. Usage appears when the agent reports accurate token data.",
    "tokenStats.time": "Updated",
    "tokenStats.session": "Session",
    "tokenStats.location": "Location",
    "tokenStats.model": "Model",
    "tokenStats.tokens": "Total (input / output)",
    "tokenStats.previous": "Previous",
    "tokenStats.next": "Next",
    "tokenStats.skillCalls": "Skill calls",
    "tokenStats.mcpCalls": "MCP calls",
    "tokenStats.callsUnit": "calls",
    "tokenStats.topSkills": "Top skills",
    "tokenStats.topMcp": "Top MCP servers",
    "tokenStats.skillUsage": "Skill usage",
    "tokenStats.mcpUsage": "MCP usage",
    "tokenStats.expandUsage": "View skills and MCP",
    "tokenStats.collapseUsage": "Hide skills and MCP",
    "tokenStats.capabilityUnavailable": "This transcript does not expose recognizable calls",
    "tokenStats.noSkills": "No skill calls detected in this session",
    "tokenStats.noMcp": "No MCP calls detected in this session",
    "tokenStats.transcriptDetected": "Conservatively detected from the transcript",
    "skills.title": "Skills",
    "skills.open": "Open Skills",
    "skills.description": "Browse Codex and CodeBuddy skills",
    "skills.provider": "Skill provider",
    "skills.search": "Search Skills",
    "skills.empty": "No Skills found",
    "skills.codebuddyEmptyHint": "Add a Skill under ~/.codebuddy/skills to see it here.",
    "skills.codexInheritanceHint": "CodeBuddy sessions started by Pannel Handle also inherit Codex user and project Skills as /codex:name. This page manages native CodeBuddy Skills.",
    "skills.noMatches": "No matching Skills",
    "mcp.title": "MCP Manager",
    "mcp.open": "Open MCP Manager",
    "mcp.description": "View and edit user and project MCP configuration for Codex and CodeBuddy",
    "mcp.codexInheritanceHint": "CodeBuddy sessions started by Pannel Handle inherit Codex user and project MCP servers. Codex wins on name conflicts. This page edits native configuration.",
    "mcp.provider": "MCP provider",
    "mcp.scope": "Configuration scope",
    "mcp.scopeUser": "User",
    "mcp.scopeProject": "Project",
    "mcp.scopeProjectLocal": "Project private",
    "mcp.scopeProjectShared": "Project shared",
    "mcp.projectUnavailable": "Select a running Windows session",
    "mcp.sharedWarning": "This scope modifies a repository configuration file in the current working directory.",
    "mcp.search": "Search MCP servers",
    "mcp.add": "Add MCP server",
    "mcp.empty": "No MCP servers in this scope",
    "mcp.noMatches": "No matching MCP servers",
    "mcp.selectHint": "Select or add an MCP server",
    "mcp.newServer": "New MCP server",
    "mcp.name": "Server name",
    "mcp.transport": "Transport",
    "mcp.command": "Command",
    "mcp.args": "Arguments",
    "mcp.argsHint": "One argument per line",
    "mcp.cwd": "Working directory (optional)",
    "mcp.env": "Environment variables",
    "mcp.envKey": "Environment variable name",
    "mcp.url": "Server URL",
    "mcp.bearerEnv": "Bearer token environment variable (optional)",
    "mcp.headers": "HTTP headers",
    "mcp.headerKey": "Header name",
    "mcp.startupTimeout": "Startup timeout (seconds)",
    "mcp.toolTimeout": "Tool timeout (seconds)",
    "mcp.enabled": "Enabled",
    "mcp.disabled": "Disabled",
    "mcp.masked": "Sensitive value hidden",
    "mcp.reveal": "Reveal sensitive value",
    "mcp.saving": "Saving…",
    "mcp.saved": "MCP configuration saved.",
    "mcp.removed": "MCP server removed.",
    "mcp.conflict": "The configuration file changed in another program. Your draft was not written; refresh and try again.",
    "mcp.discardChanges": "This MCP configuration has unsaved changes. Discard them?",
    "mcp.unsavedClose": "The current MCP configuration has unsaved changes.",
    "mcp.confirmDelete": "Delete MCP server “{name}”? You can restore it from the .pannel-handle.bak backup.",
    "mcp.restartHint": "Restart the corresponding Agent session after saving to ensure the new configuration is loaded.",
    "tokenLive.title": "{provider} live tokens",
    "tokenLive.loading": "Reading tokens...",
    "tokenLive.waiting": "Waiting for token data",
    "tokenLive.unavailable": "Tokens unavailable",
    "tokenLive.unavailableHint": "The session transcript is temporarily unavailable. Agent and terminal operation are unaffected.",
    "tokenLive.sessionInput": "Session input",
    "tokenLive.sessionOutput": "Session output",
    "tokenLive.cachedInput": "Cached input",
    "tokenLive.reasoningOutput": "Reasoning output",
    "tokenLive.turnOutput": "Current-turn output",
    "tokenLive.outputRate": "Average output rate",
    "tokenLive.model": "Model",
    "tokenLive.updatedAt": "Updated",
    "tokenLive.skillUsage": "Skill usage",
    "tokenLive.mcpUsage": "MCP usage",
    "tokenLive.callsUnit": "calls",
    "tokenLive.noSkills": "No skill calls detected in this session",
    "tokenLive.noMcp": "No MCP calls detected in this session",
    "tokenLive.capabilityUnavailable": "This transcript does not expose recognizable calls",
    "tokenLive.transcriptDetected": "Conservatively detected from the transcript",
    "tokenLive.state.waiting": "Waiting for the first usage record",
    "tokenLive.state.generating": "Current turn is generating",
    "tokenLive.state.completed": "Current turn completed",
    "tokenLive.state.unavailable": "Live data is temporarily unavailable",
    "terminal.exited": "[Process exited with code {exitCode}]",
    "terminal.imagePasteFailed": "[Image paste failed: {message}]",
    "composer.inputLabel": "Terminal input",
    "composer.placeholder": "Type a message, use @ to reference workspace files...",
    "composer.send": "Send to terminal",
    "composer.pasteImage": "Upload clipboard image",
    "composer.uploadImage": "Upload image",
    "composer.searchWorkspace": "Workspace files and folders",
    "composer.searching": "Searching the workspace...",
    "composer.searchUnavailable": "Search is temporarily unavailable",
    "composer.noMatches": "No matching files or folders",
    "composer.searchFailed": "Search failed: {message}",
    "composer.uploadingImage": "Uploading image...",
    "composer.noClipboardImage": "No image found in the clipboard",
    "composer.imageUploadFailed": "Image upload failed: {message}",
    "composer.shortcuts": "Enter to send · Shift+Enter for a new line · @ to reference files",
    "composer.shortcutsAgent": "Enter to send · Shift+Enter for a new line · @ to reference files · Type / for Agent command completion · Shift+Tab to switch mode",
    "tabs.files": "Files",
    "tabs.git": "Git",
    "tabs.terminal": "Terminal",
    "tabs.workspace": "Workspace tabs",
    "tabs.debug": "Debug",
    "tabs.conversation": "Conversation",
    "conversation.unread": "New Agent reply",
    "tabs.idea": "IDEA",
    "idea.subtitle": "Run and debug configurations",
    "idea.refresh": "Refresh IDEA state",
    "idea.notConnected": "IDEA is not connected",
    "idea.installHint": "Build and install Pannel Handle Bridge using Install Plugin from Disk, then restart IDEA. The plugin ZIP is in:",
    "idea.noProjects": "No projects are open in this IDEA instance.",
    "idea.noConfigurations": "This project has no runnable configurations.",
    "idea.temporary": "Temporary",
    "idea.run": "Run",
    "idea.debug": "Debug",
    "idea.stop": "Stop",
    "idea.stopAll": "Stop all",
    "idea.restart": "Restart",
    "idea.all": "All",
    "idea.parallelBlocked": "This configuration does not allow parallel execution. Stop or restart the existing instance first.",
    "idea.status.starting": "Starting",
    "idea.status.running": "Running",
    "idea.status.stopping": "Stopping",
    "idea.status.terminated": "Terminated",
    "debug.eventsCount": "{count} hook events",
    "debug.clearEvents": "Clear events",
    "debug.providerFilter": "Provider filter",
    "debug.allInstances": "All instances",
    "debug.noMatchedSession": "No matched session",
    "debug.noEvents": "No hook events yet",
    "debug.handled": "handled",
    "debug.unhandled": "unhandled",
    "files.title": "Files",
    "files.noSession": "No session selected",
    "files.availableAfterSession": "Files are available after selecting a session.",
    "files.parentDirectory": "Parent directory",
    "files.openInExplorer": "Open in Explorer",
    "files.directoryPath": "Directory path",
    "files.changeRoot": "Change file root",
    "files.searchPlaceholder": "Search current directory...",
    "files.clearSearch": "Clear search",
    "files.onlyLocalFiles": "Only local files can be uploaded.",
    "files.cannotResolveLocalPaths": "Cannot recognize the dropped items. Only files dragged from the file explorer are supported.",
    "files.uploading": "Uploading {count} files...",
    "files.preparingDownload": "Preparing download...",
    "files.downloadCompleted": "Download complete",
    "files.downloadCanceled": "Canceled",
    "files.downloadFailed": "Download failed",
    "files.loading": "Loading files...",
    "files.emptyDirectory": "Directory is empty",
    "files.noMatches": "No matching files in this directory.",
    "files.folder": "Folder",
    "files.addToTerminal": "Add to terminal",
    "files.addToGraphicalInput": "Add to input",
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
    "files.languageMode": "Language mode",
    "files.languageAuto": "Auto detect",
    "files.languageAutoDetected": "Auto detect ({language})",
    "files.languagePlainText": "Plain text",
    "files.deleteEntry": "Delete",
    "files.selectedItems": "{count} items",
    "files.cannotMoveIntoSelf": "Cannot move {name} into itself.",
    "files.tooLarge": "File is {size}. Download it to view locally.",
    "files.binary": "Binary file. Download it to view locally.",
    "files.loadingOfficePreview": "Loading Office preview...",
    "files.officeLoadFailed": "Unable to load the Office preview.",
    "files.officeUnsupportedHint": "The file may be damaged, encrypted, or contain unsupported content.",
    "files.officeWorksheets": "Worksheets",
    "files.officeSpreadsheetTruncated": "This worksheet is large. Only the first 10,000-cell range is shown.",
    "files.officeEmptyWorkbook": "The workbook has no worksheets to preview.",
    "files.previewMode": "Preview mode",
    "files.editMode": "Edit mode",
    "files.newFile": "New file",
    "files.newDirectory": "New folder",
    "files.enableAutoCollapse": "Enable automatic single-folder chain collapsing",
    "files.disableAutoCollapse": "Disable automatic single-folder chain collapsing",
    "files.back": "Back",
    "files.forward": "Forward",
    "files.sortBy": "File sorting",
    "files.sortNameAsc": "Name ascending",
    "files.sortNameDesc": "Name descending",
    "files.sortModified": "Recently modified",
    "files.sortSize": "Size descending",
    "files.rename": "Rename",
    "files.name": "Name",
    "files.move": "Move",
    "files.copyPath": "Copy path",
    "files.copyName": "Copy name",
    "files.targetDirectory": "Target directory",
    "files.nameConflict": "An item with the same name already exists",
    "files.overwrite": "Overwrite",
    "files.skip": "Skip",
    "files.autoRename": "Auto rename",
    "files.saveAs": "Save as",
    "files.forceOverwrite": "Keep local and overwrite",
    "files.localChanges": "Local changes",
    "files.remoteChanges": "Latest file content",
    "files.transfers": "File transfers",
    "files.clearCompleted": "Clear completed",
    "files.noTransfers": "No file transfer tasks.",
    "files.activeTransfers": "{count} active",
    "files.transferHistory": "{count} recent tasks",
    "files.closeGuardTitle": "Resolve the file workspace before exiting",
    "files.unsavedFiles": "Unsaved files",
    "files.activeTransfersExit": "Exiting will cancel active and queued file transfers.",
    "files.discardAndExit": "Discard and exit",
    "files.saveAllAndExit": "Save all and exit",
    "files.closeSshTransfers": "This SSH session still has file transfers. Cancel them and close the session?",
    "tabs.monitor": "Monitor",
    "system.sampledAt": "Sampled at {time}",
    "system.memory": "Memory",
    "system.network": "Network",
    "system.disk": "Disk",
    "system.download": "Download",
    "system.upload": "Upload",
    "system.ioBusy": "I/O busy",
    "system.read": "Read",
    "system.write": "Write",
    "system.loading": "Reading server status...",
    "system.unavailable": "Server monitoring is unavailable",
    "system.metrics": "SSH server metrics",
    "system.networkTitle": "Network: down {download}, up {upload}",
    "system.cpuTitle": "CPU: current utilization {percent}",
    "system.diskTitle": "Disk {mountPoint}: used {usedPercent}%, remaining {available}; I/O busy {ioBusy}, read {read}, write {write}",
    "system.diskMissing": "No disk metrics found",
    "system.diskLabel": "Disk --",
    "system.diskRemaining": "{available} left",
    "system.diskSelect": "Select the displayed disk, currently {mountPoint}",
    "system.diskListTitle": "All disk mount points",
    "system.diskUsage": "Used {used} / {total}, {available} available",
    "system.diskIo": "I/O busy {busy}, read {read}, write {write}",
    "system.memoryTitle": "Memory: used {used} / {total}, {percent}",
    "system.historyChart": "{metric} utilization over the last 5 minutes, currently {percent}",
    "system.networkHistoryChart": "Network rates over the last 5 minutes, currently down {download}, up {upload}",
    "system.collectingHistory": "Collecting history...",
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
    "picker.frequent": "Frequent",
    "picker.deleteFromLibrary": "Delete from library",
    "picker.duplicateSession": "Duplicate session",
    "picker.editSession": "Edit session",
    "picker.confirmDelete": "Click again to confirm delete",
    "picker.startFresh": "Start fresh",
    "picker.launchSelected": "Launch selected ({count})",
    "picker.launching": "Launching...",
    "picker.launchFailed": "Failed to launch session",
    "picker.sessionTemplatesTab": "Session templates",
    "picker.launchTemplatesTab": "Launch templates",
    "launchTemplate.name": "Name",
    "launchTemplate.namePlaceholder": "For example: Daily development",
    "launchTemplate.nameExists": "A launch template with this name already exists",
    "launchTemplate.selectedMembers": "Launch order (drag to reorder)",
    "launchTemplate.noMembersSelected": "No session templates selected",
    "launchTemplate.members": "Select session templates",
    "launchTemplate.description": "Save reusable session groups and launch them in order with one action.",
    "launchTemplate.new": "New launch template",
    "launchTemplate.partialFailure": "{count} session templates failed to launch",
    "launchTemplate.empty": "No launch templates yet",
    "launchTemplate.noMembers": "No session templates configured",
    "launchTemplate.memberCount": "{count} session templates",
    "launchTemplate.launch": "Launch all sessions",
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
    "hooks.codebuddyTrustNote": "When CodeBuddy uses project hooks for the first time, review and approve them in CodeBuddy /hooks. Hooks are currently Beta.",
    "hooks.installing": "Installing...",
    "hooks.installOrRepair": "Install or repair",
    "hooks.install": "Install",
    "hooks.repair": "Repair",
    "projectSearch.filesTitle": "Search Files",
    "projectSearch.textTitle": "Search Text",
    "projectSearch.filesPlaceholder": "Type a file name or path...",
    "projectSearch.textPlaceholder": "Type text to search in project...",
    "projectSearch.close": "Close search",
    "projectSearch.caseSensitive": "Match case",
    "projectSearch.wholeWord": "Match whole word",
    "projectSearch.regex": "Use regular expression",
    "projectSearch.includeIgnored": "Include ignored files",
    "projectSearch.sshTextUnavailable": "Content search is not available for SSH sessions",
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
    "git.selectRepository": "Select Git repository",
    "git.scanRepositories": "Rescan repositories and refresh status",
    "git.scanningRepositories": "Scanning repositories…",
    "git.noRepositories": "No Git repositories found in this directory or its immediate children",
    "git.workspaceSummary": "{repositories} repositories · {changes} changes",
    "git.repositoryLoadFailed": "Failed to load repository status",
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
    "git.changesTab": "Changes",
    "git.historyTab": "History",
    "git.syncSection": "Sync",
    "git.commitSection": "Commit",
    "git.changesSection": "Changes",
    "git.expandSection": "Expand {section}",
    "git.collapseSection": "Collapse {section}",
    "git.stagedCount": "{count} staged",
    "git.commitDraftPresent": "Draft",
    "git.changeCount": "{count} files",
    "git.diffTruncated": "This diff is too large. A safe preview is shown; review the complete diff in the terminal.",
    "git.stashManager": "Stash manager",
    "git.stashMessage": "Stash message (optional)",
    "git.createStash": "Create stash",
    "git.preview": "Preview",
    "git.drop": "Drop",
    "git.statusModified": "Modified",
    "git.statusAdded": "Added",
    "git.statusDeleted": "Deleted",
    "git.statusRenamed": "Renamed",
    "git.statusCopied": "Copied",
    "git.statusConflict": "Conflict",
    "git.statusTypeChanged": "Type changed",
    "git.statusUntracked": "Untracked",
    "git.cancelOperation": "Cancel operation",
    "git.details": "Details",
    "git.operationSucceeded": "Operation completed.",
    "git.operationFailed": "Operation failed.",
    "git.operationState": "Repository is in a {state} operation",
    "git.operationStateGuidance": "You can inspect and stage files; continue or abort the operation in the matching terminal.",
    "git.createBranch": "Create branch",
    "git.branchName": "New branch name",
    "git.createAndCheckout": "Create and checkout",
    "git.detachedHead": "Detached HEAD",
    "git.unbornBranch": "No commits yet",
    "git.noBranch": "No current branch",
    "git.noUpstream": "No upstream",
    "git.selectRemote": "Select remote",
    "git.noRemotes": "No remotes",
    "git.fetch": "Fetch",
    "git.pull": "Pull",
    "git.push": "Push",
    "git.commitSubject": "Commit subject",
    "git.commitBody": "Commit body (optional)",
    "git.commitChanges": "Commit staged changes",
    "git.conflicts": "Conflicts",
    "git.stageResolved": "Stage resolved file",
    "git.stagedChanges": "Staged changes",
    "git.workingChanges": "Working tree changes",
    "git.unstage": "Unstage",
    "git.unstageAll": "Unstage all",
    "git.stage": "Stage",
    "git.stageAll": "Stage all",
    "git.discardTitle": "Discard working tree changes",
    "git.deleteUntrackedConfirm": "Permanently delete untracked file {file}? The app cannot recover it.",
    "git.discardWorkingConfirm": "Discard unstaged changes in {file}? Staged content will be preserved.",
    "git.discard": "Discard",
    "git.recentCommits": "Recent commits",
    "git.loadingHistory": "Loading commit history...",
    "git.noHistory": "There are no commits reachable from the current HEAD.",
    "git.loadMore": "Load more",
    "git.dropStashTitle": "Drop stash",
    "git.dropStashConfirm": "Permanently drop {stash}? The app cannot recover it.",
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
