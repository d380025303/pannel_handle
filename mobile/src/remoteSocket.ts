export type RemoteSocket = Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener">;

let previewFactory: (() => RemoteSocket) | undefined;

export function installPreviewTransport(factory?: () => RemoteSocket) {
  previewFactory = factory;
}

export function isPreviewTransport() { return Boolean(previewFactory); }

export function createRemoteSocket(url: string): RemoteSocket {
  return previewFactory ? previewFactory() : new WebSocket(url);
}
