const { randomUUID } = require("node:crypto");

const DEFAULT_ROLES = [
  ["Agent 运行架构", ["electron/services/*-acp/**", "electron/services/codex-app-server/**"], ["lifecycle", "concurrency", "permissions"]],
  ["终端与会话", ["electron/terminal/**", "electron/hooks/**"], ["lifecycle", "reconnection"]],
  ["SSH 与远程连接", ["electron/ssh/**", "electron/services/remote-files/**"], ["timeouts", "resource-leaks"]],
  ["Electron 安全", ["electron/main.cjs", "electron/preload.cjs", "electron/core/**"], ["ipc", "trust-boundary"]],
  ["前端架构", ["src/**"], ["state", "coupling", "error-handling"]],
  ["移动端", ["mobile/**", "electron/services/mobile-remote/**"], ["authentication", "consistency"]],
  ["数据与可靠性", ["electron/stores/**", "electron/services/conversation-history/**"], ["persistence", "migration"]],
  ["跨模块架构治理", ["package.json", "scripts/**", "electron/services/project-inspector/**"], ["dependencies", "tests"]]
];
function matches(file, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(file);
}
function suggestRoles(projectId, profile) {
  let suggestions = DEFAULT_ROLES.filter(([, paths]) => paths.some(pattern => profile.files.some(file => matches(file, pattern))));
  if (suggestions.length < 5) {
    const dirs = [...new Set(profile.files.filter(file => file.includes("/")).map(file => file.split("/")[0]))];
    suggestions = dirs.slice(0, 9).map(dir => [`${dir} 模块负责人`, [`${dir}/**`], ["robustness", "error-handling", "tests"]]);
    suggestions.push(["跨模块架构治理", ["*"], ["dependencies", "tests"]]);
  }
  for (const [name, focus] of [["安全边界复核", ["security", "permissions"]], ["异常与健壮性", ["error-handling", "lifecycle"]], ["测试与兼容性", ["tests", "compatibility"]], ["状态与数据一致性", ["state", "persistence"]]]) {
    if (suggestions.length >= 5) break;
    suggestions.push([name, ["**"], focus]);
  }
  return suggestions.slice(0, 10).map(([name, paths, focus]) => ({ id: randomUUID(), projectId, name, paths, focus,
    enabled: true, confirmed: false, provider: "codex", readOnly: true, intervalMinutes: 10080,
    incrementalOnChange: true, maxFilesPerRun: 120, maxTokensPerRun: 90000, nextRunAt: Date.now() + 604800000 }));
}
function validateRole(role) {
  if (typeof role.name !== "string" || !role.name.trim() || role.name.length > 100) throw new Error("负责人名称无效。");
  if (!Array.isArray(role.paths) || !role.paths.length || role.paths.length > 30 || role.paths.some(value => typeof value !== "string" || value.length > 512 || value.includes("..") || value.includes(":") || value.includes("\\") || value.startsWith("/"))) throw new Error("负责人路径规则无效。");
  if (!Array.isArray(role.focus) || role.focus.length > 30 || role.focus.some(value => typeof value !== "string" || value.length > 100)) throw new Error("检查类别无效。");
  for (const [key, min, max] of [["intervalMinutes", 5, 525600], ["maxFilesPerRun", 1, 1000], ["maxTokensPerRun", 1000, 200000]]) {
    if (!Number.isInteger(role[key]) || role[key] < min || role[key] > max) throw new Error(`负责人 ${key} 超出范围。`);
  }
  for (const key of ["enabled", "confirmed", "incrementalOnChange"]) if (typeof role[key] !== "boolean") throw new Error(`负责人 ${key} 无效。`);
  return { ...role, provider: "codex", readOnly: true };
}
module.exports = { suggestRoles, validateRole, matches };
