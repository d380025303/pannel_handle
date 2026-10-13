import type { CodexAppServerDelta, CodexAppServerSnapshot } from "../vite-env";

export function applyTeamTextDeltas(team: CodexAppServerSnapshot["team"], deltas: CodexAppServerDelta["textDeltas"]) {
  if (!team || !deltas.some(delta => delta.memberName !== undefined)) return team;
  return { ...team, members: team.members.map(member => {
    const updates = deltas.filter(delta => delta.memberName === member.name);
    if (!updates.length) return member;
    return { ...member, items: member.items.map(item => {
      const changes = updates.filter(delta => delta.itemId === item.id);
      return changes.length ? { ...item, text: (item.text || "") + changes.map(change => change.delta).join("") } : item;
    }) };
  }) };
}
