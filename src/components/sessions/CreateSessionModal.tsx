import { useEffect, useMemo, useState } from "react";
import { Box, Server, Terminal } from "lucide-react";
import { SessionEnvironmentFields } from "../environment/SessionEnvironmentFields";
import { TagInput } from "../shared/TagInput";
import { useI18n } from "../../i18n";
import type { EnvironmentSelection, AgentLocation, AgentProvider, AgentModelSource, CodexBackend, RemotePlatform, SshConfig, WindowsShell } from "../../vite-env";
import { windowsShellLabel, windowsCommandExample } from "../../utils/windowsShell";
import { AgentLocationSelect } from "./AgentLocationSelect";
import { AgentProviderSelect } from "./AgentProviderSelect";
import { AgentSessionModeCheckbox } from "./AgentSessionModeCheckbox";
import { CodexBackendFields } from "./CodexBackendFields";
import { AgentModelSourceFields } from "./AgentModelSourceFields";
import { LocalAgentWorkingDirectoryField } from "./LocalAgentWorkingDirectoryField";
import { supportsLocalBridge } from "./agentProviders";
import { SessionFormSection, SessionModalLayout } from "./SessionModalLayout";

export type CreateSessionRequest = EnvironmentSelection & {
  selectedShellId: string;
  title?: string;
  cwd?: string;
  initialCommand?: string;
  agentProvider?: AgentProvider;
  graphicalSessionEnabled?: boolean;
  agentLocation?: AgentLocation;
  localAgentCwd?: string;
  codexBackend?: CodexBackend;
  codexModel?: string;
  codexExperimentalAcknowledged?: boolean;
  modelSource?: AgentModelSource;
  modelId?: string;
  sshConfig?: SshConfig;
  tags?: string[];
};

type CreateSessionModalProps = {
  defaultWindowsShell: WindowsShell;
  wslDistros: string[];
  tagSuggestions: string[];
  onCreate: (request: CreateSessionRequest) => Promise<void>;
  onCancel: () => void;
};

