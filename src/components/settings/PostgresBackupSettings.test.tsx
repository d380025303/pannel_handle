// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresBackupSettings } from "./PostgresBackupSettings";

const config = { deviceId: "device-a", deviceName: "办公电脑", enabled: false,
  host: "localhost", port: 5432, database: "backups", user: "backup_user", ssl: false,
  hasPassword: false, hasPassphrase: false, lastSuccessAt: null, lastError: "", pendingSources: [], running: false };

describe("PostgresBackupSettings", () => {
  afterEach(cleanup);

  it("saves connection and passphrase, then restores a selected snapshot as a copy", async () => {
    const saveConfig = vi.fn(async input => ({ ...config, ...input, hasPassword: true, hasPassphrase: true }));
    const restore = vi.fn(async () => ({ importedCount: 2, sessions: [] }));
    Object.defineProperty(window, "postgresBackupApi", { configurable: true, value: {
      getConfig: async () => config, saveConfig, testConnection: async () => ({ ok: true }),
      run: async () => config,
      listDevices: async () => [{ id: "device-b", name: "家用电脑", last_seen_at: "2026-09-21" }],
      listSnapshots: async () => [{ id: "snapshot-1", device_id: "device-b", created_at: "2026-09-21", session_count: 2 }],
      listConversations: async () => [], getMessages: async () => [], restore, deleteDevice: async () => true,
      onChanged: () => () => undefined
    } });
    Object.defineProperty(window, "terminalApi", { configurable: true, value: { loadSavedSessions: async () => [] } });
    render(<PostgresBackupSettings />);
    expect(await screen.findByText(/设备 ID：device-a/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "db-password" } });
    fireEvent.change(screen.getByLabelText("跨电脑备份口令"), { target: { value: "portable-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ password: "db-password", passphrase: "portable-key" })));
    fireEvent.click(screen.getByRole("button", { name: "刷新设备" }));
    expect(await screen.findByRole("button", { name: "作为副本恢复" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "作为副本恢复" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("snapshot-1", undefined));
  });

  it("shows offline remote sources as pending instead of errors", async () => {
    Object.defineProperty(window, "postgresBackupApi", { configurable: true, value: {
      getConfig: async () => ({ ...config, pendingSources: ["example.org · /work"] }),
      onChanged: () => () => undefined
    } });
    render(<PostgresBackupSettings />);
    expect(await screen.findByText("1 个远程来源待重连后同步")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
