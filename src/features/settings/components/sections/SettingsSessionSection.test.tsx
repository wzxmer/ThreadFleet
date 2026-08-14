// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/types";
import { previewManagedSessionCleanup, startManagedSessionCleanup } from "@services/tauri";
import { SettingsSessionSection } from "./SettingsSessionSection";

vi.mock("@services/tauri", () => ({
  previewManagedSessionCleanup: vi.fn(),
  startManagedSessionCleanup: vi.fn(),
  fetchManagedSessionCleanupProgress: vi.fn(),
}));

function renderSessionSection(
  settings: Partial<AppSettings>,
  onUpdateAppSettings = vi.fn(async () => {}),
) {
  const appSettings = ({
    chatHistoryScrollbackItems: 200,
    threadTitleAutogenerationEnabled: false,
    autoArchiveThreadsEnabled: false,
    autoArchiveThreadsDays: 7,
    autoDeleteArchivedThreadsEnabled: false,
    autoDeleteArchivedThreadsDays: 30,
    ...settings,
  } as unknown) as AppSettings;

  render(
    <SettingsSessionSection
      appSettings={appSettings}
      onUpdateAppSettings={onUpdateAppSettings}
    />,
  );

  return { appSettings, onUpdateAppSettings };
}

describe("SettingsSessionSection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("previews before enabling and cancel leaves auto delete disabled", async () => {
    vi.mocked(previewManagedSessionCleanup).mockResolvedValue({ eligibleCount: 3 });
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({}, onUpdateAppSettings);

    const row = screen
      .getByText("自动永久删除归档会话")
      .closest(".settings-toggle-row");
    fireEvent.click(within(row as HTMLElement).getByRole("button"));

    expect(await screen.findByRole("dialog", { name: "开启自动永久删除" })).toBeTruthy();
    expect(screen.getByText("当前预计符合条件：3 个会话。")).toBeTruthy();
    expect(onUpdateAppSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("enables only after irreversible confirmation without deleting", async () => {
    vi.mocked(previewManagedSessionCleanup).mockResolvedValue({ eligibleCount: 2 });
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({}, onUpdateAppSettings);

    const row = screen
      .getByText("自动永久删除归档会话")
      .closest(".settings-toggle-row");
    fireEvent.click(within(row as HTMLElement).getByRole("button"));
    await screen.findByRole("dialog", { name: "开启自动永久删除" });
    fireEvent.click(screen.getByLabelText("我了解永久删除无法恢复"));
    fireEvent.click(screen.getByRole("button", { name: "确认开启" }));

    await waitFor(() =>
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ autoDeleteArchivedThreadsEnabled: true }),
      ),
    );
    expect(startManagedSessionCleanup).not.toHaveBeenCalled();
  });

  it("requires a fresh preview and confirmation for immediate cleanup", async () => {
    vi.mocked(previewManagedSessionCleanup).mockResolvedValue({ eligibleCount: 1 });
    vi.mocked(startManagedSessionCleanup).mockResolvedValue({
      requestId: "cleanup",
      processedCount: 1,
      totalCount: 1,
      successCount: 1,
      failureCount: 0,
      completed: true,
      cancelled: false,
      error: null,
    });
    renderSessionSection({ autoDeleteArchivedThreadsEnabled: true });

    fireEvent.click(screen.getByRole("button", { name: "立即清理" }));
    await screen.findByRole("dialog", { name: "立即永久清理归档会话" });
    fireEvent.click(screen.getByLabelText("我了解永久删除无法恢复"));
    fireEvent.click(screen.getByRole("button", { name: "确认立即清理" }));

    await waitFor(() => expect(startManagedSessionCleanup).toHaveBeenCalledTimes(1));
    expect(previewManagedSessionCleanup).toHaveBeenCalledTimes(1);
    expect(screen.getByText("清理完成：成功 1，失败 0。")).toBeTruthy();
  });

  it("toggles auto archive", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({}, onUpdateAppSettings);

    const row = screen
      .getByText("自动归档旧会话")
      .closest(".settings-toggle-row");
    expect(row).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByRole("button"));

    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ autoArchiveThreadsEnabled: true }),
    );
  });

  it("updates auto archive days", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection(
      { autoArchiveThreadsEnabled: true, autoArchiveThreadsDays: 7 },
      onUpdateAppSettings,
    );

    fireEvent.change(screen.getByLabelText("归档时间"), {
      target: { value: "15" },
    });

    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ autoArchiveThreadsDays: 15 }),
    );
  });

  it("toggles auto-generated thread titles", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({}, onUpdateAppSettings);

    const row = screen
      .getByText("自动生成标题")
      .closest(".settings-toggle-row");
    expect(row).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByRole("button"));

    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ threadTitleAutogenerationEnabled: true }),
    );
  });

  it("toggles unlimited chat history", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({ chatHistoryScrollbackItems: 200 }, onUpdateAppSettings);

    const row = screen.getByText("不限聊天历史").closest(".settings-toggle-row");
    expect(row).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByRole("button"));

    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ chatHistoryScrollbackItems: null }),
    );
  });

  it("disables scrollback controls when unlimited chat history is enabled", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({ chatHistoryScrollbackItems: null }, onUpdateAppSettings);

    const presetSelect = screen.getByLabelText("每批显示消息数量");
    expect((presetSelect as HTMLSelectElement).disabled).toBe(true);

    const maxItemsInput = screen.getByLabelText("每批显示数量");
    expect((maxItemsInput as HTMLInputElement).disabled).toBe(true);

    const maxItemsRow = maxItemsInput.closest(".settings-field-row");
    expect(maxItemsRow).toBeTruthy();
    const resetButton = within(maxItemsRow as HTMLElement).getByRole("button", {
      name: "重置",
    });
    expect((resetButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(presetSelect, { target: { value: "1000" } });
    expect(onUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("applies scrollback presets", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({ chatHistoryScrollbackItems: 200 }, onUpdateAppSettings);

    fireEvent.change(screen.getByLabelText("每批显示消息数量"), {
      target: { value: "1000" },
    });

    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ chatHistoryScrollbackItems: 1000 }),
    );
  });

  it("does not persist scrollback draft on blur when toggling unlimited", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({ chatHistoryScrollbackItems: 200 }, onUpdateAppSettings);

    const maxItemsInput = screen.getByLabelText("每批显示数量");
    fireEvent.change(maxItemsInput, { target: { value: "50" } });

    const unlimitedRow = screen
      .getByText("不限聊天历史")
      .closest(".settings-toggle-row");
    expect(unlimitedRow).toBeTruthy();
    const unlimitedButton = within(unlimitedRow as HTMLElement).getByRole("button");

    fireEvent.blur(maxItemsInput, { relatedTarget: unlimitedButton });
    fireEvent.click(unlimitedButton);

    expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);
    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ chatHistoryScrollbackItems: null }),
    );
  });

  it("does not persist scrollback draft on blur when clicking Reset", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    renderSessionSection({ chatHistoryScrollbackItems: 200 }, onUpdateAppSettings);

    const maxItemsInput = screen.getByLabelText("每批显示数量");
    fireEvent.change(maxItemsInput, { target: { value: "50" } });

    const maxItemsRow = maxItemsInput.closest(".settings-field-row");
    expect(maxItemsRow).toBeTruthy();
    const resetButton = within(maxItemsRow as HTMLElement).getByRole("button", {
      name: "重置",
    });

    fireEvent.blur(maxItemsInput, { relatedTarget: resetButton });
    fireEvent.click(resetButton);

    expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);
    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ chatHistoryScrollbackItems: 200 }),
    );
  });
});
