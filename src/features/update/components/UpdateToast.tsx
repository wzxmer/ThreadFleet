import ReactMarkdown from "react-markdown";
import { useState } from "react";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PostUpdateNoticeState, UpdateState } from "../hooks/useUpdater";
import {
  ToastActions,
  ToastBody,
  ToastCard,
  ToastError,
  ToastHeader,
  ToastTitle,
  ToastViewport,
} from "../../design-system/components/toast/ToastPrimitives";
import { useI18n } from "@/features/i18n/I18nProvider";
import { WindowsInstallerRepairDialog } from "./WindowsInstallerRepairDialog";
import { WindowsInstallerMigrationDialog } from "./WindowsInstallerMigrationDialog";

type UpdateToastProps = {
  state: UpdateState;
  onUpdate: () => void;
  onDismiss: () => void;
  postUpdateNotice?: PostUpdateNoticeState;
  onDismissPostUpdateNotice?: () => void;
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function UpdateToast({
  state,
  onUpdate,
  onDismiss,
  postUpdateNotice = null,
  onDismissPostUpdateNotice,
}: UpdateToastProps) {
  const { t } = useI18n();
  const [repairOpen, setRepairOpen] = useState(false);
  if (postUpdateNotice) {
    return (
      <ToastViewport className="update-toasts" role="region" ariaLive="polite">
        <ToastCard className="update-toast" role="status">
          <ToastHeader className="update-toast-header">
            <ToastTitle className="update-toast-title">{t("update.whatsNew")}</ToastTitle>
            <div className="update-toast-version">v{postUpdateNotice.version}</div>
          </ToastHeader>
          {postUpdateNotice.stage === "loading" ? (
            <ToastBody className="update-toast-body">
              {t("update.postUpdatedLoading")}
            </ToastBody>
          ) : null}
          {postUpdateNotice.stage === "ready" ? (
            <>
              <ToastBody className="update-toast-body">
                {t("update.postUpdatedReady")}
              </ToastBody>
              <div className="update-toast-notes" role="document">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => {
                      if (!href) {
                        return <span>{children}</span>;
                      }
                      return (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => {
                            event.preventDefault();
                            void openUrl(href);
                          }}
                        >
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {postUpdateNotice.body}
                </ReactMarkdown>
              </div>
            </>
          ) : null}
          {postUpdateNotice.stage === "fallback" ? (
            <ToastBody className="update-toast-body">
              {t("update.postUpdatedFallback").replace("{version}", postUpdateNotice.version)}
            </ToastBody>
          ) : null}
          <ToastActions className="update-toast-actions">
            {postUpdateNotice.stage !== "loading" ? (
              <button
                className="primary"
                onClick={() => {
                  void openUrl(postUpdateNotice.htmlUrl);
                }}
              >
                {t("update.viewOnGitHub")}
              </button>
            ) : null}
            <button
              className="secondary"
              onClick={onDismissPostUpdateNotice ?? onDismiss}
            >
              {t("update.dismiss")}
            </button>
          </ToastActions>
        </ToastCard>
      </ToastViewport>
    );
  }

  if (state.stage === "idle" || state.stage === "upToDate") {
    return null;
  }

  const totalBytes = state.progress?.totalBytes;
  const downloadedBytes = state.progress?.downloadedBytes ?? 0;
  const percent =
    totalBytes && totalBytes > 0
      ? Math.min(100, (downloadedBytes / totalBytes) * 100)
      : null;

  return (
    <>
    <ToastViewport className="update-toasts" role="region" ariaLive="polite">
      <ToastCard className="update-toast" role="status">
        <ToastHeader className="update-toast-header">
          <ToastTitle className="update-toast-title">{t("update.title")}</ToastTitle>
          {state.version ? (
            <div className="update-toast-version">v{state.version}</div>
          ) : null}
        </ToastHeader>
        {state.stage === "checking" && (
          <ToastBody className="update-toast-body">{t("update.checking")}</ToastBody>
        )}
        {state.stage === "available" && (
          <>
            <ToastBody className="update-toast-body">
              {t("update.available")}
            </ToastBody>
            <ToastActions className="update-toast-actions">
              <button className="secondary" onClick={onDismiss}>
                {t("update.later")}
              </button>
              <button className="primary" onClick={onUpdate}>
                {t("update.update")}
              </button>
            </ToastActions>
          </>
        )}
        {state.stage === "downloading" && (
          <>
            <ToastBody className="update-toast-body">
              {t("update.downloading")}
            </ToastBody>
            <div className="update-toast-progress">
              <div className="update-toast-progress-bar">
                <span
                  className="update-toast-progress-fill"
                  style={{ width: percent === null ? "24%" : `${percent}%` }}
                />
              </div>
              <div className="update-toast-progress-meta">
                {totalBytes
                  ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
                  : t("update.downloaded").replace(
                      "{bytes}",
                      formatBytes(downloadedBytes),
                    )}
              </div>
            </div>
          </>
        )}
        {state.stage === "migrationReady" && (
          <ToastBody className="update-toast-body">
            {t("installerMigration.ready")}
          </ToastBody>
        )}
        {state.stage === "installing" && (
          <>
            <ToastBody className="update-toast-body">
              {t("update.installerOpened")}
            </ToastBody>
            <ToastActions className="update-toast-actions">
              <button className="secondary" onClick={onDismiss}>
                {t("update.dismiss")}
              </button>
            </ToastActions>
          </>
        )}
        {state.stage === "restarting" && (
          <ToastBody className="update-toast-body">{t("update.restarting")}</ToastBody>
        )}
        {state.stage === "error" && (
          <>
            <ToastBody className="update-toast-body">{t("update.failed")}</ToastBody>
            {state.error || state.errorCode ? (
              <ToastError className="update-toast-error">
                {state.errorCode === "mixedInstaller"
                  ? t("update.mixedInstallerBlocked")
                  : state.error}
              </ToastError>
            ) : null}
            <ToastActions className="update-toast-actions">
              <button className="secondary" onClick={onDismiss}>
                {t("update.dismiss")}
              </button>
              {state.errorCode === "mixedInstaller" ? (
                <button className="primary" onClick={() => setRepairOpen(true)}>
                  {t("installerRepair.view")}
                </button>
              ) : (
                <button className="primary" onClick={onUpdate}>
                  {t("update.retry")}
                </button>
              )}
            </ToastActions>
          </>
        )}
      </ToastCard>
    </ToastViewport>
    <WindowsInstallerRepairDialog
      open={repairOpen}
      onClose={() => setRepairOpen(false)}
      onRecheck={onUpdate}
    />
    <WindowsInstallerMigrationDialog
      open={state.stage === "migrationReady"}
      targetVersion={state.migrationPreparation?.targetVersion ?? state.version ?? null}
      recoveryMode={state.migrationRecovery === true}
      onClose={onDismiss}
    />
    </>
  );
}
