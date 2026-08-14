import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type {
  CodexCliUpdateCheckResult,
  DebugEntry,
} from "@/types";
import {
  checkCodexCliUpdate,
  installManagedCodex,
} from "@services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "@services/events";

export type CodexCliUpdaterStage =
  | "idle"
  | "checking"
  | "notInstalled"
  | "unsupported"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "restartRequired"
  | "error";

export type CodexCliUpdaterState = {
  stage: CodexCliUpdaterStage;
  check?: CodexCliUpdateCheckResult;
  progress?: {
    downloadedBytes: number;
    totalBytes?: number;
  };
  installedVersion?: string;
  error?: string;
};

type UseCodexCliUpdaterOptions = {
  enabled?: boolean;
  installEnabled?: boolean;
  autoCheckOnMount?: boolean;
  codexBin: string | null;
  onInstalled: (path: string, version: string) => Promise<void> | void;
  onDebug?: (entry: DebugEntry) => void;
};

function stageForCheck(
  result: CodexCliUpdateCheckResult,
): CodexCliUpdaterStage {
  switch (result.status) {
    case "available":
      return "available";
    case "upToDate":
      return "upToDate";
    case "notInstalled":
      return "notInstalled";
    case "unsupported":
      return "unsupported";
  }
}

export function useCodexCliUpdater({
  enabled = true,
  installEnabled = true,
  autoCheckOnMount = true,
  codexBin,
  onInstalled,
  onDebug,
}: UseCodexCliUpdaterOptions) {
  const [state, setState] = useState<CodexCliUpdaterState>({ stage: "idle" });
  const [promptOpen, setPromptOpen] = useState(false);
  const checkRef = useRef<CodexCliUpdateCheckResult | null>(null);
  const activeDownloadIdRef = useRef<string | null>(null);
  const hasAttemptedAutoCheckRef = useRef(false);

  const checkForUpdates = useCallback(async () => {
    if (!enabled || !isTauri()) {
      return undefined;
    }
    setState((current) => ({ stage: "checking", check: current.check }));
    try {
      const result = await checkCodexCliUpdate(codexBin);
      checkRef.current = result;
      const stage = stageForCheck(result);
      setState({ stage, check: result });
      setPromptOpen(stage === "available");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onDebug?.({
        id: `${Date.now()}-client-codex-cli-update-check-error`,
        timestamp: Date.now(),
        source: "error",
        label: "codex-cli-updater/check-error",
        payload: message,
      });
      setState((current) => ({
        stage: "error",
        check: current.check,
        error: message,
      }));
      setPromptOpen(false);
      return undefined;
    }
  }, [codexBin, enabled, onDebug]);

  const startInstall = useCallback(async () => {
    if (!enabled || !installEnabled || !isTauri() || activeDownloadIdRef.current) {
      return undefined;
    }
    const check = checkRef.current;
    const packageInfo = check?.status === "available" ? check.package : null;
    if (!packageInfo) {
      return undefined;
    }
    const requestId = `codex-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeDownloadIdRef.current = requestId;
    setPromptOpen(true);
    setState({
      stage: "downloading",
      check: check ?? undefined,
      progress: { downloadedBytes: 0, totalBytes: packageInfo.size },
    });
    try {
      const installed = await installManagedCodex(
        packageInfo.urls,
        packageInfo.fileName,
        requestId,
        packageInfo.version,
        packageInfo.size,
        packageInfo.sha256,
      );
      await onInstalled(installed.path, installed.version);
      activeDownloadIdRef.current = null;
      setPromptOpen(false);
      setState({
        stage: "restartRequired",
        check: check ?? undefined,
        installedVersion: installed.version,
      });
      return installed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      activeDownloadIdRef.current = null;
      onDebug?.({
        id: `${Date.now()}-client-codex-cli-update-install-error`,
        timestamp: Date.now(),
        source: "error",
        label: "codex-cli-updater/install-error",
        payload: message,
      });
      setState({ stage: "error", check: check ?? undefined, error: message });
      return undefined;
    }
  }, [enabled, installEnabled, onDebug, onInstalled]);

  const dismissPrompt = useCallback(() => {
    if (!activeDownloadIdRef.current) {
      setPromptOpen(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    if (activeDownloadIdRef.current) {
      return;
    }
    checkRef.current = null;
    setPromptOpen(false);
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
        const complete =
          typeof totalBytes === "number" &&
          totalBytes > 0 &&
          progress.downloadedBytes >= totalBytes;
        return {
          ...current,
          stage: complete ? "installing" : "downloading",
          progress: {
            downloadedBytes: progress.downloadedBytes,
            totalBytes: totalBytes ?? undefined,
          },
        };
      });
    }, {
      onError: (error) => {
        onDebug?.({
          id: `${Date.now()}-client-codex-cli-update-progress-error`,
          timestamp: Date.now(),
          source: "error",
          label: "codex-cli-updater/progress-error",
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
    promptOpen,
    checkForUpdates,
    startInstall,
    dismissPrompt,
    dismiss,
  };
}
