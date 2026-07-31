import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { DebugEntry } from "../../../types";
import {
  cleanupDownloadedReleaseAssets,
  downloadAndOpenReleaseAsset,
  downloadReleaseAsset,
  getWindowsInstallerMigrationCapability,
  getWindowsInstallerMigrationRecoveryStatus,
  getReleasePlatform,
  prepareWindowsInstallerMigration,
  type InstallerMigrationPreparationResult,
  windowsInstallerKind,
} from "../../../services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "../../../services/events";
import {
  clearPendingPostUpdateVersion,
  fetchLatestReleaseUpdate,
  type ReleaseUpdateInfo,
  loadPendingPostUpdateVersion,
  releaseArchitectureFromPlatform,
} from "../utils/postUpdateRelease";

type UpdateStage =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "migrationReady"
  | "installing"
  | "restarting"
  | "error";

type UpdateProgress = {
  totalBytes?: number;
  downloadedBytes: number;
};

export type UpdateState = {
  stage: UpdateStage;
  version?: string;
  progress?: UpdateProgress;
  error?: string;
  errorCode?: "mixedInstaller";
  migrationPreparation?: InstallerMigrationPreparationResult;
  migrationRecovery?: boolean;
};

type PostUpdateNotice =
  | {
      stage: "loading";
      version: string;
      htmlUrl: string;
    }
  | {
      stage: "ready";
      version: string;
      body: string;
      htmlUrl: string;
    }
  | {
      stage: "fallback";
      version: string;
      htmlUrl: string;
    };

export type PostUpdateNoticeState = PostUpdateNotice | null;

type UseUpdaterOptions = {
  enabled?: boolean;
  autoCheckOnMount?: boolean;
  onDebug?: (entry: DebugEntry) => void;
  experimentalWindowsInstallerMigrationEnabled?: boolean;
};

