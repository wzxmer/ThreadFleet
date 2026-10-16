import { useCallback, useRef } from "react";
import { useUpdater } from "../../update/hooks/useUpdater";
import { useAgentSoundNotifications } from "../../notifications/hooks/useAgentSoundNotifications";
import { useAgentSystemNotifications } from "../../notifications/hooks/useAgentSystemNotifications";
import { useWindowFocusState } from "../../layout/hooks/useWindowFocusState";
import { useTauriEvent } from "./useTauriEvent";
import { playNotificationSound } from "../../../utils/notificationSounds";
import { subscribeUpdaterCheck } from "../../../services/events";
import { sendNotification } from "../../../services/tauri";
import type { DebugEntry } from "../../../types";

type Params = {
  enabled?: boolean;
  autoCheckOnMount?: boolean;
  onCheckCodexCliUpdates?: () => void | Promise<unknown>;
  experimentalWindowsInstallerMigrationEnabled?: boolean;
  notificationSoundsEnabled: boolean;
  systemNotificationsEnabled: boolean;
  computerControlNotificationsEnabled?: boolean;
  subagentSystemNotificationsEnabled: boolean;
  subagentCompletionNotificationsEnabled?: boolean;
  isSubagentThread?: (workspaceId: string, threadId: string) => boolean;
  getWorkspaceName?: (workspaceId: string) => string | undefined;
  onDebug: (entry: DebugEntry) => void;
  successSoundUrl: string;
  errorSoundUrl: string;
};

export function useUpdaterController({
  enabled = true,
  autoCheckOnMount = true,
  onCheckCodexCliUpdates,
  experimentalWindowsInstallerMigrationEnabled = false,
  notificationSoundsEnabled,
  systemNotificationsEnabled,
  computerControlNotificationsEnabled = true,
  subagentCompletionNotificationsEnabled = false,
  isSubagentThread,
  getWorkspaceName,
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

  const checkForUpdatesWithNotice = useCallback(async () => {
    void onCheckCodexCliUpdates?.();
    return checkForUpdates();
  }, [
    checkForUpdates,
    onCheckCodexCliUpdates,
  ]);

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
      void checkForUpdatesWithNotice();
    },
    { enabled },
  );

  useAgentSoundNotifications({
    enabled: notificationSoundsEnabled,
    isWindowFocused,
    onDebug,
  });

  useAgentSystemNotifications({
    enabled: systemNotificationsEnabled,
    computerControlNotificationsEnabled,
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
    checkForUpdates: checkForUpdatesWithNotice,
    dismissUpdate: dismiss,
    postUpdateNotice,
    dismissPostUpdateNotice,
    handleTestNotificationSound,
    handleTestSystemNotification,
  };
}
