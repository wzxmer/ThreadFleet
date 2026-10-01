import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type {
  CodexCliUpdateCheckResult,
  CodexUpdateResult,
  DebugEntry,
} from "@/types";
import { checkCodexCliUpdate, runCodexUpdate } from "@services/tauri";

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
};

type UseCodexCliUpdaterOptions = {
  enabled?: boolean;
  installEnabled?: boolean;
  autoCheckOnMount?: boolean;
  autoInstallOnMount?: boolean;
  codexBin: string | null;
  onUpdated?: (version: string) => Promise<void> | void;
  onDebug?: (entry: DebugEntry) => void;
};

type CheckForUpdatesOptions = {
  openPrompt?: boolean;
};

type StartInstallOptions = {
  openPrompt?: boolean;
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
  onDebug,
}: UseCodexCliUpdaterOptions) {
  const [state, setState] = useState<CodexCliUpdaterState>({ stage: "idle" });
  const [promptOpen, setPromptOpen] = useState(false);
  const checkRef = useRef<CodexCliUpdateCheckResult | null>(null);
  const activeUpdateIdRef = useRef<string | null>(null);
  const hasAttemptedAutoCheckRef = useRef(false);

  const checkForUpdates = useCallback(
    async ({ openPrompt = true }: CheckForUpdatesOptions = {}) => {
      if (!enabled || !isTauri()) {
        return undefined;
      }
      setState((current) => ({ stage: "checking", check: current.check }));
      try {
        const result = await checkCodexCliUpdate(codexBin);
        checkRef.current = result;
        const stage = stageForCheck(result);
        setState({ stage, check: result });
        setPromptOpen(openPrompt && stage === "available");
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
    },
    [codexBin, enabled, onDebug],
  );

  const startInstall = useCallback(
    async ({ openPrompt = true }: StartInstallOptions = {}) => {
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
        const update = await runCodexUpdate(codexBin, null);
        if (!update.ok) {
          throw new Error(update.details || "Codex CLI update failed.");
        }
        const updatedVersion = update.afterVersion ?? check.latestVersion ?? "";
        if (updatedVersion) {
          await onUpdated?.(updatedVersion);
        }
        activeUpdateIdRef.current = null;
        setPromptOpen(false);
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
    [codexBin, enabled, installEnabled, onDebug, onUpdated],
  );

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
    dismissPrompt,
    dismiss,
  };
}
