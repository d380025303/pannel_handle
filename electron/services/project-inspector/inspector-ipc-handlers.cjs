const { summarize } = require("./template-config.cjs");
function registerInspectorIpcHandlers({ ipcMain, service, planning, implementation, dialog, getWindow }) {
  const methods = {
    listProjects: () => service.listProjects(),
    addProject: async input => summarize(await service.addProject(input)),
    listProjectTemplates: () => service.listProjectTemplates(),
    relinkProject: input => service.relinkProject(input),
    profileProject: id => service.profileProject(id),
    listRoles: id => service.listRoles(id),
    updateRole: input => service.updateRole(input),
    mergeRoles: input => service.mergeRoles(input),
    startInspection: input => service.startInspection(input),
    cancelInspection: id => service.cancelInspection(id),
    listInspectionRuns: id => service.listInspectionRuns(id),
    listFindings: query => service.listFindings(query),
    getFinding: id => { planning?.sync(); implementation?.sync(); return service.getFinding(id); },
    approvePlanning: input => { if (!planning) throw new Error("规划服务不可用。"); return planning.approvePlanning(input); },
    getPlan: id => { if (!planning) throw new Error("规划服务不可用。"); return planning.getPlan(id); },
    openPlan: id => { if (!planning) throw new Error("规划服务不可用。"); return planning.openPlan(id); },
    verifyImplementation: input => { if (!implementation) throw new Error("实施服务不可用。"); return implementation.verifyImplementation(input); },
    approveMerge: input => { if (!implementation) throw new Error("实施服务不可用。"); return implementation.approveMerge(input); },
    approveImplementation: input => { if (!implementation) throw new Error("实施服务不可用。"); return implementation.approveImplementation(input); },
    openImplementation: id => { if (!implementation) throw new Error("实施服务不可用。"); return implementation.openImplementation(id); },
    getImplementation: id => { if (!implementation) throw new Error("实施服务不可用。"); return implementation.getImplementation(id); },
    reviewImplementation: id => { if (!implementation) throw new Error("实施服务不可用。"); return implementation.reviewImplementation(id); },
    decideFinding: input => service.decideFinding(input?.id, input?.expectedRevision, input?.action, input?.reason),
    getUsage: id => service.getUsage(id),
    getSettings: id => service.getSettings(id),
    updateSettings: input => service.updateSettings(input?.projectId, input?.patch),
    chooseProject: async () => {
      const result = await dialog.showOpenDialog(getWindow(), { properties: ["openDirectory"], title: "选择本地 Git 项目" });
      return result.canceled ? null : result.filePaths[0];
    }
  };
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`project-inspector:${name}`, async (event, input) => {
    if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("巡检接口仅供主窗口使用。");
    return method(input);
  });
  return () => { for (const name of Object.keys(methods)) ipcMain.removeHandler(`project-inspector:${name}`); };
}
module.exports = { registerInspectorIpcHandlers };
