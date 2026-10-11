import { useState } from "react";

const MINIMAL_MODE_STORAGE_KEY = "pannel-handle-mobile-graphical-minimal-mode";

function readMinimalMode() {
  try { return localStorage.getItem(MINIMAL_MODE_STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function useMobilePreferences() {
  const [minimalMode, setMinimalMode] = useState(readMinimalMode);
  const [storageWarning, setStorageWarning] = useState("");
  const updateMinimalMode = (enabled: boolean) => {
    setMinimalMode(enabled);
    try {
      localStorage.setItem(MINIMAL_MODE_STORAGE_KEY, String(enabled));
      setStorageWarning("");
    } catch {
      setStorageWarning("无法保存极简模式设置，本次切换仍然有效。");
    }
  };
  return { minimalMode, updateMinimalMode, storageWarning };
}
