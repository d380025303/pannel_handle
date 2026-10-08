const LEGACY = {
  readOnly: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
  askApproval: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } },
  fullAccess: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
};
const normalize = value => typeof value === "string" ? value.replace(/[-_]/g, "").toLowerCase() : "";
const text = value => typeof value === "string" ? value.slice(0, 1024).replace(/https?:\/\/\S+/gi, "[URL 已隐藏]") : null;
function flags(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "boolean").slice(0, 100)) : {};
}
function summary(config) {
  const result = {};
  for (const key of ["model", "model_provider", "model_reasoning_effort", "approval_policy", "sandbox_mode", "service_tier", "web_search", "permissions"])
    if (typeof config?.[key] === "string") result[key] = text(config[key]);
  result.features = flags(config?.features);
  return result;
}
function requirements(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("管理员要求返回格式无效。");
  const result = { featureRequirements: flags(value.featureRequirements) };
  for (const key of ["allowedApprovalPolicies", "allowedSandboxModes", "allowedApprovalsReviewers"])
    if (Array.isArray(value[key])) result[key] = value[key].filter(v => typeof v === "string").map(text);
  result.allowedPermissionProfiles = flags(value.allowedPermissionProfiles);
  if (value.network && typeof value.network === "object") result.network = {
    enabled: typeof value.network.enabled === "boolean" ? value.network.enabled : null,
    allowedDomains: Array.isArray(value.network.allowedDomains) ? value.network.allowedDomains.filter(v => typeof v === "string").map(text).slice(0, 100) : []
  };
  return result;
}
function legacyOptions(requirementsValue) {
  return Object.entries(LEGACY).map(([id, policy]) => {
    const approvals = requirementsValue?.allowedApprovalPolicies;
    const sandboxes = requirementsValue?.allowedSandboxModes;
    const allowed = (!approvals || approvals.some(v => normalize(v) === normalize(policy.approvalPolicy)))
      && (!sandboxes || sandboxes.some(v => normalize(v) === normalize(policy.sandboxPolicy.type)));
    return { id, allowed, reason: allowed ? null : "管理员限制不允许此审批／沙箱组合。" };
  });
}
function createConfigurationController({ request, cwd, check }) {
  let current = { requirements: { status: "loading", data: null }, profiles: { status: "loading", data: [] } };
  let revision = 0;
  async function section(work) {
    try { return { status: "ready", data: await work() }; }
    catch (error) { return { status: error.code === -32601 || /method not found|unknown method|unsupported method/i.test(error.message) ? "unsupported" : "error", data: null,
      error: error.code === -32601 ? "当前 Codex 版本不支持此接口。" : "读取失败，请刷新重试或检查 Codex 配置。" }; }
  }
  async function load(includeConfig = false) {
    const generation = ++revision;
    const [req, profiles, config] = await Promise.all([
      section(async () => requirements((await request("configRequirements/read", {})).requirements)),
      section(async () => {
        const rows = []; const seen = new Set(); let cursor = null;
        do {
          const response = await request("permissionProfile/list", { cwd: cwd(), limit: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(response.data)) throw new Error("权限档返回格式无效。");
          for (const row of response.data) if (typeof row.id === "string" && typeof row.allowed === "boolean")
            rows.push({ id: row.id, description: text(row.description), allowed: row.allowed,
              reason: row.allowed ? null : "管理员限制不允许使用此权限档。" });
          cursor = response.nextCursor || null;
          if (cursor && seen.has(cursor)) throw new Error("分页游标重复。");
          if (cursor) seen.add(cursor);
        } while (cursor);
        return rows;
      }),
      includeConfig ? section(async () => {
        const response = await request("config/read", { cwd: cwd(), includeLayers: true });
        if (!response.config || typeof response.config !== "object") throw new Error("配置返回格式无效。");
        return { values: summary(response.config), layers: (response.layers || []).map(layer => ({
          type: text(layer.name?.type), path: text(layer.name?.file || layer.name?.dotCodexFolder || layer.name?.path),
          disabled: Boolean(layer.disabledReason), values: summary(layer.config)
        })) };
      }) : Promise.resolve(null)
    ]);
    check();
    if (generation !== revision) throw new Error("配置已刷新，请重试。");
    current = { requirements: req, profiles, ...(config ? { config } : {}), legacy: legacyOptions(req.status === "ready" ? req.data : null) };
    return current;
  }
  function validate(profileId, legacyId, plan = false) {
    const options = legacyOptions(current.requirements.status === "ready" ? current.requirements.data : null);
    if (plan && !options.find(v => v.id === "readOnly").allowed) throw new Error("管理员限制不允许 Plan 的只读权限组合。");
    if (profileId && !plan) {
      if (current.profiles.status !== "ready") throw new Error("无法验证已保存的权限档，请刷新或选择其他权限。");
      const profile = current.profiles.data.find(v => v.id === profileId);
      if (!profile?.allowed) throw new Error("已保存的权限档不存在或被管理员禁止，请选择其他权限。");
      return { permissions: profileId };
    }
    const id = plan ? "readOnly" : legacyId;
    if (!options.find(v => v.id === id)?.allowed) throw new Error("管理员限制不允许此执行权限。");
    return LEGACY[id];
  }
  return { load, validate, snapshot: () => current };
}
module.exports = { createConfigurationController, legacyOptions, summary, requirements };
