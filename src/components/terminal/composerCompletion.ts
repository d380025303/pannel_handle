export type CompletionCandidate = {
  completion: string;
  draft: string;
  cursor: number;
};

export function isCurrentCompletion(candidate: CompletionCandidate | null, draft: string, cursor: number) {
  return Boolean(candidate && candidate.draft === draft && candidate.cursor === cursor && candidate.completion);
}

export function applyCompletion(draft: string, cursor: number, completion: string) {
  return {
    value: `${draft.slice(0, cursor)}${completion}${draft.slice(cursor)}`,
    cursor: cursor + completion.length
  };
}
