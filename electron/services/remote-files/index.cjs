const { createRemoteFilesModule, registerRemoteFileScheme } = require("./remote-files-module.cjs");
const { normalizeWslPath, toWslHostPath } = require("../../core/wsl-paths.cjs");

module.exports = {
  createRemoteFilesModule,
  normalizeWslPath,
  registerRemoteFileScheme,
  toWslHostPath
};
