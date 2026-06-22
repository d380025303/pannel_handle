import type { CompletionDebugPayload, CompletionDebugRequest } from "../../vite-env";

export type CompletionDebugEntry = {
  requestId: string;
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  status: "pending" | "success" | "error";
  request?: CompletionDebugRequest;
  durationMs?: number;
  httpStatus?: number;
  responseBody?: string;
  completion?: string;
  error?: string;
};

export const MAX_COMPLETION_DEBUG_ENTRIES = 100;

export function mergeCompletionDebugEvent(
  entries: CompletionDebugEntry[],
  event: CompletionDebugPayload
) {
  const index = entries.findIndex((entry) => entry.requestId === event.requestId);
  if (index < 0 && event.phase !== "request") return entries;
  const previous = index >= 0 ? entries[index] : undefined;
  const next: CompletionDebugEntry = {
    requestId: event.requestId,
    sessionId: event.sessionId,
    startedAt: previous?.startedAt ?? event.timestamp,
    updatedAt: event.timestamp,
    status: event.phase === "request" ? "pending" : event.status ?? "error",
    request: event.request ?? previous?.request,
    durationMs: event.durationMs ?? previous?.durationMs,
    httpStatus: event.httpStatus ?? previous?.httpStatus,
    responseBody: event.responseBody ?? previous?.responseBody,
    completion: event.completion ?? previous?.completion,
    error: event.error ?? previous?.error
  };

  const result = index >= 0
    ? entries.map((entry, entryIndex) => entryIndex === index ? next : entry)
    : [...entries, next];
  return result.slice(-MAX_COMPLETION_DEBUG_ENTRIES);
}
