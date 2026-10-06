import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type {
  CodexCliUpdateCheckResult,
  CodexUpdateResult,
  DebugEntry,
  InstalledManagedCodex,
} from "@/types";
import { checkCodexCliUpdate, installManagedCodex, runCodexUpdate } from "@services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "@services/events";
import { useI18n } from "@/features/i18n/I18nProvider";

export type CodexCliUpdaterStage =
  | "idle"
  | "checking"
  | "notInstalled"
  | "unsupported"
  | "upToDate"
  | "available"
  | "installing"
  | "updated"
  | "error";

export type CodexCliUpdaterState = {
  stage: CodexCliUpdaterStage;
  check?: CodexCliUpdateCheckResult;
  installedVersion?: string;
  update?: CodexUpdateResult;
  error?: string;
  progress?: { downloadedBytes: number; totalBytes?: number };
};

type UseCodexCliUpdaterOptions = {
  enabled?: boolean;
  installEnabled?: boolean;
  autoCheckOnMount?: boolean;
  autoInstallOnMount?: boolean;
  codexBin: string | null;
  onUpdated?: (version: string) => Promise<void> | void;
  onInstalled?: (installed: InstalledManagedCodex, previousCodexBin: string | null) => Promise<void> | void;
  onDebug?: (entry: DebugEntry) => void;
};

type CheckForUpdatesOptions = {
  openPrompt?: boolean;
};

