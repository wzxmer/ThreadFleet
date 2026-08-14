import { useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  ManagedSessionCleanupProgress,
  ManagedSessionCleanupRequest,
} from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import {
  cancelSessionTask,
  fetchManagedSessionCleanupProgress,
  previewManagedSessionCleanup,
  startManagedSessionCleanup,
} from "@services/tauri";
import { loadPinnedThreadIds } from "@threads/utils/threadStorage";

type CleanupPrompt = {
  kind: "enable" | "immediate";
  eligibleCount: number;
};

type Args = {
  appSettings: AppSettings;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
};

export function useSessionCleanupSettings({
  appSettings,
  onUpdateAppSettings,
}: Args) {
  const { t } = useI18n();
  const [cleanupPrompt, setCleanupPrompt] = useState<CleanupPrompt | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupSummary, setCleanupSummary] = useState<string | null>(null);
  const [cleanupProgress, setCleanupProgress] = useState<ManagedSessionCleanupProgress | null>(null);
  const activeCleanupIdRef = useRef<string | null>(null);

  useEffect(() => () => {
    activeCleanupIdRef.current = null;
  }, []);

  const cleanupRequest = (): ManagedSessionCleanupRequest => ({
    retentionDays: appSettings.autoDeleteArchivedThreadsDays,
    protectedThreadIds: loadPinnedThreadIds(),
  });

  const openCleanupPrompt = async (kind: CleanupPrompt["kind"]) => {
    setCleanupBusy(true);
    setCleanupError(null);
    setCleanupSummary(null);
    try {
      const preview = await previewManagedSessionCleanup(cleanupRequest());
      setCleanupPrompt({ kind, eligibleCount: preview.eligibleCount });
    } catch (error) {
      setCleanupError(error instanceof Error ? error.message : String(error));
    } finally {
      setCleanupBusy(false);
    }
  };

  const confirmEnableAutoDelete = async () => {
    setCleanupBusy(true);
    setCleanupError(null);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        autoDeleteArchivedThreadsEnabled: true,
      });
      setCleanupPrompt(null);
    } catch (error) {
      setCleanupError(error instanceof Error ? error.message : String(error));
    } finally {
      setCleanupBusy(false);
    }
  };

  const confirmImmediateCleanup = async () => {
    setCleanupBusy(true);
    setCleanupError(null);
    try {
      const requestId = `session-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      activeCleanupIdRef.current = requestId;
      const initial = await startManagedSessionCleanup({ requestId, ...cleanupRequest() });
      setCleanupProgress(initial);
      setCleanupPrompt(null);
      let response = initial;
      while (activeCleanupIdRef.current === requestId && !response.completed && !response.cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, 75));
        response = await fetchManagedSessionCleanupProgress(requestId);
        if (activeCleanupIdRef.current === requestId) setCleanupProgress(response);
      }
      if (activeCleanupIdRef.current !== requestId) return;
      setCleanupSummary(
        t(response.cancelled
          ? "settings.session.immediateCleanupCancelledResult"
          : "settings.session.immediateCleanupResult")
          .replace("{success}", String(response.successCount))
          .replace("{failure}", String(response.failureCount)),
      );
      setCleanupError(response.error);
      activeCleanupIdRef.current = null;
    } catch (error) {
      setCleanupError(error instanceof Error ? error.message : String(error));
    } finally {
      setCleanupBusy(false);
    }
  };

  const cancelImmediateCleanup = async () => {
    const requestId = activeCleanupIdRef.current;
    if (!requestId) return;
    await cancelSessionTask(requestId);
  };

  return {
    cleanupPrompt,
    cleanupBusy,
    cleanupError,
    cleanupSummary,
    cleanupProgress,
    openCleanupPrompt,
    closeCleanupPrompt: () => setCleanupPrompt(null),
    confirmEnableAutoDelete,
    confirmImmediateCleanup,
    cancelImmediateCleanup,
  };
}
