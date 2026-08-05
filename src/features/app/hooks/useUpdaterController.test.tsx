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

  it("shows a three-second system notification after a manual up-to-date check", async () => {
    renderHook(() =>
      useUpdaterController({
        notificationSoundsEnabled: false,
        systemNotificationsEnabled: true,
        subagentSystemNotificationsEnabled: true,
        updateNotificationTitle: "Update",
        upToDateNotificationBody: "Already on the latest version.",
        updateAvailableNotificationBody: "A new version is available.",
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
      expect(mocks.sendTransientNotification).toHaveBeenCalledWith(
        "Update",
        "Already on the latest version.",
        3000,
      );
    });
  });

  it("shows the same notification when settings invoke the exposed check action", async () => {
    const { result } = renderHook(() =>
      useUpdaterController({
        notificationSoundsEnabled: false,
        systemNotificationsEnabled: true,
        subagentSystemNotificationsEnabled: true,
        updateNotificationTitle: "Update",
        upToDateNotificationBody: "Already on the latest version.",
        updateAvailableNotificationBody: "A new version is available.",
        onDebug: vi.fn(),
        successSoundUrl: "success.mp3",
        errorSoundUrl: "error.mp3",
      }),
    );

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(mocks.sendTransientNotification).toHaveBeenCalledWith(
      "Update",
      "Already on the latest version.",
      3000,
    );
  });

  it("shows a system notification when an update is found in the background", async () => {
    mocks.updaterState = { stage: "available", version: "1.2.3" };

    renderHook(() =>
      useUpdaterController({
        notificationSoundsEnabled: false,
        systemNotificationsEnabled: true,
        subagentSystemNotificationsEnabled: true,
        updateNotificationTitle: "Update",
        upToDateNotificationBody: "Already on the latest version.",
        updateAvailableNotificationBody: "A new version is available.",
        onDebug: vi.fn(),
        successSoundUrl: "success.mp3",
        errorSoundUrl: "error.mp3",
      }),
    );

    await waitFor(() => {
      expect(mocks.sendNotification).toHaveBeenCalledWith(
        "Update",
        "A new version is available.",
        {
          autoCancel: true,
          extra: { kind: "update_available", version: "1.2.3" },
        },
      );
    });
  });
});