type StartInstallOptions = {
  openPrompt?: boolean;
  codexArgs?: string | null;
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
  autoInstallOnMount = false,
  codexBin,
  onUpdated,
  onInstalled,
  onDebug,
}: UseCodexCliUpdaterOptions) {
  const { t } = useI18n();
  const [state, setState] = useState<CodexCliUpdaterState>({ stage: "idle" });
  const [promptOpen, setPromptOpen] = useState(false);
  const checkRef = useRef<CodexCliUpdateCheckResult | null>(null);
  const activeUpdateIdRef = useRef<string | null>(null);
  const hasAttemptedAutoCheckRef = useRef(false);
  const checkPromiseRef = useRef<Promise<CodexCliUpdateCheckResult | undefined> | null>(null);

  const performCheck = useCallback(
    async ({ openPrompt = true }: CheckForUpdatesOptions = {}) => {
      if (!enabled || !isTauri() || activeUpdateIdRef.current) {
        return undefined;
      }
      setState((current) => ({ stage: "checking", check: current.check }));
      try {
        const result = await checkCodexCliUpdate(codexBin);
        checkRef.current = result;
        const stage = stageForCheck(result);
        setState({ stage, check: result });
        setPromptOpen(openPrompt);
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
        checkRef.current = null;
        setState({
          stage: "error",
          error: message,
        });
        setPromptOpen(openPrompt);
        return undefined;
      }
    },
    [codexBin, enabled, onDebug],
  );

  const checkForUpdates = useCallback((options: CheckForUpdatesOptions = {}) => {
    if (checkPromiseRef.current) return checkPromiseRef.current;
    const promise = performCheck(options).finally(() => { checkPromiseRef.current = null; });
    checkPromiseRef.current = promise;
    return promise;
  }, [performCheck]);

  const startInstall = useCallback(
    async ({ openPrompt = true, codexArgs = null }: StartInstallOptions = {}) => {
      if (
        !enabled ||
        !installEnabled ||
        !isTauri() ||
        activeUpdateIdRef.current
      ) {
        return undefined;
      }
      const check = checkRef.current;
      if (check?.status !== "available") {
        return undefined;
      }
      const requestId = `codex-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      activeUpdateIdRef.current = requestId;
      setPromptOpen(openPrompt);
      setState({
        stage: "installing",
        check,
      });
      try {
        let update: CodexUpdateResult;
        if (check.source === "managed") {
          const packageInfo = check.package;
          if (!packageInfo || !onInstalled) {
            throw new Error(t("codexUpdate.managedUnavailable"));
          }
          const installed = await installManagedCodex(
            packageInfo.urls, packageInfo.fileName, requestId,
            packageInfo.version, packageInfo.size, packageInfo.sha256,
          );
          await onInstalled(installed, codexBin);
          update = {
            ok: true, method: "managed", package: packageInfo.fileName,
            beforeVersion: check.currentVersion, afterVersion: installed.version,
            upgraded: installed.version !== check.currentVersion, output: null, details: null,
          };
        } else {
          update = await runCodexUpdate(codexBin, codexArgs);
        }
        if (!update.ok) {
          throw new Error(update.details || t("settings.codex.codexCliUpdateFailed"));
        }
        const updatedVersion = update.afterVersion ?? check.latestVersion ?? "";
        if (updatedVersion) {
          await onUpdated?.(updatedVersion);
        }
        activeUpdateIdRef.current = null;
        setPromptOpen(openPrompt);
        setState({
          stage: update.upgraded ? "updated" : "upToDate",
          check,
          installedVersion: updatedVersion || undefined,
          update,
        });
        return update;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        activeUpdateIdRef.current = null;
        onDebug?.({
          id: `${Date.now()}-client-codex-cli-update-install-error`,
          timestamp: Date.now(),
          source: "error",
          label: "codex-cli-updater/install-error",
          payload: message,
        });
        setState({ stage: "error", check, error: message });
        return undefined;
      }
    },
    [codexBin, enabled, installEnabled, onDebug, onInstalled, onUpdated, t],
  );

  const checkAndUpdate = useCallback(async () => {
    const result = await checkForUpdates({ openPrompt: false });
    if (result?.status === "available" && installEnabled) {
      await startInstall({ openPrompt: true });
    } else {
      setPromptOpen(true);
    }
    return result;
  }, [checkForUpdates, installEnabled, startInstall]);

  const updateFromSettings = useCallback(async (
    selectedBin: string | null,
    codexArgs: string | null,
  ): Promise<CodexUpdateResult> => {
    if (selectedBin !== codexBin || !installEnabled) {
      return runCodexUpdate(selectedBin, codexArgs);
    }
    const check = await checkForUpdates({ openPrompt: false });
    if (check?.status === "available") {
      const updated = await startInstall({ openPrompt: true, codexArgs });
      if (updated) return updated;
      throw new Error(t("settings.codex.codexCliUpdateFailed"));
    }
    setPromptOpen(true);
    if (check?.status === "upToDate") {
      return {
        ok: true,
        method: check.source === "managed" ? "managed" : "codex",
        package: null,
        beforeVersion: check.currentVersion,
        afterVersion: check.currentVersion,
        upgraded: false,
        output: null,
        details: null,
      };
    }
    throw new Error(t(check?.status === "unsupported"
      ? "settings.codex.codexCliUpdateUnsupported"
      : "settings.codex.codexCliUpdateFailed"));
  }, [checkForUpdates, codexBin, installEnabled, startInstall, t]);

  const dismissPrompt = useCallback(() => {
    if (!activeUpdateIdRef.current) {
      setPromptOpen(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    if (activeUpdateIdRef.current) {
      return;
    }
    checkRef.current = null;
    setPromptOpen(false);
    setState({ stage: "idle" });
  }, []);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    return subscribeReleaseAssetDownloadProgress((progress) => {
      if (progress.id !== activeUpdateIdRef.current) return;
      setState((current) => current.stage !== "installing" ? current : ({
        ...current,
        progress: { downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes ?? undefined },
      }));
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !autoCheckOnMount || import.meta.env.DEV || !isTauri()) {
      return;
    }
    if (hasAttemptedAutoCheckRef.current) {
      return;
    }
    hasAttemptedAutoCheckRef.current = true;
    const shouldAutoInstall = autoInstallOnMount && installEnabled;
    void (async () => {
      const result = await checkForUpdates({
        openPrompt: !shouldAutoInstall,
      });
      if (result?.status === "available" && shouldAutoInstall) {
        const update = await startInstall({ openPrompt: false });
        if (!update) {
          setPromptOpen(true);
        }
      }
    })();
  }, [
    autoCheckOnMount,
    autoInstallOnMount,
    checkForUpdates,
    enabled,
    installEnabled,
    startInstall,
  ]);

  return {
    state,
    promptOpen,
    checkForUpdates,
    startInstall,
    checkAndUpdate,
    updateFromSettings,
    dismissPrompt,
    dismiss,
  };
}
