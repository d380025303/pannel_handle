const { contextBridge, ipcRenderer } = require("electron");
const command = payload => ipcRenderer.send("desktop-mascot:command", payload);
contextBridge.exposeInMainWorld("desktopMascotApi", {
  getState: () => ipcRenderer.invoke("desktop-mascot:state"),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("desktop-mascot:state", listener);
    return () => ipcRenderer.removeListener("desktop-mascot:state", listener);
  },
  setPreferences: preferences => command({ ...preferences, type: "preferences" }),
  onNotifications: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("desktop-mascot:notifications", listener);
    return () => ipcRenderer.removeListener("desktop-mascot:notifications", listener);
  },
  processNotification: (id, operation) => ipcRenderer.invoke("desktop-mascot:action", id, operation),
  dismissNotification: id => command({ type: "notification-dismiss", id }),
  setNotificationPresentation: (id, paused) => command({ type: "notification-presentation", id, paused }),
  setNotificationExpanded: (id, expanded) => command({ type: "notification-expanded", id, expanded }),
  setSummaryExpanded: (id, expanded) => command({ type: "summary-expanded", id, expanded }),
  migrate: preferences => command({ ...preferences, type: "migrate" }),
  setInteraction: (paused, reduced) => command({ type: "interaction", paused, reduced }),
  setRegions: regions => command({ type: "regions", regions }),
  startDrag: () => command({ type: "drag-start" }),
  endDrag: () => command({ type: "drag-end" }),
  step: direction => command({ type: "step", direction })
});

// Reuse the desktop handler and its HTTP(S) URL validation.
contextBridge.exposeInMainWorld("externalLinkApi", {
  open: url => ipcRenderer.invoke("external-link:open", url)
});
