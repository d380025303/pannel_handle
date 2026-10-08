import type { GraphicalSnapshot } from "./types";

export function codeBuddyMultitaskOption(snapshot: GraphicalSnapshot) {
  return snapshot.provider === "codebuddy" && snapshot.capabilities?.multitask === true
    ? snapshot.acpOptions?.find(option => option.id === "multitask" && option.type === "boolean")
    : undefined;
}
