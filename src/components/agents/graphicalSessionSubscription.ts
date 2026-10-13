import { applySummaryTextDeltas } from "../../utils/summaryTextDeltas";
import { applyTeamTextDeltas } from "../../utils/teamTextDeltas";
import type { CodexAppServerDelta, CodexAppServerSnapshot } from "../../vite-env";

import { applySubAgentTextDeltas } from "../../utils/subAgentTextDeltas";

type Callbacks = {
  onSnapshot: (snapshot: CodexAppServerSnapshot) => void;
  onError: (error: unknown) => void;
};

export function subscribeGraphicalSession(sessionId: string, { onSnapshot, onError }: Callbacks) {
  let active = true;
  let current: CodexAppServerSnapshot | null = null;
  let loading = false;
  let fullChangeSeen = false;
  let missedRevision = -1;
  let missedStreamId: string | null = null;
  const accept = (snapshot: CodexAppServerSnapshot) => {
    if (!active || (current?.streamId && current.streamId === snapshot.streamId
      && (current.revision ?? -1) > (snapshot.revision ?? -1))) return;
    current = snapshot;
    onSnapshot(snapshot);
  };
  const reload = (initial = false) => {
    if (loading) return;
    loading = true;
    void window.codexAppServerApi.snapshot(sessionId).then(snapshot => {
      if (!initial || !fullChangeSeen) accept(snapshot);
    })
      .catch(error => { if (active) onError(error); }).finally(() => {
        loading = false;
        if (active && current?.streamId === missedStreamId && (current.revision ?? -1) < missedRevision) reload();
      });
  };
  const off = window.codexAppServerApi.onChanged(payload => {
    if (!active || payload.id !== sessionId) return;
    fullChangeSeen = true;
    accept(payload.snapshot);
  });
  const offDelta = window.codexAppServerApi.onDelta((delta: CodexAppServerDelta) => {
    if (!active || delta.id !== sessionId) return;
    if (current?.streamId && current.streamId !== delta.streamId) return;
    if (current && (current.revision ?? -1) >= delta.revision) return;
    if (!current || current.threadId !== delta.threadId || current.revision !== delta.baseRevision) {
      missedRevision = Math.max(missedRevision, delta.revision);
      missedStreamId = delta.streamId;
      reload();
      return;
    }
    const items = applySummaryTextDeltas(current.items, delta.summaryDeltas);
    for (const text of delta.textDeltas) {
      if (text.memberName !== undefined) continue;
      const index = items.findIndex(value => value.id === text.itemId);
      if (index >= 0) items[index] = { ...items[index], text: (items[index].text || "") + text.delta };
    }
    for (const item of delta.items) {
      const index = items.findIndex(value => value.id === item.id);
      if (index < 0) items.push(item); else items[index] = item;
    }
    const turnDiffs = [...(current.turnDiffs || [])];
    for (const diff of delta.turnDiffs) {
      const index = turnDiffs.findIndex(value => value.turnId === diff.turnId);
      if (index < 0) turnDiffs.push(diff); else turnDiffs[index] = diff;
    }
    accept({ ...current, revision: delta.revision, items, turnDiffs,
      team: applyTeamTextDeltas(current.team, delta.textDeltas),
      subAgents: applySubAgentTextDeltas(current.subAgents, delta.subAgentTextDeltas) });
  });
  reload(true);
  return () => { active = false; off(); offDelta(); };
}
