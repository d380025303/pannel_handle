type Translate = (key: "agentCapabilities.pannelHandleRemote") => string;

export function mcpServerDisplayName(name: string, t: Translate) {
  return name === "pannel_handle_remote" ? t("agentCapabilities.pannelHandleRemote") : name;
}
