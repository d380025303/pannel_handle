import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, MessageSquarePlus, Send, Square } from "lucide-react";
import type { AgentRunStatus, ProjectAssistantCodexSession, ProjectAssistantSnapshot } from "../../vite-env";
import { useI18n } from "../../i18n";
import { getAgentStatusLabel } from "../../utils/agentStatus";
import { CodexSessionMirror } from "./CodexSessionMirror";
import { CodexAccountPanel } from "./CodexAccountPanel";

const empty: ProjectAssistantSnapshot = { threadId: null, messages: [], pendingAction: null, busy: false, error: null };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ProjectAssistantPage({ initialSessionId }: { initialSessionId?: string }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ProjectAssistantSnapshot>(empty);
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(true);
  const [startingNewConversation, setStartingNewConversation] = useState(false);
  const [progress, setProgress] = useState("");
  const [codexSessions, setCodexSessions] = useState<ProjectAssistantCodexSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialSessionId || null);
  const [codexDraft, setCodexDraft] = useState("");
  const [codexSending, setCodexSending] = useState(false);
  const [codexError, setCodexError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const codexSessionsRequestRef = useRef(0);
  const showCodexError = useCallback((message: string) => setCodexError(message), []);
  const refreshCodexSessions = useCallback(async () => {
    const requestId = ++codexSessionsRequestRef.current;
    const sessions = await window.projectAssistantApi.listCodexSessions();
    if (requestId !== codexSessionsRequestRef.current) return;
    setCodexSessions(sessions);
    setSelectedSessionId(current => sessions.some(item => item.id === current)
      ? current : sessions.some(item => item.id === initialSessionId) ? initialSessionId! : sessions[0]?.id || null);
  }, [initialSessionId]);

  useEffect(() => {
    let live = true;
    const offChanged = window.projectAssistantApi.onChanged(value => { if (live) { setSnapshot(value); if (!value.busy) setProgress(""); } });
    const offProgress = window.projectAssistantApi.onProgress(value => { if (live) setProgress(value.text); });
    void window.projectAssistantApi.getSnapshot().then(value => { if (live) setSnapshot(value); });
    void window.projectAssistantApi.start().catch(error => {
      if (live) setSnapshot(value => ({ ...value, error: messageOf(error) }));
    }).finally(() => { if (live) setStarting(false); });
    return () => { live = false; offChanged(); offProgress(); };
  }, []);

  useEffect(() => {
    void refreshCodexSessions().catch(error => showCodexError(messageOf(error)));
    const offSessions = window.terminalApi.onSessionsChanged(() => { void refreshCodexSessions().catch(error => showCodexError(messageOf(error))); });
    const offStatus = window.terminalApi.onAgentStatus(payload => {
      if (payload.provider === "codex") void refreshCodexSessions().catch(error => showCodexError(messageOf(error)));
    });
    return () => { offSessions(); offStatus(); };
  }, [refreshCodexSessions, showCodexError]);

  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [snapshot.messages.length, snapshot.pendingAction, snapshot.busy]);

  async function send() {
    const text = draft.trim();
    if (!text || snapshot.busy || snapshot.pendingAction || startingNewConversation) return;
    setDraft("");
    try { await window.projectAssistantApi.send(text, selectedSessionId); }
    catch (error) { setSnapshot(value => ({ ...value, error: messageOf(error) })); }
  }

  async function newConversation() {
    if (starting || snapshot.busy || startingNewConversation) return;
    setStartingNewConversation(true);
    try {
      const next = await window.projectAssistantApi.newConversation();
      setSnapshot(next);
      setDraft("");
      setProgress("");
    } catch (error) { setSnapshot(value => ({ ...value, error: messageOf(error) })); }
    finally { setStartingNewConversation(false); }
  }

  async function resolve(approved: boolean) {
    try { await window.projectAssistantApi.resolve(approved); }
    catch (error) { setSnapshot(value => ({ ...value, pendingAction: null, error: messageOf(error) })); }
  }

  async function sendCodex() {
    if (!selectedSessionId || !codexDraft.trim() || codexSending) return;
    setCodexSending(true);
    setCodexError("");
    try {
      await window.projectAssistantApi.submitCodex(selectedSessionId, codexDraft);
      setCodexDraft("");
    } catch (error) { setCodexError(messageOf(error)); }
    finally { setCodexSending(false); }
  }

  async function switchMode() {
    if (!selectedSessionId) return;
    setCodexError("");
    try { await window.projectAssistantApi.switchCodexMode(selectedSessionId); }
    catch (error) { setCodexError(messageOf(error)); }
  }

  const selectedSession = codexSessions.find(item => item.id === selectedSessionId);

  return (
    <section className="project-assistant-page">
      <header className="project-assistant-heading">
        <div className="project-assistant-heading-row">
          <h1>{t("projectAssistant.title")}</h1>
          <div className="project-assistant-heading-actions">
            <CodexAccountPanel account={snapshot.account} busy={snapshot.busy} actions={{
              readAccount: window.projectAssistantApi.readAccount,
              startLogin: window.projectAssistantApi.startLogin,
              cancelLogin: window.projectAssistantApi.cancelLogin,
              logout: window.projectAssistantApi.logout,
              refreshAccountUsage: window.projectAssistantApi.refreshAccountUsage
            }} />
            <button type="button" onClick={() => void newConversation()} disabled={starting || snapshot.busy || startingNewConversation || snapshot.account?.status === "signedOut"} aria-label={t("projectAssistant.newConversation")}><MessageSquarePlus aria-hidden="true" />{t("projectAssistant.newConversation")}</button>
          </div>
        </div>
        <p>{t("projectAssistant.description")}</p>
      </header>
      <div className="project-assistant-workspace">
      <div className="project-assistant-chat">
      <div className="project-assistant-messages" aria-live="polite">
        {snapshot.messages.length === 0 && <div className="project-assistant-empty">{t("projectAssistant.empty")}</div>}
        {snapshot.messages.map((message, index) => (
          <div key={`${message.at}-${index}`} className={`project-assistant-message ${message.role}`}>
            <small>{message.role === "user" ? t("projectAssistant.you") : message.role === "assistant" ? t("projectAssistant.title") : t("projectAssistant.application")}</small>
            <p>{message.text}</p>
          </div>
        ))}
        {snapshot.busy && <div className="project-assistant-working"><LoaderCircle aria-hidden="true" /><span>{progress || t("projectAssistant.thinking")}</span></div>}
        {snapshot.pendingAction && (
          <div className="project-assistant-confirm" role="group" aria-label={t("projectAssistant.confirm")}>
            <strong>{t("projectAssistant.confirm")}</strong>
            <p>{snapshot.pendingAction.label}</p>
            <div>
              <button type="button" onClick={() => void resolve(false)}>{t("projectAssistant.reject")}</button>
              <button type="button" className="primary" onClick={() => void resolve(true)}>{t("projectAssistant.execute")}</button>
            </div>
          </div>
        )}
        {snapshot.error && <div className="project-assistant-error" role="alert">{snapshot.error}</div>}
        <div ref={endRef} />
      </div>
      <form className="project-assistant-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
        }} placeholder={t("projectAssistant.placeholder")} maxLength={4000} disabled={starting || startingNewConversation || Boolean(snapshot.pendingAction) || snapshot.account?.status === "signedOut"} />
        {snapshot.busy ? (
          <button type="button" onClick={() => void window.projectAssistantApi.stop()} aria-label={t("projectAssistant.stop")}><Square aria-hidden="true" /></button>
        ) : (
          <button type="submit" disabled={!draft.trim() || starting || startingNewConversation || Boolean(snapshot.pendingAction) || snapshot.account?.status === "signedOut"} aria-label={t("projectAssistant.send")}><Send aria-hidden="true" /></button>
        )}
      </form>
      </div>
      <section className="project-assistant-codex" aria-label={t("projectAssistant.codexSessions")}>
        <header className="project-assistant-codex-header">
          <div>
            <strong>{t("projectAssistant.codexSessions")}</strong>
            {selectedSession && <small>{selectedSession.type.toUpperCase()} · {getAgentStatusLabel({ id: selectedSession.id, provider: "codex", status: selectedSession.status as AgentRunStatus, eventName: "", timestamp: 0 }, t) || t("projectAssistant.statusUnknown")}</small>}
          </div>
          <select value={selectedSessionId || ""} onChange={event => { setSelectedSessionId(event.target.value || null); setCodexDraft(""); setCodexError(""); }} aria-label={t("projectAssistant.selectCodexSession")}>
            {codexSessions.length === 0 && <option value="">{t("projectAssistant.noCodexSessions")}</option>}
            {codexSessions.map(session => <option key={session.id} value={session.id}>{session.title} ({session.id})</option>)}
          </select>
          <button type="button" onClick={() => void switchMode()} disabled={!selectedSessionId}>{t("projectAssistant.switchMode")}</button>
        </header>
        {selectedSession ? <CodexSessionMirror key={selectedSession.id} sessionId={selectedSession.id} onError={showCodexError} />
          : <p className="project-assistant-codex-empty">{t("projectAssistant.noCodexSessions")}</p>}
        <p className="project-assistant-codex-hint">{t("projectAssistant.questionHint")}</p>
        {codexError && <div className="project-assistant-error" role="alert">{codexError}</div>}
        <form className="project-assistant-codex-composer" onSubmit={event => { event.preventDefault(); void sendCodex(); }}>
          <textarea value={codexDraft} onChange={event => setCodexDraft(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendCodex(); }
          }} placeholder={t("projectAssistant.codexPlaceholder")} disabled={!selectedSessionId || codexSending} />
          <button type="submit" disabled={!selectedSessionId || !codexDraft.trim() || codexSending}>{t("projectAssistant.sendToCodex")}</button>
        </form>
      </section>
      </div>
    </section>
  );
}
