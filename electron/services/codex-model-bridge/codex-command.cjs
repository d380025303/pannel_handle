function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function isPowerShell(shell) {
  const executable = String(shell || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
  return ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable);
}

function commandArg(session, value) {
  const text = String(value);
  if (session.type !== "windows") return shellQuote(text);
  if (isPowerShell(session.shell)) return `'${text.replace(/'/g, "''")}'`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCodexBackendCommand(session, config) {
  const providerId = String(config.providerId || "openrouter");
  const providerName = String(config.providerName || (providerId === "codebuddy" ? "CodeBuddy" : "OpenRouter"));
  const overrides = [
    `model_provider=${providerId}`,
    `model_providers.${providerId}.name=${providerName}`,
    `model_providers.${providerId}.base_url=${config.baseUrl}`,
    `model_providers.${providerId}.env_key=${config.apiKeyEnv}`,
    `model_providers.${providerId}.wire_api=responses`,
    `model_catalog_json=${config.catalogPath}`
  ];
  if (config.disableWebSearch === true || providerId === "nararouter" || providerId === "minimax") {
    overrides.push('web_search="disabled"');
  }
  const args = ["codex"];
  for (const override of overrides) args.push("-c", commandArg(session, override));
  args.push("-m", commandArg(session, config.model));
  return args.join(" ");
}

module.exports = {
  buildCodexBackendCommand
};
