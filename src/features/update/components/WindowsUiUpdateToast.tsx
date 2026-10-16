import { useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "@/features/i18n/I18nProvider";
import { ToastActions, ToastBody, ToastCard, ToastHeader, ToastTitle } from "@/features/design-system/components/toast/ToastPrimitives";
import type { WindowsUiUpdaterState } from "../hooks/useWindowsUiUpdater";
import { formatUpdateError } from "../utils/updatePresentation";
import { WindowsUiUpdatePrompt } from "./WindowsUiUpdatePrompt";

type Props = {
  state: WindowsUiUpdaterState;
  onInstall: () => void;
  onDismiss: () => void;
};

export function WindowsUiUpdateToast({ state, onInstall, onDismiss }: Props) {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!["available", "downloading", "installing", "restartRequired", "error"].includes(state.stage)) return null;
  const release = state.check?.release;
  const patched = state.check?.reasonCode === "localPatchRequiresReview";
  const busy = state.stage === "downloading" || state.stage === "installing";
  const message = state.stage === "available" ? t("settings.codex.windowsUiUpdateAvailable")
    : state.stage === "downloading" ? t("settings.codex.windowsUiUpdateDownloading")
    : state.stage === "installing" ? t("settings.codex.windowsUiUpdateVerifying")
    : state.stage === "restartRequired" ? t("settings.codex.windowsUiUpdateRestartNotice")
    : formatUpdateError(state.error ?? "", t);
  const total = state.progress?.totalBytes;
  const percent = total && total > 0 ? Math.min(100, state.progress!.downloadedBytes / total * 100) : null;

  return <>
    <ToastCard className="update-toast" role="status">
      <ToastHeader className="update-toast-header">
        <ToastTitle className="update-toast-title">{t("windowsUiUpdate.toastTitle")}</ToastTitle>
        <div className="update-toast-version">{state.version ?? release?.version}</div>
      </ToastHeader>
      <ToastBody className="update-toast-body">{message}</ToastBody>
      {patched && state.stage === "available" ? <ToastBody className="update-toast-body">{t("settings.codex.windowsUiUpdatePatched")}</ToastBody> : null}
      {busy ? <div className="update-toast-progress" role="progressbar" aria-label={t("settings.codex.windowsUiUpdateDownloading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <div className="update-toast-progress-bar"><div className="update-toast-progress-fill" style={{ width: `${percent ?? 0}%` }} /></div>
      </div> : null}
      <ToastActions className="update-toast-actions">
        <button className="secondary" onClick={onDismiss}>{t("update.dismiss")}</button>
        {state.stage === "available" && release ? state.check?.managed ? (
          <button className="primary" onClick={() => setConfirmOpen(true)}>{t("settings.codex.windowsUiUpdateInstall")}</button>
        ) : (
          <button className="secondary" onClick={() => void openUrl(release.releaseUrl)}>{t("update.viewOnGitHub")}</button>
        ) : null}
      </ToastActions>
    </ToastCard>
    {confirmOpen ? createPortal(<WindowsUiUpdatePrompt open={state.stage === "available" && !!state.check?.managed}
      version={release?.version ?? null} assetSize={release?.assetSize ?? null} assetSha256={release?.assetSha256 ?? null}
      onCancel={() => setConfirmOpen(false)} onConfirm={() => { setConfirmOpen(false); onInstall(); }} />,
      document.querySelector(".app") ?? document.body) : null}
  </>;
}
