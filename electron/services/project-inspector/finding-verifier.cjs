const { createHash, randomUUID } = require("node:crypto");
const { safePath, redact } = require("./project-profiler.cjs");

function verifyFinding(candidate, { projectId, roleId, runId, headCommit, sources }) {
  if (!candidate || typeof candidate.title !== "string" || !candidate.title.trim() || candidate.title.length > 240) throw new Error("问题标题无效。");
  if (!["P0", "P1", "P2", "P3"].includes(candidate.severity)) throw new Error("问题严重级别无效。");
  if (!["confirmed", "suspected", "architectural_suggestion"].includes(candidate.type)) throw new Error("问题类型无效。");
  const location = candidate.location;
  if (!location || !safePath(location.path) || !sources.has(location.path)) throw new Error("问题定位超出本次巡检范围。");
  const lines = sources.get(location.path).split(/\r?\n/);
  if (!Number.isInteger(location.startLine) || location.startLine < 1 || location.startLine > lines.length) throw new Error("问题行号无效。");
  const endLine = location.endLine ?? location.startLine;
  if (!Number.isInteger(endLine) || endLine < location.startLine || endLine > lines.length || endLine - location.startLine > 80) throw new Error("问题结束行号无效。");
  const excerpt = lines.slice(location.startLine - 1, endLine).join("\n");
  if (typeof candidate.anchor !== "string" || candidate.anchor.trim().length < 4 || !excerpt.includes(candidate.anchor)) throw new Error("代码锚点与 Git 快照不一致。");
  if (!Array.isArray(candidate.observations) || !candidate.observations.length || candidate.observations.length > 20 || candidate.observations.some(item => typeof item !== "string" || item.length > 4000)) throw new Error("缺少有效检测证据。");
  if (typeof candidate.recommendation !== "string" || !candidate.recommendation.trim() || candidate.recommendation.length > 8000) throw new Error("缺少有效修改建议。");
  if (typeof candidate.ruleId !== "string" || !/^[a-z0-9-]{3,100}$/.test(candidate.ruleId)) throw new Error("根因规则无效。");
  const fingerprint = createHash("sha256").update([candidate.ruleId, location.path, location.symbol || "", candidate.anchor.replace(/\s+/g, " ").trim()].join("\n")).digest("hex");
  const now = Date.now();
  return { id: randomUUID(), projectId, roleId, runId, headCommit, fingerprint, title: redact(candidate.title),
    severity: candidate.severity, type: candidate.type === "confirmed" ? "suspected" : candidate.type,
    confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)), verification: "evidence_supported",
    status: "awaiting_review", revision: 1, location: { path: location.path, startLine: location.startLine, endLine, symbol: String(location.symbol || "").slice(0, 200) },
    ruleId: candidate.ruleId, anchor: redact(candidate.anchor), evidence: { excerpt, observations: candidate.observations.map(redact), reproduction: null, counterEvidence: [], testResult: null },
    recommendation: redact(candidate.recommendation), impact: redact(String(candidate.impact || "").slice(0, 4000)), createdAt: now, updatedAt: now, lastVerifiedAt: now };
}
function mergeFinding(previous, finding) {
  if (!previous) return finding;
  const elevated = finding.severity < previous.severity;
  return { ...finding, id: previous.id, createdAt: previous.createdAt, revision: previous.revision + 1,
    roleId: previous.roleId, roleName: previous.roleName, collaboratorRoleIds: [...new Set([...(previous.collaboratorRoleIds || []), finding.roleId])].filter(id => id !== previous.roleId),
    status: (previous.status === "resolved" || (elevated && previous.status === "ignored")) ? "awaiting_review" : previous.status,
    planSessionId: previous.planSessionId, implementationSessionId: previous.implementationSessionId };
}
module.exports = { verifyFinding, mergeFinding };
