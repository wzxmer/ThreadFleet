import { useCallback, useEffect, useRef } from "react";
import { useUpdater } from "../../update/hooks/useUpdater";
import { useAgentSoundNotifications } from "../../notifications/hooks/useAgentSoundNotifications";
import { useAgentSystemNotifications } from "../../notifications/hooks/useAgentSystemNotifications";
import { useWindowFocusState } from "../../layout/hooks/useWindowFocusState";
import { useTauriEvent } from "./useTauriEvent";
import { playNotificationSound } from "../../../utils/notificationSounds";
import { subscribeUpdaterCheck } from "../../../services/events";
import {
  sendNotification,
  sendTransientNotification,
} from "../../../services/tauri";
import type { DebugEntry } from "../../../types";

type Params = {
  enabled?: boolean;
  autoCheckOnMount?: boolean;
  experimentalWindowsInstallerMigrationEnabled?: boolean;
  notificationSoundsEnabled: boolean;
  systemNotificationsEnabled: boolean;
  subagentSystemNotificationsEnabled: boolean;
  subagentCompletionNotificationsEnabled?: boolean;
  isSubagentThread?: (workspaceId: string, threadId: string) => boolean;
  getWorkspaceName?: (workspaceId: string) => string | undefined;
  updateNotificationTitle: string;
  upToDateNotificationBody: string;
  updateAvailableNotificationBody: string;
  onDebug: (entry: DebugEntry) => void;
  successSoundUrl: string;
  errorSoundUrl: string;
};

export function useUpdaterController({
  enabled = true,
  autoCheckOnMount = true,
  experimentalWindowsInstallerMigrationEnabled = false,
  notificationSoundsEnabled,
  systemNotificationsEnabled,
  subagentCompletionNotificationsEnabled = false,
  isSubagentThread,
  getWorkspaceName,
  updateNotificationTitle,
  upToDateNotificationBody,
  updateAvailableNotificationBody,
  onDebug,
  successSoundUrl,
  errorSoundUrl,
}: Params) {
  const {
    state: updaterState,
    startUpdate,
    checkForUpdates,
    dismiss,
    postUpdateNotice,
    dismissPostUpdateNotice,
  } = useUpdater({
    enabled,
    autoCheckOnMount,
    onDebug,
    experimentalWindowsInstallerMigrationEnabled,
  });
  const isWindowFocused = useWindowFocusState();
  const nextTestSoundIsError = useRef(false);
  const handledAvailableVersionRef = useRef<string | null>(null);

  const subscribeUpdaterCheckEvent = useCallback(
    (handler: () => void) =>
      subscribeUpdaterCheck(handler, {
        onError: (error) => {
          onDebug({
            id: `${Date.now()}-client-updater-menu-error`,
            timestamp: Date.now(),
            source: "error",
            label: "updater/menu-error",
            payload: error instanceof Error ? error.message : String(error),
          });
        },
      }),
    [onDebug],
  );

  useTauriEvent(
    subscribeUpdaterCheckEvent,
    () => {
      void checkForUpdates().then((result) => {
        if (result?.stage !== "upToDate" || !systemNotificationsEnabled) {
          return;
        }
        void sendTransientNotification(
          updateNotificationTitle,
          upToDateNotificationBody,
          3000,
        ).catch((error) => {
          onDebug({
            id: `${Date.now()}-client-updater-current-notification-error`,
            timestamp: Date.now(),
            source: "error",
            label: "updater/current-notification-error",
            payload: error instanceof Error ? error.message : String(error),
          });
        });
      });
    },
    { enabled },
  );

  useEffect(() => {
    if (updaterState.stage !== "available") {
      handledAvailableVersionRef.current = null;
      return;
    }
    const version = updaterState.version ?? "unknown";
    if (handledAvailableVersionRef.current === version) {
      return;
    }
    handledAvailableVersionRef.current = version;
    if (isWindowFocused || !systemNotificationsEnabled) {
      return;
    }
    void sendNotification(
      updateNotificationTitle,
      updateAvailableNotificationBody,
      {
        autoCancel: true,
        extra: { kind: "update_available", version },
      },
    );
  }, [
    isWindowFocused,
    systemNotificationsEnabled,
    updateAvailableNotificationBody,
    updateNotificationTitle,
    updaterState.stage,
    updaterState.version,
  ]);

  useAgentSoundNotifications({
    enabled: notificationSoundsEnabled,
    isWindowFocused,
    onDebug,
  });

  useAgentSystemNotifications({
    enabled: systemNotificationsEnabled,
    subagentNotificationsEnabled: subagentCompletionNotificationsEnabled,
    isSubagentThread,
    isWindowFocused,
    getWorkspaceName,
    onDebug,
  });

  const handleTestNotificationSound = useCallback(() => {
    const useError = nextTestSoundIsError.current;
    nextTestSoundIsError.current = !useError;
    const type = useError ? "error" : "success";
    const url = useError ? errorSoundUrl : successSoundUrl;
    playNotificationSound(url, type, onDebug);
  }, [errorSoundUrl, onDebug, successSoundUrl]);

  const handleTestSystemNotification = useCallback(() => {
    if (!systemNotificationsEnabled) {
      return;
    }
    void sendNotification(
      "Test Notification",
      "This is a test notification from ThreadFleet.",
    ).catch((error) => {
      onDebug({
        id: `${Date.now()}-client-notification-test-error`,
        timestamp: Date.now(),
        source: "error",
        label: "notification/test-error",
        payload: error instanceof Error ? error.message : String(error),
      });
    });
  }, [onDebug, systemNotificationsEnabled]);

  return {
    updaterState,
    startUpdate,
    checkForUpdates,
    dismissUpdate: dismiss,
    postUpdateNotice,
    dismissPostUpdateNotice,
    handleTestNotificationSound,
    handleTestSystemNotification,
  };
}
