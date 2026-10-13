type SummaryItem = { id: string; type: string; summary?: Array<string | { text?: string }> };

export function applySummaryTextDeltas<T extends SummaryItem>(items: T[], deltas?: Array<{ itemId: string; summaryIndex: number; delta: string }>): T[] {
  const result = [...items];
  for (const text of deltas || []) {
    const index = result.findIndex(item => item.id === text.itemId && item.type === "reasoning");
    if (index < 0 || !Number.isSafeInteger(text.summaryIndex) || text.summaryIndex < 0) continue;
    const summary = [...(result[index].summary || [])];
    const previous = summary[text.summaryIndex];
    summary[text.summaryIndex] = (typeof previous === "string" ? previous : previous?.text || "") + text.delta;
    result[index] = { ...result[index], summary };
  }
  return result;
}
