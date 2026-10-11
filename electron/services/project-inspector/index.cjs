const { randomUUID, createHash } = require("node:crypto");
const { createFindingStore } = require("./finding-store.cjs");
const profiler = require("./project-profiler.cjs");
const { suggestRoles, validateRole, matches } = require("./role-manager.cjs");
const { verifyFinding, mergeFinding } = require("./finding-verifier.cjs");
const { detectImpact } = require("./change-detector.cjs");
const { checkSources } = require("./static-check-runner.cjs");

const { agentSnapshot, assertStage, environmentKey, summarize } = require("./template-config.cjs");

const DEFAULT_SETTINGS = { schedulerEnabled: false, gitEnabled: false, incremental: true, concurrency: 2,
  timeoutSeconds: 300, maxTokensPerRun: 90000, model: "", notifications: true, missedRunPolicy: "skip", engine: "static" };

function createProjectInspectorService({ userData, store = createFindingStore({ userData }), reviewer, sessionStore, environmentService, getProfiler = () => profiler, onEvent = () => {}, now = Date.now }) {
  const active = new Map();
  const pending = [];
  let closed = false;
  let ticking = false;
  function requireRecord(table, id) {
    if (typeof id !== "string" || !id || id.length > 100) throw new Error("巡检 ID 无效。");
    const value = store.get(table, id);
    if (!value) throw new Error("巡检记录不存在。");
    return value;
  }
  const emit = (type, projectId, data) => { if (!closed) onEvent({ type, projectId, data }); };
  async function addProject(input, { allowExisting = false } = {}) {
    if (closed) throw new Error("巡检服务已关闭。");
    let templateSnapshot;
    let sourceTemplate;
    if (input?.templateId) {
      sourceTemplate = sessionStore?.getTemplate(input.templateId);
      if (!sourceTemplate || sourceTemplate.inspectorStage || !sourceTemplate.cwd || !sourceTemplate.agentProvider) throw new Error("请选择有工作目录和 agent 的普通会话模板。");
      templateSnapshot = { ...agentSnapshot(sourceTemplate), type: sourceTemplate.type, cwd: sourceTemplate.cwd,
        wslDistro: sourceTemplate.wslDistro, sshConfig: sourceTemplate.sshConfig && structuredClone(sourceTemplate.sshConfig) };
      if (environmentService) templateSnapshot.environmentOverrides = Object.entries(environmentService.resolve(sourceTemplate)).map(([name, value]) => ({ name, value }));
    } else if (sessionStore) throw new Error("请从会话模板添加项目。");
    const workspaceType = templateSnapshot?.type || "windows";
    const key = environmentKey(templateSnapshot || { type: "windows" });
    const resolved = await getProfiler({ templateSnapshot }).resolveProject(templateSnapshot?.cwd || input?.rootPath);
    if (closed) throw new Error("巡检服务已关闭。");
    const existing = store.list("projects").find(project => (project.environmentKey || "windows") === key && (workspaceType === "windows" ? project.rootPath.toLowerCase() === resolved.rootPath.toLowerCase() : project.rootPath === resolved.rootPath));
    if (existing) {
      if (sourceTemplate && existing.sourceTemplateId !== sourceTemplate.id && !allowExisting) throw new Error("该仓库已添加，请在现有项目的巡检设置中重新关联来源模板。");
      return existing;
    }
    const project = store.put("projects", { id: randomUUID(), ...resolved, workspaceType, environmentKey: key, ...(templateSnapshot ? { templateSnapshot, sourceTemplateId: sourceTemplate.id, sourceTemplateTitle: sourceTemplate.title } : {}), enabled: true, createdAt: now(), settings: { ...DEFAULT_SETTINGS, ...(templateSnapshot ? { engine: "codex" } : {}) } });
    emit("project", project.id, summarize(project));
    return project;
  }
  async function profileProject(id) {
    if (closed) throw new Error("巡检服务已关闭。");
    const project = requireRecord("projects", id);
    const profile = await getProfiler(project).profileProject(project);
    if (closed) throw new Error("巡检服务已关闭。");
    store.transaction(() => {
      store.put("projects", { ...requireRecord("projects", id), profile, headCommit: profile.headCommit, dirty: profile.dirty });
      if (!store.list("roles", id).length) for (const role of suggestRoles(id, profile)) store.put("roles", role);
    });
    emit("profile", id, profile);
    return profile;
  }
  function updateRole(input) {
    const role = requireRecord("roles", input?.id);
    if (role.mergedInto) throw new Error("负责人已合并，请修改合并后的负责人。");
    const allowed = ["name", "paths", "focus", "enabled", "confirmed", "intervalMinutes", "incrementalOnChange", "maxFilesPerRun", "maxTokensPerRun"];
    const patch = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)));
    const value = validateRole({ ...role, ...patch });
    if (JSON.stringify(value.paths) !== JSON.stringify(role.paths) || JSON.stringify(value.focus) !== JSON.stringify(role.focus)) value.lastCommit = null;
    if (value.intervalMinutes !== role.intervalMinutes) value.nextRunAt = now() + value.intervalMinutes * 60000;
    store.put("roles", value); emit("role", role.projectId, value); return value;
  }
  function mergeRoles(input) {
    if (closed) throw new Error("巡检服务已关闭。");
    if (!Array.isArray(input?.ids) || input.ids.length < 2 || input.ids.length > 10 || new Set(input.ids).size !== input.ids.length) throw new Error("请选择 2 至 10 个不同负责人。");
    const roles = input.ids.map(id => requireRecord("roles", id));
    const projectId = roles[0].projectId;
    if (roles.some(role => role.projectId !== projectId || role.mergedInto)) throw new Error("只能合并同一项目中尚未合并的负责人。");
    if (store.list("runs", projectId).some(run => input.ids.includes(run.roleId) && ["queued", "running"].includes(run.status))) throw new Error("请等待或取消相关巡检后合并负责人。");
    const timestamp = now();
    const role = validateRole({ ...roles[0], id: randomUUID(), name: input.name,
      paths: [...new Set(roles.flatMap(value => value.paths))], focus: [...new Set(roles.flatMap(value => value.focus))],
      enabled: roles.some(value => value.enabled), confirmed: false,
      intervalMinutes: Math.min(...roles.map(value => value.intervalMinutes)),
      maxFilesPerRun: Math.max(...roles.map(value => value.maxFilesPerRun)), maxTokensPerRun: Math.max(...roles.map(value => value.maxTokensPerRun)),
      incrementalOnChange: roles.some(value => value.incrementalOnChange),
      lastCommit: null, lastRunAt: null, failures: 0, mergedFrom: input.ids, createdAt: timestamp });
    role.nextRunAt = timestamp + role.intervalMinutes * 60000;
    store.transaction(() => {
      for (const source of roles) store.put("roles", { ...source, enabled: false, mergedInto: role.id, mergedAt: timestamp });
      store.put("roles", role);
      for (const finding of store.list("findings", projectId)) if (input.ids.includes(finding.roleId)) store.put("findings", { ...finding, roleId: role.id, roleName: role.name,
        collaboratorRoleIds: (finding.collaboratorRoleIds || []).filter(id => !input.ids.includes(id)),
        roleAssignments: [...(finding.roleAssignments || []), { previousRoleId: finding.roleId, roleId: role.id, changedAt: timestamp, actor: "local-user" }].slice(-100),
        revision: finding.revision + 1, updatedAt: timestamp });
    });
    emit("roles-merged", projectId, role);
    return role;
  }
  function updateSettings(id, patch) {
    const project = requireRecord("projects", id);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("巡检设置无效。");
    const settings = { ...DEFAULT_SETTINGS, ...project.settings };
    const stageAgents = { ...project.stageAgents };
    if (patch.stageTemplateIds !== undefined) {
      if (!patch.stageTemplateIds || typeof patch.stageTemplateIds !== "object" || Array.isArray(patch.stageTemplateIds)) throw new Error("阶段模板配置无效。");
      for (const [stage, templateId] of Object.entries(patch.stageTemplateIds)) {
        if (!["inspection", "planning", "implementation"].includes(stage) || typeof templateId !== "string") throw new Error("阶段模板配置无效。");
        if (!templateId) { delete stageAgents[stage]; continue; }
        if (stageAgents[stage]?.templateId === templateId) continue;
        const template = sessionStore?.getTemplate(templateId);
        if (!template?.agentProvider || template.inspectorStage) throw new Error("Agent 模板不存在或不适用于巡检。");
        const config = agentSnapshot(template);
        if (environmentService) config.environmentOverrides = Object.entries(environmentService.resolve(template)).map(([name, value]) => ({ name, value }));
        stageAgents[stage] = { templateId, title: template.title, config };
      }
    }
    for (const [key, value] of Object.entries(patch)) {
      if (key === "stageTemplateIds") continue;
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error("未知的巡检设置。");
      if (typeof DEFAULT_SETTINGS[key] === "boolean" && typeof value !== "boolean") throw new Error("巡检设置类型无效。");
      settings[key] = value;
    }
    for (const [key, min, max] of [["concurrency", 1, 4], ["timeoutSeconds", 10, 1800], ["maxTokensPerRun", 1000, 200000]]) {
      if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`${key} 超出允许范围。`);
    }
    if (!["static", "codex"].includes(settings.engine) || !["skip", "catch-up"].includes(settings.missedRunPolicy)
      || typeof settings.model !== "string" || settings.model.length > 200) throw new Error("巡检设置无效。");
    if (settings.engine === "codex" && !reviewer) throw new Error("安全的 Codex 巡检执行器尚未可用。");
    store.put("projects", { ...project, settings, stageAgents }); emit("settings", id, settings); return settings;
  }
  async function executeRun(run, project, role, controller) {
    const started = now();
    const settings = { ...DEFAULT_SETTINGS, ...project.settings };
    const timer = setTimeout(() => controller.abort(new Error("巡检超过时间限制。")), settings.timeoutSeconds * 1000);
    let current = { ...run, status: "running", startedAt: started };
    store.put("runs", current); emit("run", project.id, current);
    try {
      const agent = settings.engine === "codex" ? assertStage(project, "inspection") : null;
      const projectProfiler = getProfiler(project);
      const signal = controller.signal;
      let tree = await projectProfiler.listTree(project.rootPath, run.headCommit, signal);
      tree = tree.filter(file => role.paths.some(pattern => matches(file.path, pattern)));
      let changed = null;
      if (run.incremental && run.baseCommit) changed = run.impact ? run.affectedPaths : await projectProfiler.changedFiles(project.rootPath, run.baseCommit, run.headCommit, signal);
      if (changed) tree = tree.filter(file => changed.includes(file.path));
      const totalFiles = tree.length;
      tree = tree.slice(0, role.maxFilesPerRun);
      const sources = new Map();
      const budget = Math.min(role.maxTokensPerRun, settings.maxTokensPerRun);
      const reserve = settings.engine === "codex" ? 15000 : 2000;
      if (settings.engine === "codex" && budget < 16000) throw new Error("Codex 巡检至少需要 16000 Token 预算，请调整项目和负责人预算。");
      let bytes = 0;
      for (const file of tree) {
        signal.throwIfAborted();
        const text = await projectProfiler.readSource(project.rootPath, file, signal);
        if (text === null) continue;
        // Conservative byte-based upper bound includes prompt/output reserve.
        const size = Buffer.byteLength(text, "utf8");
        if (bytes + size > Math.max(0, budget - reserve)) break;
        bytes += size; sources.set(file.path, text);
      }
      let candidates = [];
      let usage = null;
      if (sources.size) {
        if (settings.engine === "codex") {
          if (!reviewer) throw new Error("只读巡检执行器不可用。");
          const result = await reviewer.review({ project, role, run, sources, signal, maxTokens: budget, model: settings.model || agent?.codexModel });
          candidates = result.findings; usage = result.usage;
        } else candidates = checkSources(sources);
      }
      signal.throwIfAborted();
      if (!Array.isArray(candidates) || candidates.length > 200) throw new Error("巡检输出超过问题数量限制。");
      const findings = [];
      let rejected = 0;
      for (const candidate of candidates) {
        try { findings.push({ ...verifyFinding(candidate, { projectId: project.id, roleId: role.id, runId: run.id, headCommit: run.headCommit, sources }), detectionEngine: run.engine, roleName: role.name }); }
        catch { rejected += 1; }
      }
      const notificationIds = [];
      store.transaction(() => {
        for (const finding of findings) {
          const existing = store.list("findings", project.id).find(item => item.fingerprint === finding.fingerprint);
          const previous = existing && { ...existing, roleName: existing.roleName || store.get("roles", existing.roleId)?.name };
          const merged = mergeFinding(previous, finding);
          store.put("findings", merged);
          if (!existing || (merged.status === "awaiting_review" && (["ignored", "resolved"].includes(existing.status) || merged.severity < existing.severity))) notificationIds.push(merged.id);
        }
        current = { ...current, status: sources.size ? "completed" : "skipped", finishedAt: now(), reviewedPaths: [...sources.keys()], findingFingerprints: findings.map(finding => finding.fingerprint),
          stats: { files: sources.size, totalFiles, truncated: sources.size < totalFiles, sourceBytes: bytes, findings: findings.length, rejected, usage, durationMs: now() - started },
          summary: sources.size ? `审查 ${sources.size} 个已提交文件，发现 ${findings.length} 个待复核问题。` : "范围内没有可分析的已提交变更。" };
        store.put("runs", current);
        const latestRole = store.get("roles", role.id);
        store.put("roles", { ...latestRole, lastRunAt: now(), lastCommit: run.headCommit, nextRunAt: now() + latestRole.intervalMinutes * 60000, failures: 0 });
      });
      emit("findings", project.id, { runId: run.id, count: findings.length, notificationIds });
    } catch (error) {
      current = { ...current, status: controller.signal.aborted ? "cancelled" : "failed", finishedAt: now(), ...(error.usage ? { usage: error.usage } : {}), error: profiler.redact(String(error.message || error).replaceAll(project.rootPath, "[项目目录]")).slice(0, 2000) };
      store.put("runs", current);
      const latestRole = store.get("roles", role.id);
      const failures = (latestRole.failures || 0) + 1;
      store.put("roles", { ...latestRole, failures, nextRunAt: now() + Math.min(86400000, 60000 * 2 ** Math.min(failures, 10)) });
    } finally {
      clearTimeout(timer); active.delete(run.id); emit("run", project.id, current); pump();
    }
    return current;
  }
  function pump() {
    if (closed) return;
    for (let index = 0; index < pending.length;) {
      const task = pending[index];
      const limit = store.get("projects", task.project.id)?.settings?.concurrency || DEFAULT_SETTINGS.concurrency;
      if (active.size >= limit) { index += 1; continue; }
      pending.splice(index, 1);
      const controller = new AbortController();
      active.set(task.run.id, { controller, promise: null });
      active.get(task.run.id).promise = executeRun(task.run, task.project, task.role, controller);
    }
  }
  async function startInspection(input) {
    if (closed) throw new Error("巡检服务已关闭。");
    let project = requireRecord("projects", input?.projectId);
    if (project.settings?.engine === "codex") assertStage(project, "inspection");
    const trigger = input.trigger || "manual";
    if (!["manual", "scheduled", "git", "retry"].includes(trigger) || (input.incremental !== undefined && typeof input.incremental !== "boolean")) throw new Error("巡检触发参数无效。");
    let roles = store.list("roles", project.id).filter(role => !role.mergedInto && role.enabled && role.confirmed && (!input.roleId || role.id === input.roleId));
    if (!roles.length) throw new Error("请先确认并启用模块负责人。");
    const resolved = await getProfiler(project).resolveProject(project.rootPath);
    if (closed) throw new Error("巡检服务已关闭。");
    if ((project.workspaceType === "windows" || !project.workspaceType ? resolved.rootPath.toLowerCase() !== project.rootPath.toLowerCase() : resolved.rootPath !== project.rootPath)) throw new Error("项目 Git 根目录已变化，请重新导入。");
    project = store.put("projects", { ...requireRecord("projects", project.id), headCommit: resolved.headCommit, dirty: resolved.dirty });
    // Role configuration may change while Git inspection is awaiting I/O.
    roles = store.list("roles", project.id).filter(role => !role.mergedInto && role.enabled && role.confirmed && (!input.roleId || role.id === input.roleId));
    if (!roles.length) throw new Error("负责人在准备巡检期间已停用或合并，请重新确认后巡检。");
    const settings = { ...DEFAULT_SETTINGS, ...project.settings };
    const runs = [];
    const impacts = new Map();
    for (const role of roles) {

      const existing = store.list("runs", project.id).find(run => run.roleId === role.id && ["queued", "running"].includes(run.status));
      if (existing) { runs.push(existing); continue; }
      const incremental = input.incremental ?? settings.incremental;
      let impact = null;
      if (incremental && role.lastCommit) {
        if (!impacts.has(role.lastCommit)) impacts.set(role.lastCommit, (project.workspaceType && project.workspaceType !== "windows" ? Promise.resolve({ full: true, paths: null, changed: [], reason: "remote-full-snapshot" }) : detectImpact({ root: project.rootPath, base: role.lastCommit, head: resolved.headCommit, signal: AbortSignal.timeout(30_000) }))
          .catch(() => ({ full: true, paths: null, changed: [], reason: "dependency-analysis-unavailable" })));
        impact = await impacts.get(role.lastCommit);
        if (closed) throw new Error("巡检服务已关闭。");
        const latest = store.get("roles", role.id);
        if (!latest?.enabled || !latest.confirmed || latest.mergedInto) continue;
        const duplicate = store.list("runs", project.id).find(run => run.roleId === role.id && ["queued", "running"].includes(run.status));
        if (duplicate) { runs.push(duplicate); continue; }
        if (latest.lastCommit === resolved.headCommit) impact = { full: false, paths: [], changed: [], reason: "no-changes" };
        else if (latest.lastCommit !== role.lastCommit || JSON.stringify(latest.paths) !== JSON.stringify(role.paths) || JSON.stringify(latest.focus) !== JSON.stringify(role.focus)) impact = { full: true, paths: null, changed: [], reason: "role-configuration-changed" };
        Object.assign(role, latest);
      }
      const unaffected = impact && !impact.full && !impact.paths.some(file => role.paths.some(pattern => matches(file, pattern)));
      const run = { id: randomUUID(), projectId: project.id, roleId: role.id, trigger, headCommit: resolved.headCommit,
        baseCommit: role.lastCommit || null, incremental, dirty: resolved.dirty, scope: "committed-only", engine: settings.engine,
        status: unaffected ? "skipped" : "queued", ...(impact ? { affectedPaths: impact.paths, impact: { full: impact.full, reason: impact.reason, changedFiles: impact.changed, affectedFiles: impact.paths?.length ?? null } } : {}), createdAt: now(), idempotencyKey: createHash("sha256").update([project.id, role.id, resolved.headCommit, trigger, role.lastCommit || ""].join(":" )).digest("hex") };
      store.put("runs", run);
      if (unaffected) {
        run.finishedAt = now(); run.summary = "本角色未受到本次提交及可解析依赖变化影响，未调用模型。";
        run.stats = { files: 0, totalFiles: 0, truncated: false, durationMs: 0, findings: 0, rejected: 0 };
        store.put("runs", run);
        const latest = store.get("roles", role.id);
        store.put("roles", { ...latest, lastCommit: resolved.headCommit, lastRunAt: now(), nextRunAt: now() + latest.intervalMinutes * 60000, failures: 0 });
        emit("run", project.id, run);
      } else pending.push({ run, project, role });
      runs.push(run);
    }
    pump();
    return runs;
  }
  function cancelInspection(id) {
    const run = requireRecord("runs", id);
    const index = pending.findIndex(task => task.run.id === id);
    if (index >= 0) {
      pending.splice(index, 1);
      const cancelled = store.put("runs", { ...run, status: "cancelled", finishedAt: now(), error: "用户取消巡检。" });
      emit("run", run.projectId, cancelled);
    }
    active.get(id)?.controller.abort(new Error("用户取消巡检。"));
  }
  function decideFinding(id, expectedRevision, action, reason = "") {
    if (!["ignored", "deferred", "awaiting_review"].includes(action) || typeof reason !== "string" || reason.length > 4000) throw new Error("问题处理参数无效。");
    return store.transaction(() => {
      const finding = requireRecord("findings", id);
      if (finding.revision !== expectedRevision) throw new Error("问题已更新，请刷新后重试。");
      if (["planning", "implementing", "merging"].includes(finding.status)) throw new Error("请先完成关联会话。");
      store.put("approvals", { id: randomUUID(), projectId: finding.projectId, findingId: id, stage: "review", decision: action, reviewer: "local-user", comment: profiler.redact(reason), createdAt: now() });
      const updated = store.put("findings", { ...finding, status: action, revision: finding.revision + 1, updatedAt: now() });
      emit("finding", finding.projectId, updated); return updated;
    });
  }
  async function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      for (const project of store.list("projects")) {
        if (closed) break;
        if (!project.enabled) continue;
        const settings = { ...DEFAULT_SETTINGS, ...project.settings };
        for (const role of store.list("roles", project.id)) {
          if (closed) break;
          if (!role.enabled || !role.confirmed || active.size >= settings.concurrency) continue;
          if (settings.schedulerEnabled && role.nextRunAt <= now()) {
            if (settings.missedRunPolicy === "skip" && now() - role.nextRunAt > role.intervalMinutes * 60000) {
              store.put("roles", { ...role, nextRunAt: now() + role.intervalMinutes * 60000 }); continue;
            }
            await startInspection({ projectId: project.id, roleId: role.id, trigger: "scheduled", incremental: false });
          } else if (settings.gitEnabled && role.incrementalOnChange) {
            const resolved = await getProfiler(project).resolveProject(project.rootPath);
            if (closed) break;
            if (resolved.headCommit !== role.lastCommit && (!role.failures || role.nextRunAt <= now())) await startInspection({ projectId: project.id, roleId: role.id, trigger: "git", incremental: true });
          }
        }
      }
    } catch (error) { emit("scheduler-error", null, { message: "项目调度失败，请检查路径或 Git 状态。" }); }
    finally { ticking = false; }
  }
  return { store, addProject, profileProject, updateRole, mergeRoles, updateSettings, startInspection, cancelInspection, decideFinding, tick,
    listProjects: () => store.list("projects").map(summarize),
    listProjectTemplates: () => (sessionStore?.getLibrary() || []).filter(template => !template.inspectorStage).map(template => ({ id: template.id, title: template.title, cwd: template.cwd, type: template.type, agent: template.agentProvider || "", unsupportedReason: !template.cwd ? "缺少工作目录。" : !template.agentProvider ? "缺少 agent。" : null })),
    async relinkProject(input) {
      const old = requireRecord("projects", input?.projectId);
      const ensureIdle = () => {
        if (closed) throw new Error("巡检服务已关闭。");
        if (store.list("runs", old.id).some(run => ["queued", "running"].includes(run.status)) || store.list("sessions", old.id).some(link => ["creating", "active"].includes(link.status))) throw new Error("请先完成或取消关联任务再更新模板。");
      };
      ensureIdle();
      const template = sessionStore?.getTemplate(input.templateId);
      if (!template?.cwd || !template.agentProvider || template.inspectorStage) throw new Error("请选择有工作目录和 agent 的普通会话模板。");
      const snapshot = { ...agentSnapshot(template), type: template.type, cwd: template.cwd, wslDistro: template.wslDistro, sshConfig: template.sshConfig && structuredClone(template.sshConfig) };
      const sourceTemplateId = template.id, sourceTemplateTitle = template.title;
      if (environmentService) snapshot.environmentOverrides = Object.entries(environmentService.resolve(template)).map(([name, value]) => ({ name, value }));
      const imported = await addProject({ templateId: input.templateId }, { allowExisting: true });
      if (imported.id !== old.id) return summarize(imported);
      ensureIdle();
      const updated = store.put("projects", { ...requireRecord("projects", old.id), templateSnapshot: snapshot, sourceTemplateId, sourceTemplateTitle });
      emit("project", old.id, summarize(updated)); return summarize(updated);
    }, listRoles: id => { requireRecord("projects", id); return store.list("roles", id).filter(role => !role.mergedInto); },
    listInspectionRuns: id => { requireRecord("projects", id); return store.list("runs", id).sort((a, b) => b.createdAt - a.createdAt); },
    getUsage: id => {
      requireRecord("projects", id);
      const roles = new Map(); let unknownRuns = 0;
      for (const run of store.list("runs", id)) {
        const usage = run.stats?.usage || run.usage;
        if (run.engine !== "codex" || run.status === "skipped" || ["queued", "running"].includes(run.status)) continue;
        if (!usage || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens) || usage.input_tokens < 0 || usage.output_tokens < 0) { unknownRuns++; continue; }
        const row = roles.get(run.roleId) || { roleId: run.roleId, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, runs: 0 };
        row.inputTokens += usage.input_tokens; row.outputTokens += usage.output_tokens;
        row.cachedInputTokens += Number.isSafeInteger(usage.cached_input_tokens) && usage.cached_input_tokens >= 0 ? usage.cached_input_tokens : 0;
        row.runs++; roles.set(run.roleId, row);
      }
      const rows = [...roles.values()];
      return { inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0), cachedInputTokens: rows.reduce((sum, row) => sum + row.cachedInputTokens, 0), unknownRuns, roles: rows };
    },
    getFinding: id => requireRecord("findings", id), getSettings: id => { const project = requireRecord("projects", id); return { ...DEFAULT_SETTINGS, ...project.settings, stageTemplateIds: Object.fromEntries(Object.entries(project.stageAgents || {}).map(([stage, value]) => [stage, value.templateId])) }; },
    listFindings: (query = {}) => {
      requireRecord("projects", query.projectId);
      const items = store.list("findings", query.projectId).filter(finding => ["roleId", "severity", "status"].every(key => !query[key] || finding[key] === query[key] || (key === "roleId" && finding.collaboratorRoleIds?.includes(query[key])))).sort((a, b) => a.severity.localeCompare(b.severity) || b.updatedAt - a.updatedAt);
      return { items, total: items.length };
    },
    async waitForIdle() { while (active.size || pending.length) await Promise.all([...active.values()].map(task => task.promise)); },
    async close() {
      closed = true;
      for (const task of active.values()) task.controller.abort();
      await Promise.allSettled([...active.values()].map(task => task.promise));
      while (ticking) await new Promise(resolve => setTimeout(resolve, 10));
      store.close();
    }
  };
}
module.exports = { createProjectInspectorService, DEFAULT_SETTINGS };
