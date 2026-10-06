function toMobileUsageSnapshot(value) {
  return {
    provider: value.provider,
    fetchedAt: value.fetchedAt,
    primaryLimitId: value.primaryLimitId,
    ...(value.summary?.kind === "credits" ? { summary: {
      kind: "credits", total: value.summary.total, used: value.summary.used,
      remaining: value.summary.remaining, usedPercent: value.summary.usedPercent,
      remainingPercent: value.summary.remainingPercent, unit: value.summary.unit
    } } : value.summary?.kind === "currency" ? { summary: {
      kind: "currency", currency: value.summary.currency, available: value.summary.available,
      cash: value.summary.cash, voucher: value.summary.voucher,
      credit: value.summary.credit, owed: value.summary.owed
    } } : {}),
    limits: (value.limits || []).map(limit => ({
      id: limit.id, name: limit.name, usedPercent: limit.usedPercent,
      remainingPercent: limit.remainingPercent, windowDurationMins: limit.windowDurationMins,
      resetsAt: limit.resetsAt, category: limit.category, totalAmount: limit.totalAmount,
      usedAmount: limit.usedAmount, remainingAmount: limit.remainingAmount,
      total: limit.total, used: limit.used, remaining: limit.remaining,
      unit: limit.unit, expiresAt: limit.expiresAt, available: limit.available,
      unlimited: limit.unlimited
    }))
  };
}

