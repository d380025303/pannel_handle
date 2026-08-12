const DATABASE_NAME = "pannel-handle-mobile";
const STORE_NAME = "credentials";
const TOKEN_KEY = "trusted-device";

export type StoredDevice = {
  deviceId: string;
  deviceName: string;
  token: string;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开设备凭据存储"));
  });
}
export async function loadStoredDevice(): Promise<StoredDevice | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(TOKEN_KEY);
      request.onsuccess = () => resolve((request.result as StoredDevice | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("无法读取设备凭据"));
    });
  } finally {
    database.close();
  }
}
export async function saveStoredDevice(device: StoredDevice): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(device, TOKEN_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("无法保存设备凭据"));
    });
  } finally {
    database.close();
  }
}

export async function clearStoredDevice(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(TOKEN_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("无法清除设备凭据"));
    });
  } finally {
    database.close();
  }
}
