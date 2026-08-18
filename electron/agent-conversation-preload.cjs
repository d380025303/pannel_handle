const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentConversationApi", {
  getSnapshot: () => ipcRenderer.invoke("agent-conversation:get-snapshot"),
  hide: () => ipcRenderer.send("agent-conversation:hide"),
  focusSession: () => ipcRenderer.send("agent-conversation:focus-session"),
  openExternal: (url) => ipcRenderer.invoke("external-link:open", url),
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("agent-conversation:snapshot", listener);
    return () => ipcRenderer.removeListener("agent-conversation:snapshot", listener);
  }
});
