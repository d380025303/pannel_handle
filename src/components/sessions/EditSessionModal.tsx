import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { SessionEnvironmentFields } from "../environment/SessionEnvironmentFields";
import { SearchableSelect } from "../shared/SearchableSelect";
import { TagInput } from "../shared/TagInput";
import { useI18n } from "../../i18n";
import { generateId } from "../../utils/id";
import { windowsCommandExample } from "../../utils/windowsShell";
import type { EnvironmentSelection, AgentLocation, AgentProvider, CodexBackend, QuickCommand, RemotePlatform, SshConfig, TerminalSession } from "../../vite-env";
import { AgentLocationSelect } from "./AgentLocationSelect";
import { AgentProviderSelect } from "./AgentProviderSelect";
import { CodexBackendFields } from "./CodexBackendFields";
import { LocalAgentWorkingDirectoryField } from "./LocalAgentWorkingDirectoryField";
import { supportsLocalBridge } from "./agentProviders";
import { SessionFormSection, SessionModalLayout } from "./SessionModalLayout";

type EditSessionModalProps = {
  session: TerminalSession;
  tagSuggestions: string[];
  onSave: (id: string, title: string, cwd: string, initialCommand: string, agentProvider?: AgentProvider, agentLocation?: AgentLocation, localAgentCwd?: string, codexBackend?: CodexBackend, codexModel?: string, quickCommands?: QuickCommand[], sshConfig?: SshConfig, tags?: string[], codexExperimentalAcknowledged?: boolean, environment?: EnvironmentSelection, codexAppServerEnabled?: boolean, codeBuddyAcpEnabled?: boolean, openCodeAcpEnabled?: boolean) => Promise<void>;
  onCancel: () => void;
};

