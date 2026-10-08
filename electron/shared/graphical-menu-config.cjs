const { providers, actions } = require("./graphical-menu-actions.json");

function normalizeGraphicalMenuConfig(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(providers.map(provider => [provider,
    actions.filter(action => action.providers.includes(provider)
      && Array.isArray(input[provider]) && input[provider].includes(action.id)).map(action => action.id)
  ]));
}

module.exports = { normalizeGraphicalMenuConfig };