export function CreateSessionModal({ defaultWindowsShell, wslDistros, tagSuggestions, onCreate, onCancel }: CreateSessionModalProps) {
  const { t } = useI18n();
  const [environment, setEnvironment] = useState<EnvironmentSelection>({});
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [agentProvider, setAgentProvider] = useState<AgentProvider | undefined>();
  const [agentLocation, setAgentLocation] = useState<AgentLocation>("local");
  const [localAgentCwd, setLocalAgentCwd] = useState("");
  const [codexBackend, setCodexBackend] = useState<CodexBackend>("openai");
  const [graphicalSessionEnabled, setGraphicalSessionEnabled] = useState(true);
  const [codexModel, setCodexModel] = useState<string>();
  const [codexReady, setCodexReady] = useState(true);
  const [codexExperimentalAcknowledged, setCodexExperimentalAcknowledged] = useState(false);
  const [modelSource, setModelSource] = useState<AgentModelSource>("native");
  const [modelId, setModelId] = useState<string>();
  const [agentModelReady, setAgentModelReady] = useState(true);
  const [selectedShellId, setSelectedShellId] = useState("default");
  const [sshHost, setSshHost] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshIdentityFile, setSshIdentityFile] = useState("");
  const [sshSecret, setSshSecret] = useState("");
  const [sshRemark, setSshRemark] = useState("");
  const [remotePlatform, setRemotePlatform] = useState<RemotePlatform>("auto");
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSsh = selectedShellId === "ssh";
  const environmentConfigured = Boolean(environment.environmentProfileId || environment.environmentOverrides?.length);
  const advancedSshConfigured = Boolean(sshIdentityFile.trim() || sshRemark.trim() || remotePlatform !== "auto");
  useEffect(() => {
    if (isSsh && (agentProvider === "copilot" || agentProvider === "gemini" || agentProvider === "grok")) setAgentProvider(undefined);
  }, [agentProvider, isSsh]);
  const canCreate = useMemo(
    () => (!isSsh || sshHost.trim().length > 0) && (!agentProvider || cwd.trim().length > 0) && (isSsh || (agentProvider !== "codex" || codexReady) && agentModelReady),
    [agentProvider, agentModelReady, codexReady, cwd, isSsh, sshHost]
  );

  const handleCreate = async () => {
    if (!canCreate) return;
    setError(null);
    setSubmitting(true);
    try {
      await window.environmentApi?.preview({ ...environment, type: isSsh ? "ssh" : selectedShellId.startsWith("wsl:") ? "wsl" : "windows", agentProvider, agentLocation });
      await onCreate({
        ...environment,
        selectedShellId,
        title: title.trim() || undefined,
        cwd: cwd.trim() || undefined,
        initialCommand: commandInput.trim() || undefined,
        agentProvider,
        agentLocation: isSsh && agentProvider ? (supportsLocalBridge(agentProvider) ? agentLocation : "remote") : undefined,
        localAgentCwd: isSsh && supportsLocalBridge(agentProvider) && agentLocation === "local" ? localAgentCwd.trim() || undefined : undefined,
        codexBackend: !isSsh && agentProvider === "codex" ? codexBackend : undefined,
        modelSource: !isSsh && (agentProvider === "opencode" || agentProvider === "codebuddy") ? modelSource : undefined,
        modelId: !isSsh && (agentProvider === "opencode" || agentProvider === "codebuddy") && modelSource !== "native" ? modelId : undefined,
        graphicalSessionEnabled,
        codexModel: !isSsh && agentProvider === "codex" && ["openrouter", "nararouter", "minimax", "codebuddy"].includes(codexBackend) ? codexModel : undefined,
        codexExperimentalAcknowledged: !isSsh && agentProvider === "codex" && ["openrouter", "nararouter", "minimax", "codebuddy"].includes(codexBackend) && codexModel ? codexExperimentalAcknowledged : undefined,
        tags,
        sshConfig: isSsh ? { host: sshHost.trim(), username: sshUsername.trim() || undefined, port: Number(sshPort) || 22, identityFile: sshIdentityFile.trim() || undefined, secret: sshSecret || undefined, remark: sshRemark.trim() || undefined, remotePlatform } : undefined
      });
    } catch (err: any) {
      setError(err?.message || t("session.createFailed"));
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const workingDirectoryLabel = isSsh && agentProvider && agentLocation === "local" ? t("session.remoteCwd") : t("session.cwd");
  const workingDirectoryPlaceholder = isSsh ? (remotePlatform === "windows" ? "C:\\projects\\myapp" : "/srv/app") : selectedShellId.startsWith("wsl:") ? "/home/user/project" : "C:\\projects\\myapp";
  const commandExample = isSsh || selectedShellId.startsWith("wsl:") ? "pnpm dev" : windowsCommandExample(defaultWindowsShell);

  return <SessionModalLayout title={t("session.newTitle")} subtitle={t("session.newSubtitle")} onCancel={onCancel} footer={<>
    <button className="modal-button" type="button" onClick={onCancel}>{t("common.cancel")}</button>
    <button className="modal-button primary" type="button" onClick={handleCreate} disabled={!canCreate || submitting}>{submitting ? t("session.creating") : t("session.create")}</button>
  </>}>
    {error && <div className="modal-error" role="alert">{error}</div>}

    <SessionFormSection title={t("session.basicSection")}>
      <div className="shell-list session-shell-list">
        <button type="button" className={`shell-item ${selectedShellId === "default" ? "selected" : ""}`} onClick={() => setSelectedShellId("default")}><Terminal aria-hidden="true" />{t("session.defaultShell", { shell: windowsShellLabel(defaultWindowsShell) })}</button>
        {wslDistros.map((distro) => <button key={distro} type="button" className={`shell-item ${selectedShellId === `wsl:${distro}` ? "selected" : ""}`} onClick={() => setSelectedShellId(`wsl:${distro}`)}><Box aria-hidden="true" />{distro}</button>)}
        <button type="button" className={`shell-item ${isSsh ? "selected" : ""}`} onClick={() => setSelectedShellId("ssh")}><Server aria-hidden="true" />SSH</button>
      </div>
      <label className="modal-field"><span className="modal-label">{t("session.name")}</span><input autoFocus className="modal-input" placeholder={t("session.namePlaceholder")} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="modal-field"><span className="modal-label">{workingDirectoryLabel}</span><input className="modal-input" placeholder={workingDirectoryPlaceholder} value={cwd} onChange={(event) => setCwd(event.target.value)} /></label>
      <label className="modal-field"><span className="modal-label">{t("session.tags")}</span><TagInput tags={tags} suggestions={tagSuggestions} onChange={setTags} /></label>
    </SessionFormSection>

    <SessionFormSection title={t("session.agentCli")}>
      <AgentProviderSelect hideLabel value={agentProvider} exclude={isSsh ? ["copilot", "gemini", "grok"] : []} onChange={(provider) => { setAgentProvider(provider); if (provider && !supportsLocalBridge(provider)) setAgentLocation("remote"); if (supportsLocalBridge(provider) && isSsh) setAgentLocation("local"); }} />
      {agentProvider === "codex" && !isSsh && <CodexBackendFields backend={codexBackend} model={codexModel} experimentalAcknowledged={codexExperimentalAcknowledged} onBackendChange={(backend) => { setCodexBackend(backend); setCodexModel(undefined); setCodexReady(backend === "openai"); setCodexExperimentalAcknowledged(false); }} onModelChange={(model) => { setCodexModel(model); setCodexExperimentalAcknowledged(false); }} onExperimentalAcknowledgedChange={setCodexExperimentalAcknowledged} onReadyChange={setCodexReady} />}
      {(agentProvider === "opencode" || agentProvider === "codebuddy") && !isSsh && <AgentModelSourceFields agent={agentProvider} source={modelSource as Exclude<AgentModelSource, "codebuddy">} modelId={modelId} onSourceChange={source => { setModelSource(source); setModelId(undefined); setAgentModelReady(source === "native"); }} onModelChange={setModelId} onReadyChange={setAgentModelReady} />}
      {(agentProvider === "codex" || agentProvider === "codebuddy" || agentProvider === "opencode" || agentProvider === "claude" || agentProvider === "qoder" || agentProvider === "gemini" || agentProvider === "grok") && <AgentSessionModeCheckbox provider={agentProvider} checked={graphicalSessionEnabled} onChange={setGraphicalSessionEnabled} />}
      {isSsh && agentProvider && <AgentLocationSelect value={agentLocation} provider={agentProvider} onChange={setAgentLocation} />}
      {isSsh && supportsLocalBridge(agentProvider) && agentLocation === "local" && <LocalAgentWorkingDirectoryField value={localAgentCwd} onChange={setLocalAgentCwd} />}
      {agentProvider && !cwd.trim() && <div className="modal-error">{t("session.agentCwdRequired")}</div>}
    </SessionFormSection>

    {isSsh && <SessionFormSection title={t("session.connectionSection")}>
      <div className="modal-grid two">
        <label className="modal-field"><span className="modal-label">{t("session.host")}</span><input className="modal-input" placeholder={t("session.hostPlaceholder")} value={sshHost} onChange={(event) => setSshHost(event.target.value)} /></label>
        <label className="modal-field"><span className="modal-label">{t("session.port")}</span><input className="modal-input" placeholder="22" value={sshPort} onChange={(event) => setSshPort(event.target.value)} /></label>
      </div>
      <div className="modal-grid two">
        <label className="modal-field"><span className="modal-label">{t("session.username")}</span><input className="modal-input" placeholder="root" value={sshUsername} onChange={(event) => setSshUsername(event.target.value)} /></label>
        <label className="modal-field"><span className="modal-label">{t("session.passwordOrKeyPassphrase")}</span><input className="modal-input" type="password" placeholder={t("session.passwordCreatePlaceholder")} value={sshSecret} onChange={(event) => setSshSecret(event.target.value)} /></label>
      </div>
    </SessionFormSection>}

    {isSsh && <SessionFormSection collapsible title={t("session.advancedSsh")} summary={advancedSshConfigured ? t("session.configured") : t("session.notConfigured")}>
      <label className="modal-field"><span className="modal-label">{t("session.identityFile")}</span><input className="modal-input" placeholder="C:\\Users\\me\\.ssh\\id_rsa" value={sshIdentityFile} onChange={(event) => setSshIdentityFile(event.target.value)} /></label>
      <label className="modal-field"><span className="modal-label">{t("session.remark")}</span><textarea className="modal-input modal-textarea" placeholder={t("session.remarkPlaceholder")} value={sshRemark} onChange={(event) => setSshRemark(event.target.value)} rows={2} /></label>
      <label className="modal-field"><span className="modal-label">{t("session.remotePlatform")}</span><select className="modal-input" value={remotePlatform} onChange={(event) => setRemotePlatform(event.target.value as RemotePlatform)}><option value="auto">{t("session.remotePlatformAuto")}</option><option value="linux">Linux</option><option value="windows">Windows</option></select></label>
    </SessionFormSection>}

    <SessionFormSection collapsible title={t("session.startupSection")} summary={commandInput.trim() ? t("session.configured") : t("session.notConfigured")}>
      <label className="modal-field"><span className="modal-label">{agentProvider ? t("session.preLaunchCommand") : t("session.initialCommand")}</span><textarea className="modal-input modal-textarea" placeholder={t("session.initialCommandPlaceholder", { example: commandExample })} value={commandInput} onChange={(event) => setCommandInput(event.target.value)} rows={3} />{!isSsh && !selectedShellId.startsWith("wsl:") && <span className="settings-help">{t("session.shellSyntaxHint", { shell: windowsShellLabel(defaultWindowsShell) })}</span>}</label>
    </SessionFormSection>

    <SessionFormSection collapsible title={t("session.environment")} summary={environmentConfigured ? t("session.configured") : t("session.notConfigured")}>
      <SessionEnvironmentFields embedded value={environment} onChange={setEnvironment} type={isSsh ? "ssh" : selectedShellId.startsWith("wsl:") ? "wsl" : "windows"} agentProvider={agentProvider} agentLocation={agentLocation} />
    </SessionFormSection>
  </SessionModalLayout>;
}
