import type { CodexSubAgents, CodexSubAgentTextDelta } from "../vite-env";

export function applySubAgentTextDeltas(subAgents: CodexSubAgents | undefined, deltas: CodexSubAgentTextDelta[] = []) {
  if (!subAgents || !deltas.length) return subAgents;
  return { ...subAgents, members: subAgents.members.map(member => {
    const updates = deltas.filter(delta => delta.threadId === member.threadId);
    if (!updates.length) return member;
    return { ...member, items: member.items.map(item => {
      const changes = updates.filter(delta => delta.itemId === item.id);
      if (!changes.length) return item;
      const next = { ...item };
      for (const change of changes) {
        if (change.field === "summary") {
          const summary = [...(next.summary || [])];
          const index = change.summaryIndex || 0;
          summary[index] = (summary[index] || "") + change.delta;
          next.summary = summary;
        } else next[change.field] = (next[change.field] || "") + change.delta;
      }
      return next;
    }) };
  }) };
}
