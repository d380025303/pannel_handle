const fs = require("node:fs");

function readJson(dataStore, filePath, fsApi = fs) {
  return dataStore ? dataStore.read(filePath) : JSON.parse(fsApi.readFileSync(filePath, "utf8"));
}

function writeJson(dataStore, filePath, value, fsApi = fs) {
  if (dataStore) return dataStore.write(filePath, value);
  const temporaryFile = `${filePath}.tmp`;
  fsApi.writeFileSync(temporaryFile, JSON.stringify(value, null, 2), "utf8");
  fsApi.renameSync(temporaryFile, filePath);
}

module.exports = { readJson, writeJson };
