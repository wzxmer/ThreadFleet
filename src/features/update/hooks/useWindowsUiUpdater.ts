import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type {
  DebugEntry,
  WindowsUiUpdateCheckResult,
} from "@/types";
import {
  checkWindowsUiUpdate,
  installWindowsUiUpdate,
} from "@services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "@services/events";

export type WindowsUiUpdaterStage =
  | "idle"
  | "checking"
  | "unsupported"
  | "unmanaged"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "restartRequired"
  | "error";

export type WindowsUiUpdaterState = {
  stage: WindowsUiUpdaterStage;
  check?: WindowsUiUpdateCheckResult;
  version?: string;
  progress?: {
    downloadedBytes: number;
    totalBytes?: number;
  };
  error?: string;
};

type UseWindowsUiUpdaterOptions = {
  enabled?: boolean;
  autoCheckOnMount?: boolean;
  onDebug?: (entry: DebugEntry) => void;
};

function stageForCheck(result: WindowsUiUpdateCheckResult): WindowsUiUpdaterStage {
  switch (result.status) {
    case "unsupported":
      return "unsupported";
    case "unmanaged":
      return "unmanaged";
    case "upToDate":
      return "upToDate";
    case "available":
      return "available";
  }
}

export function useWindowsUiUpdater({
  enabled = true,
  autoCheckOnMount = true,
  onDebug,
}: UseWindowsUiUpdaterOptions) {
  const [state, setState] = useState<WindowsUiUpdaterState>({ stage: "idle" });
  const checkRef = useRef<WindowsUiUpdateCheckResult | null>(null);
  const activeDownloadIdRef = useRef<string | null>(null);
  const hasAttemptedAutoCheckRef = useRef(false);

  const checkForUpdates = useCallback(async () => {
    if (!enabled || !isTauri()) {
      return undefined;
    }
    setState((current) => ({
      stage: "checking",
      check: current.check,
    }));
    try {
      const result = await checkWindowsUiUpdate();
      checkRef.current = result;
      setState({
        stage: stageForCheck(result),
        check: result,
        version: result.release?.version ?? result.currentVersion ?? undefined,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onDebug?.({
        id: `${Date.now()}-client-windows-ui-update-check-error`,
        timestamp: Date.now(),
        source: "error",
        label: "windows-ui-updater/check-error",
        payload: message,
      });
      setState((current) => ({
        stage: "error",
        check: current.check,
        error: message,
      }));
      return undefined;
    }
  }, [enabled, onDebug]);

  const startInstall = useCallback(async () => {
    if (!enabled || !isTauri() || activeDownloadIdRef.current) {
      return undefined;
    }
    const check = checkRef.current;
    const release = check?.status === "available" ? check.release : null;
    if (!release) {
      return undefined;
    }
    const requestId = `windows-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeDownloadIdRef.current = requestId;
    setState({
      stage: "downloading",
      check: check ?? undefined,
      version: release.version,
      progress: {
        downloadedBytes: 0,
        totalBytes: release.assetSize,
      },
    });
    try {
      const installed = await installWindowsUiUpdate(
        release.version,
        requestId,
        release.assetSize,
        release.assetSha256,
      );
      activeDownloadIdRef.current = null;
      setState({
        stage: "restartRequired",
        check: check ?? undefined,
        version: installed.version,
      });
      return installed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      activeDownloadIdRef.current = null;
      onDebug?.({
        id: `${Date.now()}-client-windows-ui-update-install-error`,
        timestamp: Date.now(),
        source: "error",
        label: "windows-ui-updater/install-error",
        payload: message,
      });
      setState({
        stage: "error",
        check: check ?? undefined,
        version: release.version,
        error: message,
      });
      return undefined;
    }
  }, [enabled, onDebug]);

  const dismiss = useCallback(() => {
    if (activeDownloadIdRef.current) {
      return;
    }
    checkRef.current = null;
    setState({ stage: "idle" });
  }, []);

  useEffect(() => {
    if (!enabled || !isTauri()) {
      return;
    }
    return subscribeReleaseAssetDownloadProgress((progress) => {
      if (progress.id !== activeDownloadIdRef.current) {
        return;
      }
      setState((current) => {
        if (current.stage !== "downloading" && current.stage !== "installing") {
          return current;
        }
        const totalBytes = progress.totalBytes ?? current.progress?.totalBytes;
        const downloadComplete =
          typeof totalBytes === "number" &&
          totalBytes > 0 &&
          progress.downloadedBytes >= totalBytes;
        return {
          ...current,
          stage: downloadComplete ? "installing" : "downloading",
          progress: {
            downloadedBytes: progress.downloadedBytes,
            totalBytes: totalBytes ?? undefined,
          },
        };
      });
    }, {
      onError: (error) => {
        onDebug?.({
          id: `${Date.now()}-client-windows-ui-update-progress-error`,
          timestamp: Date.now(),
          source: "error",
          label: "windows-ui-updater/progress-error",
          payload: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }, [enabled, onDebug]);

  useEffect(() => {
    if (!enabled || !autoCheckOnMount || import.meta.env.DEV || !isTauri()) {
      return;
    }
    if (hasAttemptedAutoCheckRef.current) {
      return;
    }
    hasAttemptedAutoCheckRef.current = true;
    void checkForUpdates();
  }, [autoCheckOnMount, checkForUpdates, enabled]);

  return {
    state,
    checkForUpdates,
    startInstall,
    dismiss,
  };
}
