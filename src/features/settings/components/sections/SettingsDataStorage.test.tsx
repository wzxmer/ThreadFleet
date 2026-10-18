// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageStatus } from "@/types";
import { getStorageStatus, manageStorage, setStorageMaintenance } from "@services/tauri";
import { SettingsDataStorage } from "./SettingsDataStorage";

vi.mock("@services/tauri", () => ({
  getStorageStatus: vi.fn(), manageStorage: vi.fn(async () => {}),
  setStorageMaintenance: vi.fn(async () => {}), pickStorageDirectory: vi.fn(),
}));

const status: StorageStatus = {
  supported: true, controlPath: "C:\\control", locations: [], plan: null,
  maintenance: { enabled: false, retentionDays: 30, cacheRoots: [], artifactRoots: [], lastRun: null, removedFiles: 0, removedBytes: 0, error: null, status: "idle" },
};
beforeEach(() => { vi.mocked(getStorageStatus).mockResolvedValue(structuredClone(status)); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("SettingsDataStorage", () => {
  it("requires the shared-client confirmation before scheduling the selected directory", async () => {
    render(<SettingsDataStorage />);
    const input = await screen.findByLabelText("统一数据目录（本机）");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    const schedule = screen.getByRole("button", { name: "保存并安排退出后迁移" }) as HTMLButtonElement;
    expect(schedule.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "E:\\TF" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解 Codex/ }));
    fireEvent.click(schedule);
    await waitFor(() => expect(manageStorage).toHaveBeenCalledWith("schedule", "E:\\TF"));
  });

  it("saves cache retention independently and rejects an invalid number of days", async () => {
    render(<SettingsDataStorage />);
    const days = screen.getByLabelText("保留天数（7–365 天）");
    await waitFor(() => expect((days as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: "自动清理过期缓存与受管临时文件" }));
    fireEvent.change(days, { target: { value: "1" } });
    const save = screen.getByRole("button", { name: "保存清理设置" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(days, { target: { value: "60" } });
    fireEvent.click(save);
    await waitFor(() => expect(setStorageMaintenance).toHaveBeenCalledWith(true, 60));
    expect(manageStorage).not.toHaveBeenCalled();
  });

  it("requires a separate acknowledgement before deleting migration backups", async () => {
    vi.mocked(getStorageStatus).mockResolvedValue({ ...status, plan: { version: 1, id: "test", root: "D:\\TF", status: "ready", error: null, locations: [], backupsCleaned: false } });
    render(<SettingsDataStorage />);
    const remove = await screen.findByRole("button", { name: "安排退出后清理旧副本" });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /已检查迁移后的数据/ }));
    fireEvent.click(remove);
    await waitFor(() => expect(manageStorage).toHaveBeenCalledWith("cleanup", undefined));
  });
});
