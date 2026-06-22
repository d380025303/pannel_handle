const SUBMIT_DELAY_MS = 30;

type TerminalWrite = (sessionId: string, data: string) => void;
type Schedule = (callback: () => void, delay: number) => unknown;

export function submitTerminalInput(
  sessionId: string,
  value: string,
  write: TerminalWrite,
  schedule: Schedule = window.setTimeout
) {
  write(sessionId, value);
  schedule(() => write(sessionId, "\r"), SUBMIT_DELAY_MS);
}
