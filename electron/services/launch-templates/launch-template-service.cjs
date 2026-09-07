function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function createLaunchTemplateService({ launchTemplateStore, sessionStore, agentSessionLauncher }) {
  async function launch(id) {
    const launchTemplate = launchTemplateStore.get(id);
    if (!launchTemplate) throw new Error("Launch template not found.");

    const launchedSessionIds = [];
    const failures = [];
    for (const templateId of launchTemplate.sessionTemplateIds) {
      const sessionTemplate = sessionStore.getTemplate(templateId);
      if (!sessionTemplate) {
        failures.push({ templateId, error: "Session template not found." });
        continue;
      }
      try {
        const session = await agentSessionLauncher.launchSession(sessionTemplate, { recordUsage: true });
        launchedSessionIds.push(session.id);
      } catch (err) {
        failures.push({
          templateId,
          title: sessionTemplate.title,
          error: getErrorMessage(err)
        });
      }
    }

    return { launchedSessionIds, failures };
  }

  return { launch };
}

module.exports = { createLaunchTemplateService };