export function useUpdater({
  enabled = true,
  autoCheckOnMount = true,
  onDebug,
  experimentalWindowsInstallerMigrationEnabled = false,
}: UseUpdaterOptions) {
  const [state, setState] = useState<UpdateState>({ stage: "idle" });
  const updateRef = useRef<ReleaseUpdateInfo | null>(null);
  const activeDownloadIdRef = useRef<string | null>(null);
  const migrationDownloadRef = useRef(false);
  const cleanupPromiseRef = useRef<Promise<void> | null>(null);
  const hasAttemptedAutoCheckRef = useRef(false);

  const resetToIdle = useCallback(async () => {
    updateRef.current = null;
    activeDownloadIdRef.current = null;
    migrationDownloadRef.current = false;
    setState({ stage: "idle" });
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (!enabled) {
      return undefined;
    }
    try {
      setState({ stage: "checking" });
      const recovery = await getWindowsInstallerMigrationRecoveryStatus().catch(() => null);
      if (recovery?.recoveryRequired) {
        const nextState: UpdateState = {
          stage: "migrationReady",
          version: recovery.targetVersion ?? undefined,
          migrationRecovery: true,
        };
        setState(nextState);
        return nextState;
      }
      const installerKind = await windowsInstallerKind();
      if (installerKind === "mixed") {
        updateRef.current = null;
        const nextState: UpdateState = {
          stage: "error",
          errorCode: "mixedInstaller",
        };
        onDebug?.({
          id: `${Date.now()}-client-updater-mixed-installer`,
          timestamp: Date.now(),
          source: "error",
          label: "updater/mixed-installer",
          payload: "Automatic update blocked because MSI and NSIS registrations coexist.",
        });
        setState(nextState);
        return nextState;
      }
      const nativePlatform = await getReleasePlatform().catch(() => "");
      const architecture = releaseArchitectureFromPlatform(nativePlatform);
      const migrationCapability =
        installerKind === "nsis" && experimentalWindowsInstallerMigrationEnabled
          ? await getWindowsInstallerMigrationCapability().catch(() => null)
          : null;
      const migrateNsisToMsi = migrationCapability?.runtimeEnabled === true;
      const update = await fetchLatestReleaseUpdate(
        __APP_VERSION__,
        undefined,
        undefined,
        installerKind,
        architecture,
        migrateNsisToMsi,
      );
      if (!update) {
        updateRef.current = null;
        migrationDownloadRef.current = false;
        const nextState: UpdateState = { stage: "upToDate" };
        setState(nextState);
        return nextState;
      }

      updateRef.current = update;
      migrationDownloadRef.current = migrateNsisToMsi;
      const nextState: UpdateState = {
        stage: "available",
        version: update.version,
      };
      setState(nextState);
      return nextState;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      onDebug?.({
        id: `${Date.now()}-client-updater-error`,
        timestamp: Date.now(),
        source: "error",
        label: "updater/error",
        payload: message,
      });
      const nextState: UpdateState = { stage: "error", error: message };
      setState(nextState);
      return nextState;
    }
  }, [enabled, experimentalWindowsInstallerMigrationEnabled, onDebug]);

  const startUpdate = useCallback(async () => {
    if (!enabled) {
      return;
    }
    const update = updateRef.current;
    if (!update) {
      await checkForUpdates();
      return;
    }
    await cleanupPromiseRef.current?.catch(() => undefined);

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeDownloadIdRef.current = requestId;
    setState((prev) => ({
      ...prev,
      stage: "downloading",
      progress: {
        totalBytes: update.asset.size,
        downloadedBytes: 0,
      },
      error: undefined,
    }));

    try {
      if (migrationDownloadRef.current) {
        if (!update.asset.size || !update.asset.sha256) {
          throw new Error("Installer migration requires signed size and SHA-256 metadata.");
        }
        const downloaded = await downloadReleaseAsset(
          update.asset.urls,
          update.asset.name,
          requestId,
          update.asset.size,
          update.asset.sha256,
        );
        const preparation = await prepareWindowsInstallerMigration({
          version: update.version,
          artifactPath: downloaded.path,
          artifactSize: update.asset.size,
          artifactSha256: update.asset.sha256,
        });
        activeDownloadIdRef.current = null;
        setState((prev) => ({
          ...prev,
          stage: "migrationReady",
          migrationPreparation: preparation,
          migrationRecovery: false,
          progress: undefined,
        }));
        return;
      }
      await downloadAndOpenReleaseAsset(
        update.asset.urls,
        update.asset.name,
        requestId,
        update.asset.size,
        update.asset.sha256,
      );
      activeDownloadIdRef.current = null;
      setState((prev) => ({
        ...prev,
        stage: "installing",
        progress: {
          totalBytes: prev.progress?.totalBytes ?? update.asset.size,
          downloadedBytes:
            prev.progress?.totalBytes ??
            update.asset.size ??
            prev.progress?.downloadedBytes ??
            0,
        },
      }));
    } catch (error) {
      const message = migrationDownloadRef.current
        ? "Installer migration preparation failed."
        : error instanceof Error
          ? error.message
          : JSON.stringify(error);
      onDebug?.({
        id: `${Date.now()}-client-updater-error`,
        timestamp: Date.now(),
        source: "error",
        label: "updater/error",
        payload: message,
      });
      activeDownloadIdRef.current = null;
      setState((prev) => ({
        ...prev,
        stage: "error",
        error: message,
      }));
    }
  }, [checkForUpdates, enabled, onDebug]);

  useEffect(() => {
    if (!enabled || !isTauri()) {
      return;
    }
    return subscribeReleaseAssetDownloadProgress((progress) => {
      if (progress.id !== activeDownloadIdRef.current) {
        return;
      }
      setState((prev) => {
        if (prev.stage !== "downloading") {
          return prev;
        }
        return {
          ...prev,
          progress: {
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes ?? prev.progress?.totalBytes,
          },
        };
      });
    }, {
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        onDebug?.({
          id: `${Date.now()}-client-updater-progress-error`,
          timestamp: Date.now(),
          source: "error",
          label: "updater/progress-error",
          payload: message,
        });
      },
    });
  }, [enabled, onDebug]);

  useEffect(() => {
    if (!enabled || !isTauri()) {
      return;
    }
    let active = true;
    void getWindowsInstallerMigrationRecoveryStatus()
      .then((recovery) => {
        if (!active || !recovery.recoveryRequired) return;
        setState({
          stage: "migrationReady",
          version: recovery.targetVersion ?? undefined,
          migrationRecovery: true,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !isTauri()) {
      return;
    }
    const cleanupPromise = cleanupDownloadedReleaseAssets().catch((error) => {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      onDebug?.({
        id: `${Date.now()}-client-updater-cleanup-error`,
        timestamp: Date.now(),
        source: "error",
        label: "updater/cleanup-error",
        payload: message,
      });
    });
    cleanupPromiseRef.current = cleanupPromise;
    cleanupPromise.finally(() => {
      if (cleanupPromiseRef.current === cleanupPromise) {
        cleanupPromiseRef.current = null;
      }
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

  useEffect(() => {
    if (!enabled || !isTauri()) {
      return;
    }
    const pendingVersion = loadPendingPostUpdateVersion();
    if (!pendingVersion) {
      return;
    }

    clearPendingPostUpdateVersion();
  }, [enabled]);

  const dismissPostUpdateNotice = useCallback(() => {
    clearPendingPostUpdateVersion();
  }, []);

  return {
    state,
    startUpdate,
    checkForUpdates,
    dismiss: resetToIdle,
    postUpdateNotice: null as PostUpdateNoticeState,
    dismissPostUpdateNotice,
  };
}