function toMobileGraphicalSnapshot(value, modelOptions, session) {
  const snapshot = value || {};
  return {
    threadId: snapshot.threadId ?? null,
    ...(snapshot.streamId ? { streamId: snapshot.streamId, revision: snapshot.revision } : {}),
    provider: snapshot.provider || "codex",
    busy: Boolean(snapshot.busy),
    archived: Boolean(snapshot.archived),
    signedOut: snapshot.account?.status === "signedOut",
    compacting: Boolean(snapshot.compacting),
    reviewing: Boolean(snapshot.reviewing),
    sandboxSettingUp: snapshot.windowsSandboxSetup?.status === "running",
    mainAgentChanging: Boolean(snapshot.mainAgent?.changing),
    error: snapshot.error || null,
    mode: snapshot.mode || "default",
    nativeMode: snapshot.nativeMode || null,
    nativeModes: (snapshot.nativeModes || []).map(mode => ({ id: mode.id, name: mode.name, description: mode.description })),
    model: snapshot.model || null,
    backend: snapshot.backend || null,
    effectiveModel: snapshot.effectiveModel || null,
    models: (snapshot.models || []).map(model => ({ id: model.id, displayName: model.displayName, fastAvailable: model.fastAvailable, defaultReasoningEffort: model.defaultReasoningEffort, supportedReasoningEfforts: model.supportedReasoningEfforts })),
    ...(snapshot.provider === "codebuddy" ? { codeBuddyMobile: true, modelSource: session?.modelSource || "native", serviceModelId: session?.modelId || null,
      mainAgent: snapshot.mainAgent ? { currentAgentName: snapshot.mainAgent.currentAgentName, sessionBlank: snapshot.mainAgent.sessionBlank, changing: snapshot.mainAgent.changing, error: snapshot.mainAgent.error, agents: snapshot.mainAgent.agents.map(agent => ({ name: agent.name, displayName: agent.displayName, description: agent.description, source: agent.source, broken: agent.broken })) } : null, codeBuddyGoal: snapshot.codeBuddyGoal || null, sideQuestion: snapshot.sideQuestion || null,
      availableCommands: (snapshot.availableCommands || []).map(command => ({ name: command.name, description: command.description })), team: snapshot.team ? { name: snapshot.team.name, isAutoTeam: snapshot.team.isAutoTeam, hasLiveMembers: snapshot.team.hasLiveMembers, members: snapshot.team.members.map(member => ({ name: member.name, color: member.color, description: member.description, status: member.status, taskId: member.taskId, sessionId: member.sessionId, tokenUsage: member.tokenUsage, toolCallCount: member.toolCallCount, items: toMobileGraphicalSnapshot({ items: member.items }).items })) } : null } : {}),
    goal: snapshot.goal || null, goalLoading: Boolean(snapshot.goalLoading), goalError: snapshot.goalError || null,
    account: snapshot.account ? { status: snapshot.account.status, requiresOpenaiAuth: snapshot.account.requiresOpenaiAuth, account: snapshot.account.account ? { type: snapshot.account.account.type, email: snapshot.account.account.email, planType: snapshot.account.account.planType } : null, login: snapshot.account.login ? { type: snapshot.account.login.type, loginId: snapshot.account.login.loginId, url: snapshot.account.login.url, userCode: snapshot.account.login.userCode } : null, error: snapshot.account.error, rateLimitsError: snapshot.account.rateLimitsError, usageError: snapshot.account.usageError } : null, windowsSandboxSetup: snapshot.windowsSandboxSetup ? { available: snapshot.windowsSandboxSetup.available, mode: snapshot.windowsSandboxSetup.mode, status: snapshot.windowsSandboxSetup.status, error: snapshot.windowsSandboxSetup.error } : null,
    subAgents: snapshot.subAgents ? { expanded: snapshot.subAgents.expanded, selectedThreadId: snapshot.subAgents.selectedThreadId, loading: snapshot.subAgents.loading, error: snapshot.subAgents.error, warning: snapshot.subAgents.warning,
      members: (snapshot.subAgents.members || []).map(thread => ({ threadId: thread.threadId, parentThreadId: thread.parentThreadId, name: thread.name, role: thread.role, task: thread.task, status: thread.status, createdAt: thread.createdAt, loading: thread.loading, error: thread.error, items: toMobileGraphicalSnapshot({ items: thread.items }).items })) } : null,
    turnDiffs: (snapshot.turnDiffs || []).map(value => ({ turnId: value.turnId, diff: value.diff, updatedAt: value.updatedAt })), tokenUsage: snapshot.tokenUsage || null, turnOutputTokens: snapshot.turnOutputTokens, outputTokensPerSecond: snapshot.outputTokensPerSecond, outputRateAvailable: snapshot.outputRateAvailable,
    mcpRuntime: (snapshot.mcpRuntime || []).map(value => ({ name: value.name, status: value.status, error: value.error, failureReason: value.failureReason })), mcpLogins: (snapshot.mcpLogins || []).map(value => ({ name: value.name, status: value.status, error: value.error })), mcpReload: snapshot.mcpReload ? { status: snapshot.mcpReload.status, error: snapshot.mcpReload.error } : null,
    elicitations: snapshot.elicitations || [],
    effort: snapshot.effort || null,
    fastMode: Boolean(snapshot.fastMode),
    executionPermission: snapshot.executionPermission || null,
    contextUsage: (snapshot.provider === "codebuddy" || snapshot.provider === "opencode")
      && Number.isFinite(snapshot.contextUsage?.used) && snapshot.contextUsage.used >= 0
      && Number.isFinite(snapshot.contextUsage?.size) && snapshot.contextUsage.size > 0
      ? { used: snapshot.contextUsage.used, size: snapshot.contextUsage.size } : null,
    acpOptions: (snapshot.acpOptions || []).filter(option => option.id === "model" || option.id === "effort" || option.id === "reasoning_effort" || snapshot.provider === "codebuddy" && ["multitask", "context_window"].includes(option.id))
      .map(option => ({ id: option.id, type: option.type, currentValue: option.currentValue,
        options: (option.id === "model" && modelOptions ? modelOptions : option.options || []).map(value => ({ value: value.value, name: value.name, description: value.description })) })),
    capabilities: snapshot.capabilities || null,
    pendingPlan: snapshot.pendingPlan || null,
    items: (snapshot.items || []).map(item => ({
      rewindMessageId: item.rewindMessageId, mcpApp: item.mcpApp ? { serverName: item.mcpApp.serverName, resourceUri: item.mcpApp.resourceUri, revision: item.mcpApp.revision } : undefined,
      id: item.id, type: item.type, turnId: item.turnId, text: item.text,
      summary: item.summary, senderThreadId: item.senderThreadId, receiverThreadId: item.receiverThreadId, prompt: item.prompt, agentStatus: item.agentStatus,
      command: item.command, output: item.output, status: item.status,
      toolName: item.toolName, toolKind: item.toolKind, explanation: item.explanation,
      tool: item.tool, server: item.server, query: item.query,
      arguments: item.arguments, result: item.result, changes: item.changes, locations: item.locations, toolContent: item.toolContent,
      plan: item.plan, questions: item.questions,
      attachments: (item.attachments || []).map(file => ({ name: file.name || "附件", path: file.path }))
    })),
    diagnostics: snapshot.provider === "codex" ? (snapshot.diagnostics || [])
      .filter(event => event.kind === "error")
      .map(event => ({ id: event.id, turnId: event.turnId, at: event.at,
        message: String(event.payload?.message || "Codex 运行失败。"),
        kind: event.payload?.kind || null, httpStatusCode: event.payload?.httpStatusCode ?? null,
        additionalDetails: event.payload?.additionalDetails ?? null })) : [],
    approvals: (snapshot.approvals || []).map(value => ({
      requestId: value.requestId, method: value.method,
      params: {
        itemId: value.params?.itemId, reason: value.params?.reason,
        command: value.params?.command, cwd: value.params?.cwd,
        changes: value.params?.changes, choices: value.params?.choices,
        networkApprovalContext: value.params?.networkApprovalContext, permissions: value.params?.permissions, grantRoot: value.params?.grantRoot, availableDecisions: value.params?.availableDecisions, proposedExecpolicyAmendment: value.params?.proposedExecpolicyAmendment
      }
    })),
    questions: (snapshot.questions || []).map(value => ({
      requestId: value.requestId, submitting: value.submitting,
      params: {
        threadId: value.params?.threadId, turnId: value.params?.turnId,
        questions: value.params?.questions
      }
    }))
  };
}

module.exports = { toMobileGraphicalSnapshot, toMobileUsageSnapshot };
