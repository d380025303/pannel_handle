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

function toMobileGraphicalSnapshot(value, modelOptions) {
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
    models: (snapshot.models || []).map(model => ({ id: model.id, displayName: model.displayName })),
    effort: snapshot.effort || null,
    fastMode: Boolean(snapshot.fastMode),
    executionPermission: snapshot.executionPermission || null,
    contextUsage: (snapshot.provider === "codebuddy" || snapshot.provider === "opencode")
      && Number.isFinite(snapshot.contextUsage?.used) && snapshot.contextUsage.used >= 0
      && Number.isFinite(snapshot.contextUsage?.size) && snapshot.contextUsage.size > 0
      ? { used: snapshot.contextUsage.used, size: snapshot.contextUsage.size } : null,
    acpOptions: (snapshot.acpOptions || []).filter(option => option.id === "model" || option.id === "effort" || option.id === "reasoning_effort")
      .map(option => ({ id: option.id, type: option.type, currentValue: option.currentValue,
        options: (option.id === "model" && modelOptions ? modelOptions : option.options || []).map(value => ({ value: value.value, name: value.name, description: value.description })) })),
    capabilities: snapshot.capabilities || null,
    pendingPlan: snapshot.pendingPlan || null,
    items: (snapshot.items || []).map(item => ({
      id: item.id, type: item.type, turnId: item.turnId, text: item.text,
      command: item.command, output: item.output, status: item.status,
      toolName: item.toolName, toolKind: item.toolKind, explanation: item.explanation,
      tool: item.tool, server: item.server, query: item.query,
      arguments: item.arguments, result: item.result, changes: item.changes, locations: item.locations, toolContent: item.toolContent,
      plan: item.plan, questions: item.questions,
      attachments: (item.attachments || []).map(file => ({ name: file.name || "附件" }))
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
        networkApprovalContext: value.params?.networkApprovalContext
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
