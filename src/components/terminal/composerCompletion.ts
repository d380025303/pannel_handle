export type CompletionCandidate = {
  candidateId: string;
  completion: string;
  mode: "agent" | "shell";
  source: "model" | "history";
  confidence?: number;
  draft: string;
  cursor: number;
};

export function editDistance(left: string, right: string) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let prefixLength = 0;
  while (prefixLength < left.length && prefixLength < right.length && left[prefixLength] === right[prefixLength]) {
    prefixLength += 1;
  }
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > prefixLength && rightEnd > prefixLength && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  left = left.slice(prefixLength, leftEnd);
  right = right.slice(prefixLength, rightEnd);
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function getCompletionTrigger(mode: "agent" | "shell", draft: string) {
  if (!draft.trim()) return null;
  if (mode === "agent" && draft.replace(/\s/g, "").length < 4) return null;
  return { modelDelayMs: mode === "agent" ? 700 : 500, checkLocalHistory: mode === "shell" };
}

export function isCurrentCompletion(candidate: CompletionCandidate | null, draft: string, cursor: number) {
  return Boolean(candidate && candidate.draft === draft && candidate.cursor === cursor && candidate.completion);
}

export function applyCompletion(draft: string, cursor: number, completion: string) {
  return {
    value: `${draft.slice(0, cursor)}${completion}${draft.slice(cursor)}`,
    cursor: cursor + completion.length
  };
}