export function EditSessionModal({ session, tagSuggestions, onSave, onCancel }: EditSessionModalProps) {
  const { t } = useI18n();
  const [environment, setEnvironment] = useState<EnvironmentSelection>({ environmentProfileId: session.environmentProfileId, environmentOverrides: session.environmentOverrides });
  const [editTitle, setEditTitle] = useState(session.title);
  const [editCwd, setEditCwd] = useState(session.cwd);
  const [editCommand, setEditCommand] = useState(session.initialCommand || session.sshConfig?.remoteCommand || "");
  const [agentProvider, setAgentProvider] = useState<AgentProvider | undefined>(session.agentProvider);
  const [agentLocation, setAgentLocation] = useState<AgentLocation>(session.agentLocation || "remote");
  const [localAgentCwd, setLocalAgentCwd] = useState(session.localAgentCwd || "");
  const [codexBackend, setCodexBackend] = useState<CodexBackend>(session.codexBackend || "openai");
  const [codexAppServerEnabled, setCodexAppServerEnabled] = useState(session.codexAppServerEnabled !== false);
  const [codeBuddyAcpEnabled, setCodeBuddyAcpEnabled] = useState(session.codeBuddyAcpEnabled === true);
  const [openCodeAcpEnabled, setOpenCodeAcpEnabled] = useState(session.openCodeAcpEnabled === true);
  const [codexModel, setCodexModel] = useState<string | undefined>(session.codexModel);
  const [codexReady, setCodexReady] = useState(true);
  const [codexExperimentalAcknowledged, setCodexExperimentalAcknowledged] = useState(session.codexExperimentalAcknowledged === true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(() => (session.quickCommands ?? []).map((command) => ({ ...command, mode: command.mode || "write" as const })));
  const [sshHost, setSshHost] = useState(session.sshConfig?.host || "");
  const [sshUsername, setSshUsername] = useState(session.sshConfig?.username || "");
  const [sshPort, setSshPort] = useState(String(session.sshConfig?.port || 22));
  const [sshIdentityFile, setSshIdentityFile] = useState(session.sshConfig?.identityFile || "");
  const [sshExtraArgs] = useState((session.sshConfig?.extraArgs || []).join(" "));
  const [sshSecret, setSshSecret] = useState("");
  const [clearSshSecret, setClearSshSecret] = useState(false);
  const [sshRemark, setSshRemark] = useState(session.sshConfig?.remark || "");
  const [remotePlatform, setRemotePlatform] = useState<RemotePlatform>(session.sshConfig?.remotePlatform || "auto");
  const [tags, setTags] = useState<string[]>(session.tags ?? []);
  const isSsh = session.type === "ssh";
  const environmentConfigured = Boolean(environment.environmentProfileId || environment.environmentOverrides?.length);
  const advancedSshConfigured = Boolean(sshIdentityFile.trim() || sshRemark.trim() || sshExtraArgs.trim() || remotePlatform !== "auto");

  const handleSave = async () => {
    if (agentProvider && !editCwd.trim()) {
      setError(t("session.agentCwdRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await window.environmentApi?.preview({ ...environment, type: session.type, agentProvider, agentLocation });
      await onSave(
        session.id,
        editTitle,
        editCwd,
        editCommand,
        agentProvider,
        isSsh && agentProvider ? (supportsLocalBridge(agentProvider) ? agentLocation : "remote") : undefined,
        isSsh && supportsLocalBridge(agentProvider) && agentLocation === "local" ? localAgentCwd.trim() || undefined : undefined,
        !isSsh && agentProvider === "codex" ? codexBackend : undefined,
        !isSsh && agentProvider === "codex" && ["openrouter", "nararouter", "minimax", "codebuddy"].includes(codexBackend) ? codexModel : undefined,
        quickCommands.filter((command) => command.command.trim().length > 0),
        isSsh ? { host: sshHost.trim(), username: sshUsername.trim() || undefined, port: Number(sshPort) || 22, identityFile: sshIdentityFile.trim() || undefined, secret: clearSshSecret ? undefined : sshSecret || undefined, clearSecret: clearSshSecret, remark: sshRemark.trim() || undefined, remotePlatform } : undefined,
        tags,
        !isSsh && agentProvider === "codex" && ["openrouter", "nararouter", "minimax", "codebuddy"].includes(codexBackend) && codexModel ? codexExperimentalAcknowledged : undefined,
        environment,
        agentProvider === "codex" ? codexAppServerEnabled : undefined,
        agentProvider === "codebuddy" ? codeBuddyAcpEnabled : undefined,
        agentProvider === "opencode" ? openCodeAcpEnabled : undefined
      );
    } catch (err: any) {
      setError(err?.message || t("session.updateFailed"));
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleAddCommand = () => setQuickCommands((previous) => [...previous, { id: generateId(), command: "", mode: "auto-enter" }]);
  const handleRemoveCommand = (id: string) => setQuickCommands((previous) => previous.filter((command) => command.id !== id));
  const handleCommandChange = (id: string, field: "command" | "mode", value: string) => setQuickCommands((previous) => previous.map((command) => command.id === id ? { ...command, [field]: value } : command));
  const commandExample = session.type === "windows" ? windowsCommandExample(session.shell) : "pnpm dev";

  return <SessionModalLayout title={t("session.editTitle")} subtitle={t("session.editSubtitle")} onCancel={onCancel} footer={<>
    <button className="modal-button" type="button" onClick={onCancel}>{t("common.cancel")}</button>
    <button className="modal-button primary" type="button" onClick={handleSave} disabled={submitting || (isSsh && sshHost.trim().length === 0) || Boolean(agentProvider && !editCwd.trim()) || Boolean(agentProvider === "codex" && !isSsh && !codexReady)}>{submitting ? t("session.saving") : t("common.save")}</button>
  </>}>
    {error && <div className="modal-error" role="alert">{error}</div>}

    <SessionFormSection title={t("session.basicSection")}>
      <label className="modal-field"><span className="modal-label">{t("session.name")}</span><input autoFocus className="modal-input" placeholder={t("session.namePlaceholder")} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label>
      <label className="modal-field"><span className="modal-label">{isSsh && agentProvider && agentLocation === "local" ? t("session.remoteCwd") : t("session.cwd")}</span><input className="modal-input" placeholder={isSsh ? (remotePlatform === "windows" ? "C:\\projects\\myapp" : "/srv/app") : session.type === "wsl" ? "/home/user/project" : "C:\\projects\\myapp"} value={editCwd} onChange={(event) => setEditCwd(event.target.value)} /></label>
      <label className="modal-field"><span className="modal-label">{t("session.tags")}</span><TagInput tags={tags} suggestions={tagSuggestions} onChange={setTags} /></label>
    </SessionFormSection>

    <SessionFormSection title={t("session.agentCli")}>
      <AgentProviderSelect hideLabel value={agentProvider} exclude={isSsh ? ["copilot", "gemini", "grok"] : []} onChange={(provider) => { setAgentProvider(provider); if (provider && !supportsLocalBridge(provider)) setAgentLocation("remote"); }} />
      {agentProvider === "codex" && !isSsh && <CodexBackendFields backend={codexBackend} model={codexModel} experimentalAcknowledged={codexExperimentalAcknowledged} onBackendChange={(backend) => { setCodexBackend(backend); setCodexModel(undefined); setCodexReady(backend === "openai"); setCodexExperimentalAcknowledged(false); }} onModelChange={(model) => { setCodexModel(model); setCodexExperimentalAcknowledged(false); }} onExperimentalAcknowledgedChange={setCodexExperimentalAcknowledged} onReadyChange={setCodexReady} />}
      {agentProvider === "codex" && <label className="modal-field"><span className="modal-label">{t("session.codexAppServer")}</span><input type="checkbox" checked={codexAppServerEnabled} onChange={event => setCodexAppServerEnabled(event.target.checked)} /><span className="settings-help">{t("session.codexAppServerHint")}</span></label>}
      {agentProvider === "codebuddy" && <label className="modal-field"><span className="modal-label">{t("session.codexAppServer")}</span><input type="checkbox" checked={codeBuddyAcpEnabled} onChange={event => setCodeBuddyAcpEnabled(event.target.checked)} /><span className="settings-help">{t("session.codeBuddyAcpHint")}</span></label>}
      {agentProvider === "opencode" && <label className="modal-field"><span className="modal-label">{t("session.openCodeAcp")}</span><input type="checkbox" checked={openCodeAcpEnabled} onChange={event => setOpenCodeAcpEnabled(event.target.checked)} /><span className="settings-help">{t("session.openCodeAcpHint")}</span></label>}
      {isSsh && agentProvider && <AgentLocationSelect value={agentLocation} provider={agentProvider} onChange={setAgentLocation} />}
      {isSsh && supportsLocalBridge(agentProvider) && agentLocation === "local" && <LocalAgentWorkingDirectoryField value={localAgentCwd} onChange={setLocalAgentCwd} />}
      {agentProvider && !editCwd.trim() && <div className="modal-error">{t("session.agentCwdRequired")}</div>}
    </SessionFormSection>

    {isSsh && <SessionFormSection title={t("session.connectionSection")}>
      <div className="modal-grid two">
        <label className="modal-field"><span className="modal-label">{t("session.host")}</span><input className="modal-input" placeholder={t("session.hostPlaceholder")} value={sshHost} onChange={(event) => setSshHost(event.target.value)} /></label>
        <label className="modal-field"><span className="modal-label">{t("session.port")}</span><input className="modal-input" placeholder="22" value={sshPort} onChange={(event) => setSshPort(event.target.value)} /></label>
      </div>
      <div className="modal-grid two">
        <label className="modal-field"><span className="modal-label">{t("session.username")}</span><input className="modal-input" placeholder="root" value={sshUsername} onChange={(event) => setSshUsername(event.target.value)} /></label>
        <label className="modal-field"><span className="modal-label">{t("session.passwordOrKeyPassphrase")}</span><input className="modal-input" type="password" placeholder={session.sshConfig?.hasSecret ? t("session.passwordEditPlaceholder") : t("session.passwordCreatePlaceholder")} value={sshSecret} disabled={clearSshSecret} onChange={(event) => setSshSecret(event.target.value)} /></label>
      </div>
      {session.sshConfig?.hasSecret && <label className="modal-checkbox-field"><input type="checkbox" checked={clearSshSecret} onChange={(event) => { setClearSshSecret(event.target.checked); if (event.target.checked) setSshSecret(""); }} /><span>{t("session.clearSavedPassword")}</span></label>}
    </SessionFormSection>}

    {isSsh && <SessionFormSection collapsible title={t("session.advancedSsh")} summary={advancedSshConfigured ? t("session.configured") : t("session.notConfigured")}>
      <label className="modal-field"><span className="modal-label">{t("session.identityFile")}</span><input className="modal-input" placeholder="C:\\Users\\me\\.ssh\\id_rsa" value={sshIdentityFile} onChange={(event) => setSshIdentityFile(event.target.value)} /></label>
      <label className="modal-field"><span className="modal-label">{t("session.sshArgs")}</span><input className="modal-input" placeholder="-o ServerAliveInterval=30" value={sshExtraArgs} disabled /></label>
      <label className="modal-field"><span className="modal-label">{t("session.remark")}</span><textarea className="modal-input modal-textarea" placeholder={t("session.remarkPlaceholder")} value={sshRemark} onChange={(event) => setSshRemark(event.target.value)} rows={2} /></label>
      <label className="modal-field"><span className="modal-label">{t("session.remotePlatform")}</span><select className="modal-input" value={remotePlatform} onChange={(event) => setRemotePlatform(event.target.value as RemotePlatform)}><option value="auto">{t("session.remotePlatformAuto")}</option><option value="linux">Linux</option><option value="windows">Windows</option></select></label>
    </SessionFormSection>}

    <SessionFormSection collapsible title={t("session.startupSection")} summary={editCommand.trim() ? t("session.configured") : t("session.notConfigured")}>
      <label className="modal-field"><span className="modal-label">{agentProvider ? t("session.preLaunchCommand") : t("session.initialCommand")}</span><textarea className="modal-input modal-textarea" placeholder={t("session.initialCommandPlaceholder", { example: commandExample })} value={editCommand} onChange={(event) => setEditCommand(event.target.value)} rows={3} />{session.type === "windows" && <span className="settings-help">{t("session.shellSyntaxHint", { shell: session.shell.split(/[\\/]/).pop() || session.shell })}</span>}</label>
    </SessionFormSection>

    <SessionFormSection collapsible title={t("session.environment")} summary={environmentConfigured ? t("session.configured") : t("session.notConfigured")}>
      <SessionEnvironmentFields embedded value={environment} onChange={setEnvironment} type={session.type} agentProvider={agentProvider} agentLocation={agentLocation} />
    </SessionFormSection>

    <SessionFormSection collapsible title={t("quickCommand.heading")} summary={quickCommands.length ? t("session.itemsConfigured", { count: quickCommands.length }) : t("session.notConfigured")}>
      <div className="quick-command-edit-list">
        {quickCommands.map((command) => <div key={command.id} className="quick-command-edit-row">
          <input className="modal-input quick-cmd-input" placeholder={t("quickCommand.commandPlaceholder")} value={command.command} onChange={(event) => handleCommandChange(command.id, "command", event.target.value)} />
          <SearchableSelect className="quick-cmd-mode-select" value={command.mode || "write"} options={[{ value: "write", label: t("quickCommand.write") }, { value: "auto-enter", label: t("quickCommand.autoEnter") }, { value: "one-time", label: t("quickCommand.oneTime") }]} ariaLabel={t("quickCommand.heading")} menuMinWidth={180} onChange={(mode) => handleCommandChange(command.id, "mode", mode)} />
          <button type="button" className="mini-action danger" onClick={() => handleRemoveCommand(command.id)} title={t("common.delete")}><X size={13} /></button>
        </div>)}
        <button type="button" className="quick-command-add-btn" onClick={handleAddCommand}><Plus size={14} /><span>{t("quickCommand.add")}</span></button>
      </div>
    </SessionFormSection>
  </SessionModalLayout>;
}
