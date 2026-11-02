import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexDoctorResult, InstalledManagedCodex } from "@/types";
import { getManagedCodexPlatform, installManagedCodex } from "@services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "@services/events";
import { fetchManagedCodexPackage } from "@/features/codex/utils/managedCodex";

type Options = {
  enabled: boolean;
  codexBin: string | null;
  codexArgs: string | null;
  doctor: (bin: string | null, args: string | null) => Promise<CodexDoctorResult>;
  onInstalled: (
    installed: InstalledManagedCodex,
    previousBin: string | null,
  ) => Promise<void>;
};

export function useCodexInstallation({
  enabled,
  codexBin,
  codexArgs,
  doctor,
  onInstalled,
}: Options) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [stage, setStage] = useState<"ready" | "downloading" | "error">("ready");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setChecked(false);
    void doctor(codexBin, codexArgs)
      .then((result) => {
        if (!cancelled && !result.version) setPromptOpen(true);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled && /codex cli (?:was )?not found/i.test(message)) {
          setPromptOpen(true);
        }
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [codexArgs, codexBin, doctor, enabled]);

  useEffect(() => subscribeReleaseAssetDownloadProgress((event) => {
      if (event.id !== requestIdRef.current) return;
      if (event.totalBytes && event.totalBytes > 0) {
        setProgress((event.downloadedBytes / event.totalBytes) * 100);
      }
    }), []);

  const install = useCallback(async () => {
    if (!enabled || requestIdRef.current) return;
    setStage("downloading");
    setError(null);
    setProgress(0);
    const requestId = `${Date.now()}-managed-codex`;
    requestIdRef.current = requestId;
    try {
      const platform = await getManagedCodexPlatform();
      const packageInfo = await fetchManagedCodexPackage(platform);
      const installed = await installManagedCodex(
        packageInfo.urls,
        packageInfo.fileName,
        requestId,
        packageInfo.version,
        packageInfo.size,
        packageInfo.sha256,
      );
      await onInstalled(installed, codexBin);
      setPromptOpen(false);
      setStage("ready");
    } catch (error) {
      setStage("error");
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      requestIdRef.current = null;
    }
  }, [codexBin, enabled, onInstalled]);

  const dismiss = useCallback(() => {
    if (!requestIdRef.current) setPromptOpen(false);
  }, []);

  return {
    promptOpen: enabled && promptOpen,
    stage,
    progress,
    error,
    install,
    dismiss,
    startupReady: !enabled || (checked && !promptOpen),
  };
}
