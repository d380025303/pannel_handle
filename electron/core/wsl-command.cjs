function buildWslBashArgs(distro, script) {
  // Execute bash directly so the default WSL shell cannot expand script variables.
  return ["-d", distro, "--exec", "bash", "-lic", script];
}

module.exports = { buildWslBashArgs };
