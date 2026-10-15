// Explicit variables must enter WSL unchanged, overriding inherited direction/path flags.
function mergeWslEnv(existingValue, variableNames, excludedNames = []) {
  const excluded = new Set(excludedNames);
  const names = new Set(variableNames.filter(name => !excluded.has(name)));
  const entries = String(existingValue || "").split(":").filter(entry => {
    const name = entry.trim().split("/")[0];
    return name && !names.has(name) && !excluded.has(name);
  });
  return [...entries, ...Array.from(names, name => `${name}/u`)].join(":");
}

module.exports = { mergeWslEnv };
