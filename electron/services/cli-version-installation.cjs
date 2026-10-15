function sameInstallation(before, after, platform) {
  if (before.method !== after.method) return false;
  // fnm creates a new command symlink for every login shell.
  if (platform === "linux" && before.method === "npm") return before.resolvedPath === after.resolvedPath;
  return before.commandPath === after.commandPath;
}

module.exports = { sameInstallation };
