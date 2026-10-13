const { parseVersion, isNewer } = require("./codex-app-server/version-service.cjs");
const { createUpdateProgress } = require("./cli-version-progress.cjs");

// Each provider service owns its environment keys, probes, installation and messages.
function createCliVersionService({ target, probe, latestVersion, install, messages, cacheMs = 60 * 60 * 1000 }) {
  const cache = new Map();
  const updating = new Set();
  const progress = new Map();
  const revisions = new Map();
  async function check(id, force = false) {
    const value = target(id);
    if (updating.has(value.key)) return { ...cache.get(value.key)?.state, status: "updating", environment: value.key, progress: progress.get(value.key)?.snapshot() };
    const existing = cache.get(value.key);
    if (!force && existing && Date.now() - existing.at < cacheMs) return existing.state;
    const revision = revisions.get(value.key) || 0;
    try {
      const [installed, newest] = await Promise.all([probe(value), latestVersion()]);
      if (revision !== (revisions.get(value.key) || 0))
        return { ...(cache.get(value.key)?.state || {}), ...(updating.has(value.key) ? { status: "updating", progress: progress.get(value.key)?.snapshot() } : {}) };
      const state = { status: isNewer(parseVersion(installed.currentVersion), parseVersion(newest)) ? "available" : "current",
        ...installed, latestVersion: newest, environment: value.key,
        guidance: installed.method === "unknown" ? messages.manualUpdate : null };
      cache.set(value.key, { at: Date.now(), state });
      return state;
    } catch (error) {
      if (revision !== (revisions.get(value.key) || 0))
        return { ...(cache.get(value.key)?.state || {}), ...(updating.has(value.key) ? { status: "updating", progress: progress.get(value.key)?.snapshot() } : {}) };
      const state = { status: "error", environment: value.key, error: error instanceof Error ? error.message : String(error) };
      cache.set(value.key, { at: Date.now(), state });
      return state;
    }
  }
  async function update(id) {
    const value = target(id);
    if (updating.has(value.key)) throw new Error(messages.updating);
    const cached = cache.get(value.key);
    if (cached?.state.status !== "available" || cached.state.method !== "npm") throw new Error(messages.checkFirst);
    updating.add(value.key);
    const updateProgress = createUpdateProgress();
    progress.set(value.key, updateProgress);
    revisions.set(value.key, (revisions.get(value.key) || 0) + 1);
    try {
      const before = await probe(value);
      if (before.commandPath !== cached.state.commandPath || before.currentVersion !== cached.state.currentVersion || before.method !== cached.state.method)
        throw new Error(messages.installationChanged);
      updateProgress.setStage("installing");
      await install(value, updateProgress.append);
      updateProgress.setStage("verifying");
      const after = await probe(value);
      if (after.commandPath !== before.commandPath || after.method !== "npm" || !isNewer(parseVersion(before.currentVersion), parseVersion(after.currentVersion)))
        throw new Error(messages.verificationFailed);
      const state = { status: isNewer(parseVersion(after.currentVersion), parseVersion(cached.state.latestVersion)) ? "available" : "current",
        ...after, latestVersion: cached.state.latestVersion, environment: value.key, restartRequired: true };
      updateProgress.setStage("complete");
      const completed = { ...state, progress: updateProgress.snapshot() };
      cache.set(value.key, { at: Date.now(), state: completed });
      return completed;
    } catch (error) {
      updateProgress.setStage("failed");
      cache.set(value.key, { at: Date.now(), state: { ...cached.state, status: "error", error: error instanceof Error ? error.message : String(error), progress: updateProgress.snapshot() } });
      throw error;
    } finally { updating.delete(value.key); progress.delete(value.key); }
  }
  return { check, update };
}

module.exports = { createCliVersionService };
