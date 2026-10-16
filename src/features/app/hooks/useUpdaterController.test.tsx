// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdaterController } from "./useUpdaterController";

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  sendNotification: vi.fn(),
  sendTransientNotification: vi.fn(),
  updaterCheckHandler: null as (() => void) | null,
  updaterState: { stage: "idle" } as { stage: string; version?: string },
  useAgentSystemNotifications: vi.fn(),
}));

vi.mock("../../update/hooks/useUpdater", () => ({
  useUpdater: () => ({
    state: mocks.updaterState,
    startUpdate: vi.fn(),
    checkForUpdates: mocks.checkForUpdates,
    dismiss: vi.fn(),
    postUpdateNotice: null,
    dismissPostUpdateNotice: vi.fn(),
  }),
}));

vi.mock("../../notifications/hooks/useAgentSoundNotifications", () => ({
  useAgentSoundNotifications: vi.fn(),
}));

vi.mock("../../notifications/hooks/useAgentSystemNotifications", () => ({
  useAgentSystemNotifications: mocks.useAgentSystemNotifications,
}));

vi.mock("../../layout/hooks/useWindowFocusState", () => ({
  useWindowFocusState: () => false,
}));

vi.mock("./useTauriEvent", () => ({
  useTauriEvent: (_subscribe: unknown, handler: () => void) => {
    mocks.updaterCheckHandler = handler;
  },
}));

vi.mock("../../../utils/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
}));

vi.mock("../../../services/events", () => ({
  subscribeUpdaterCheck: vi.fn(),
}));

vi.mock("../../../services/tauri", () => ({
  sendNotification: mocks.sendNotification,
  sendTransientNotification: mocks.sendTransientNotification,
}));

describe("useUpdaterController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updaterCheckHandler = null;
    mocks.updaterState = { stage: "idle" };
    mocks.checkForUpdates.mockResolvedValue({ stage: "upToDate" });
    mocks.sendTransientNotification.mockResolvedValue(undefined);
    mocks.useAgentSystemNotifications.mockClear();
  });

  it("keeps an up-to-date menu check silent", async () => {
    renderHook(() =>
      useUpdaterController({
        notificationSoundsEnabled: false,
        systemNotificationsEnabled: true,
        subagentSystemNotificationsEnabled: true,
        onDebug: vi.fn(),
        successSoundUrl: "success.mp3",
        errorSoundUrl: "error.mp3",
      }),
    );

    expect(mocks.useAgentSystemNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ subagentNotificationsEnabled: false }),
    );


    act(() => {
      mocks.updaterCheckHandler?.();
    });

    await waitFor(() => {
      expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    });
    expect(mocks.sendTransientNotification).not.toHaveBeenCalled();
  });

  it("keeps an up-to-date settings check silent", async () => {
    const { result } = renderHook(() =>
      useUpdaterController({
        notificationSoundsEnabled: false,
        systemNotificationsEnabled: true,
        subagentSystemNotificationsEnabled: true,
        onDebug: vi.fn(),
        successSoundUrl: "success.mp3",
        errorSoundUrl: "error.mp3",
      }),
    );

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.sendTransientNotification).not.toHaveBeenCalled();
  });

  it("checks Codex CLI updates from the menu and settings actions", async () => {
    const checkCodexCliUpdates = vi.fn();
    const { result } = renderHook(() =>
      useUpdaterController({
        notificationSoundsEnabled: false,
        systemNotificationsEnabled: false,
        subagentSystemNotificationsEnabled: true,
        onCheckCodexCliUpdates: checkCodexCliUpdates,
        onDebug: vi.fn(),
        successSoundUrl: "success.mp3",
        errorSoundUrl: "error.mp3",
      }),
    );

    await act(async () => {
      await result.current.checkForUpdates();
    });
    expect(checkCodexCliUpdates).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.updaterCheckHandler?.();
    });
    await waitFor(() => {
      expect(checkCodexCliUpdates).toHaveBeenCalledTimes(2);
    });
  });

  it("leaves available updates in the app toast without duplicating system notifications", () => {
    mocks.updaterState = { stage: "available", version: "1.2.3" };

    renderHook(() =>
      useUpdaterController({
        notificationSoundsEnabled: false,
        systemNotificationsEnabled: true,
        subagentSystemNotificationsEnabled: true,
        onDebug: vi.fn(),
        successSoundUrl: "success.mp3",
        errorSoundUrl: "error.mp3",
      }),
    );

    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});
