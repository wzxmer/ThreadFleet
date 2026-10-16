import { useI18n } from "@/features/i18n/I18nProvider";
import { ToastActions, ToastBody, ToastCard, ToastHeader, ToastTitle } from "@/features/design-system/components/toast/ToastPrimitives";
import type { CodexCliUpdaterState } from "../hooks/useCodexCliUpdater";
import { formatUpdateError } from "../utils/updatePresentation";
import { CodexCliUpdateProgress } from "./CodexCliUpdateProgress";

type Props = { state: CodexCliUpdaterState; onDetails: () => void; onDismiss: () => void; onRetry: () => void };

export function CodexCliUpdateToast({ state, onDetails, onDismiss, onRetry }: Props) {
  const { t } = useI18n();
  if (["idle", "checking", "upToDate", "unsupported", "notInstalled"].includes(state.stage)) return null;
  const message = state.stage === "installing" ? t("codexUpdate.backgroundDescription")
    : state.stage === "checking" ? t("settings.codex.codexCliUpdateChecking")
    : state.stage === "error" ? formatUpdateError(state.error ?? "", t)
    : state.stage === "updated" ? t("codexUpdate.backgroundUpdated")
    : state.stage === "unsupported" ? t("settings.codex.codexCliUpdateUnsupported")
    : state.stage === "notInstalled" ? t("settings.codex.missing") : t("codexUpdate.title");
  return (
    <ToastCard className="update-toast" role="status">
      <ToastHeader className="update-toast-header">
        <ToastTitle className="update-toast-title">{t("codexUpdate.toastTitle")}</ToastTitle>
        <div className="update-toast-version">{state.installedVersion ?? state.check?.latestVersion}</div>
      </ToastHeader>
      <ToastBody className="update-toast-body">{message}</ToastBody>
      {state.stage === "installing" && <CodexCliUpdateProgress state={state} />}
      <ToastActions className="update-toast-actions">
        <button className="secondary" onClick={onDismiss}>{t("update.dismiss")}</button>
        <button className="secondary" onClick={onDetails}>{t("codexUpdate.details")}</button>
        {state.stage === "error" && <button className="primary" onClick={onRetry}>{t("update.retry")}</button>}
      </ToastActions>
    </ToastCard>
  );
}
