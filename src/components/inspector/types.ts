export interface InspectorTemplate { id: string; title: string; cwd: string; type: "windows" | "wsl" | "ssh"; agent: string; unsupportedReason?: string | null; }
export interface InspectorProject {
  sourceTemplateId?: string; sourceTemplateTitle?: string; workspaceType?: string; agent?: string;
  stageAgents?: Partial<Record<"inspection" | "planning" | "implementation", { templateId: string; title: string; agent: string; unsupportedReason?: string | null }>>;
  id: string; name: string; rootPath: string; headCommit: string; dirty: boolean;
  profile?: { stack: string[]; fileCount: number; tests: string[]; dependencies: string[] };
}
export interface InspectorPlanSession {
  id: string; findingId: string; sessionId?: string; status: string; mode: string; executionPermission: string;
  approvedHeadCommit: string; planOutput?: string; threadId?: string;
}
export interface InspectorRole {
  id: string; projectId: string; name: string; paths: string[]; focus: string[]; enabled: boolean; confirmed: boolean;
  intervalMinutes: number; incrementalOnChange: boolean; maxFilesPerRun: number; maxTokensPerRun: number; lastRunAt?: number;
}
export interface InspectorFinding {
  id: string; projectId: string; roleId: string; roleName?: string; collaboratorRoleIds?: string[]; title: string; severity: string; status: string; type: string;
  confidence: number; verification: string; revision: number; headCommit: string; createdAt: number;
  location: { path: string; startLine: number; endLine: number; symbol?: string };
  evidence: { excerpt: string; observations: string[]; reproduction?: string | null; counterEvidence: string[] };
  recommendation: string; impact: string;
}
export interface InspectorRun {
  id: string; roleId: string; trigger: string; status: string; headCommit: string; baseCommit?: string; createdAt: number;
  impact?: { full: boolean; reason: string; changedFiles: string[]; affectedFiles: number | null };
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number };
  dirty: boolean; scope: string; engine: string; summary?: string; error?: string;
  stats?: { usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }; files: number; totalFiles: number; truncated: boolean; durationMs: number; findings: number; rejected: number };
}
export interface InspectorSettings {
  stageTemplateIds?: Partial<Record<"inspection" | "planning" | "implementation", string>>;
  schedulerEnabled: boolean; gitEnabled: boolean; incremental: boolean; concurrency: number; timeoutSeconds: number;
  maxTokensPerRun: number; model: string; notifications: boolean; missedRunPolicy: string; engine: "static" | "codex";
}
export interface ProjectInspectorApi {
  verifyImplementation(input: { findingId: string; expectedRevision: number; digest: string }): Promise<InspectorImplementationSession>;
  approveMerge(input: { findingId: string; expectedRevision: number; digest: string }): Promise<InspectorImplementationSession>;
  approveImplementation(input: { findingId: string; expectedRevision: number; planId: string; title?: string }): Promise<InspectorImplementationSession>;
  openImplementation(findingId: string): Promise<InspectorImplementationSession>;
  getImplementation(findingId: string): Promise<InspectorImplementationSession | null>;
  reviewImplementation(findingId: string): Promise<InspectorImplementationSession>;
  approvePlanning(input: { findingId: string; expectedRevision: number; title?: string }): Promise<InspectorPlanSession>;
  getPlan(findingId: string): Promise<InspectorPlanSession | null>;
  openPlan(findingId: string): Promise<InspectorPlanSession>;
  listProjects(): Promise<InspectorProject[]>;
  listProjectTemplates(): Promise<InspectorTemplate[]>;
  relinkProject(input: { projectId: string; templateId: string }): Promise<InspectorProject>;
  addProject(input: { templateId: string }): Promise<InspectorProject>;
  chooseProject(): Promise<string | null>;
  profileProject(id: string): Promise<InspectorProject["profile"]>;
  mergeRoles(input: { ids: string[]; name: string }): Promise<InspectorRole>;
  listRoles(id: string): Promise<InspectorRole[]>;
  updateRole(input: Partial<InspectorRole> & { id: string }): Promise<InspectorRole>;
  startInspection(input: { projectId: string; roleId?: string; incremental?: boolean; trigger?: string }): Promise<InspectorRun[]>;
  cancelInspection(id: string): Promise<void>;
  listInspectionRuns(id: string): Promise<InspectorRun[]>;
  listFindings(query: { projectId: string; roleId?: string; severity?: string; status?: string }): Promise<{ items: InspectorFinding[]; total: number }>;
  getFinding(id: string): Promise<InspectorFinding>;
  decideFinding(input: { id: string; expectedRevision: number; action: string; reason?: string }): Promise<InspectorFinding>;
  getUsage(id: string): Promise<InspectorUsage>;
  getSettings(id: string): Promise<InspectorSettings>;
  updateSettings(input: { projectId: string; patch: Partial<InspectorSettings> }): Promise<InspectorSettings>;
  onEvent(callback: (event: { type: string; projectId: string | null; data: unknown }) => void): () => void;
}

export interface InspectorImplementationSession extends InspectorPlanSession {
  sealed?: boolean;
  verification?: { status: string; passed?: boolean; headCommit?: string; error?: string; results?: { script: string; exitCode: number; passed: boolean; output: string; timedOut: boolean; truncated: boolean; durationMs: number }[] };
  merge?: { headCommit: string; mergedAt: number };
  reinspectionError?: string;
  reinspection?: { status: string; summary: string; headCommit: string };
  implementationOutput?: string;
  workspace?: { id: string; cwd: string; branch: string; baseCommit: string };
  review?: { headCommit: string; dirty: boolean; status: string; diff: string; digest: string; files: string[]; reviewedAt: number };
  error?: string;
}

export interface InspectorUsage {
  inputTokens: number; outputTokens: number; cachedInputTokens: number; unknownRuns: number;
  roles: { roleId: string; inputTokens: number; outputTokens: number; cachedInputTokens: number; runs: number }[];
}
