// Persistent history contains conversation text, never protocol payloads.
const SAVED_MESSAGE_VERSION = 1;
function savedMessage(message) {
  if (!message?.id || typeof message.text !== "string" || !message.text.trim()) return null;
  const type = message.itemType || message.item?.type;
  if (type && !["userMessage", "agentMessage"].includes(type)) return null;
  const kind = message.kind;
  if (!["user", "reply", "final"].includes(kind)) return null;
  const phase = message.phase || message.item?.phase;
  if (phase === "commentary") return null;
  const result = { id: message.id, provider: message.provider, kind, text: message.text, timestamp: message.timestamp };
  for (const key of ["threadId", "turnId"]) if (typeof message[key] === "string") result[key] = message[key];
  return result;
}
module.exports = { savedMessage, SAVED_MESSAGE_VERSION };
