const { createRemoteFilesModule, registerRemoteFileScheme } = require("./remote-files-module.cjs");
const { normalizeWslPath, toWslHostPath } = require("./remote-file-service.cjs");

module.exports = {
  createRemoteFilesModule,
  normalizeWslPath,
  registerRemoteFileScheme,
  toWslHostPath
};
