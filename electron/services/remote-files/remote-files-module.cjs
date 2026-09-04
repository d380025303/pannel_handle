const { Readable } = require("node:stream");
const path = require("node:path");
const { createFileTransferManager } = require("./file-transfer-manager.cjs");
const { createFileWatchManager } = require("./file-watch-manager.cjs");
const { MEDIA_PROTOCOL, createRemoteFileService } = require("./remote-file-service.cjs");
const { registerRemoteFileIpcHandlers } = require("./remote-files-ipc-handlers.cjs");

function registerRemoteFileScheme(protocolApi) {
  protocolApi.registerSchemesAsPrivileged([{
    scheme: MEDIA_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }]);
}

function registerMediaPreviewProtocol(protocolApi, remoteFileService) {
  protocolApi.registerStreamProtocol(MEDIA_PROTOCOL, (request, callback) => {
    try {
      const rangeHeader = request.headers?.Range || request.headers?.range;
      callback(remoteFileService.createPreviewStreamResponse(request.url, rangeHeader));
    } catch {
      callback({
        statusCode: 404,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain",
          "Content-Length": "0"
        },
        data: Readable.from([])
      });
    }
  });
}

function createRemoteFilesModule({
  app,
  nativeImage,
  ipcMain,
  protocol,
  dialog,
  shellApi,
  terminalManager,
  sshFileSystem,
  windowManager,
  broadcast,
  fallbackIconPath
}) {
  const fileService = createRemoteFileService({
    terminalManager,
    sshFileSystem,
    shellApi,
    previewCacheRoot: path.join(app.getPath("userData"), "office-preview-cache")
  });
  const fileTransferManager = createFileTransferManager({
    remoteFileService: fileService,
    broadcast
  });
  const fileWatchManager = createFileWatchManager({ terminalManager, broadcast });

  void fileService.initializePreviewCache().catch(() => undefined);

  registerMediaPreviewProtocol(protocol, fileService);
  registerRemoteFileIpcHandlers({
    app,
    nativeImage,
    ipcMain,
    dialog,
    windowManager,
    remoteFileService: fileService,
    fileTransferManager,
    fileWatchManager,
    fallbackIconPath
  });

  let shutdownPromise = null;

  function disconnectSession(sessionId) {
    return fileService.disconnect(sessionId);
  }

  function shutdown() {
    shutdownPromise ||= (async () => {
      await fileTransferManager.shutdown();
      await Promise.all([
        fileWatchManager.shutdown(),
        fileService.shutdown()
      ]);
    })();
    return shutdownPromise;
  }

  return {
    fileService,
    disconnectSession,
    shutdown
  };
}

module.exports = {
  createRemoteFilesModule,
  registerRemoteFileScheme
};
