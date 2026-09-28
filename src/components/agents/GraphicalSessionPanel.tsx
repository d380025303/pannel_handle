import { memo, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AgentModelSource, CodexCapabilityReference, TerminalSession } from "../../vite-env";
import { CodexAppServerSession, type CodexAppServerSessionHandle } from "./CodexAppServerSession";

type Props = {
  session: TerminalSession;
  isActive: boolean;
  draft: string;
  draftReferences: CodexCapabilityReference[];
  onDraftChange: (sessionId: string, value: SetStateAction<string>) => void;
  onDraftReferencesChange: (sessionId: string, value: SetStateAction<CodexCapabilityReference[]>) => void;
  onLinkClick: (session: TerminalSession, href: string) => void;
  onReconnectModels?: (sessionId: string) => Promise<void>;
  onSwitchCodeBuddyModel?: (sessionId: string, source: AgentModelSource, modelId?: string) => Promise<void>;
  onSwitchCodexModel?: (sessionId: string, source: AgentModelSource, modelId?: string) => Promise<void>;
  sessionRefs: Map<string, CodexAppServerSessionHandle>;
};

export const GraphicalSessionPanel = memo(function GraphicalSessionPanel({ session, isActive, draft, draftReferences, onDraftChange, onDraftReferencesChange, onLinkClick, onReconnectModels, onSwitchCodeBuddyModel, onSwitchCodexModel, sessionRefs }: Props) {
  const sessionId = session.id;
  const setDraft: Dispatch<SetStateAction<string>> = useCallback(value => onDraftChange(sessionId, value), [onDraftChange, sessionId]);
  const setDraftReferences: Dispatch<SetStateAction<CodexCapabilityReference[]>> = useCallback(value => onDraftReferencesChange(sessionId, value), [onDraftReferencesChange, sessionId]);
  const setSessionRef = useCallback((handle: CodexAppServerSessionHandle | null) => {
    if (handle) sessionRefs.set(sessionId, handle);
    else sessionRefs.delete(sessionId);
  }, [sessionId, sessionRefs]);
  const handleLinkClick = useCallback((href: string) => onLinkClick(session, href), [onLinkClick, session]);

  return <div className="graphical-session-panel" style={{ display: isActive ? undefined : "none" }} aria-hidden={!isActive}>
    <CodexAppServerSession ref={setSessionRef} sessionId={sessionId} session={session} sessionType={session.type}
      onReconnectModels={onReconnectModels} onSwitchCodeBuddyModel={onSwitchCodeBuddyModel} onSwitchCodexModel={onSwitchCodexModel}
      isActive={isActive} onLinkClick={handleLinkClick} draft={draft} draftReferences={draftReferences}
      setDraft={setDraft} setDraftReferences={setDraftReferences} />
  </div>;
});
