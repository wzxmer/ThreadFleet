import { revealItemInDir } from "@tauri-apps/plugin-opener";
import FileImage from "lucide-react/dist/esm/icons/file-image";
import FileText from "lucide-react/dist/esm/icons/file-text";
import X from "lucide-react/dist/esm/icons/x";
import {
  ToastActions,
  ToastBody,
  ToastCard,
  ToastError,
  ToastHeader,
  ToastTitle,
  ToastViewport,
} from "@/features/design-system/components/toast/ToastPrimitives";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { ConversationExportFormat, ConversationExportProgress } from "./conversationExport";

type Props = {
  selecting: boolean;
  selectedCount: number;
  totalCount: number;
  busy: boolean;
  progress: ConversationExportProgress | null;
  onSelectAll: () => void;
  onCancelSelection: () => void;
  onExport: (format: ConversationExportFormat) => void;
  onCancelExport: () => void;
  onDismissProgress: () => void;
};

export function ConversationExportControls({
  selecting,
  selectedCount,
  totalCount,
  busy,
  progress,
  onSelectAll,
  onCancelSelection,
  onExport,
  onCancelExport,
  onDismissProgress,
}: Props) {
  const { t } = useI18n();
  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
    : null;
  return (
    <>
      {selecting ? (
        <div className="conversation-export-bar" role="toolbar" aria-label={t("messages.export")}>
          <span className="conversation-export-count">
            {t("messages.exportSelectedCount").replace("{count}", String(selectedCount))}
          </span>
          <button type="button" className="secondary" onClick={onSelectAll} disabled={busy}>
            {t(selectedCount === totalCount ? "messages.exportClearAll" : "messages.exportSelectAll")}
          </button>
          <button
            type="button"
            className="secondary conversation-export-format-button"
            onClick={() => onExport("pdf")}
            disabled={selectedCount === 0 || busy}
          >
            <FileText size={15} aria-hidden /> PDF
          </button>
          <button
            type="button"
            className="secondary conversation-export-format-button"
            onClick={() => onExport("png")}
            disabled={selectedCount === 0 || busy}
          >
            <FileImage size={15} aria-hidden /> PNG
          </button>
          <button
            type="button"
            className="ghost conversation-export-close"
            onClick={onCancelSelection}
            disabled={busy}
            aria-label={t("messages.exportCancelSelection")}
            title={t("messages.exportCancelSelection")}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      ) : null}
      {progress ? (
        <ToastViewport className="conversation-export-toasts" role="region" ariaLive="polite">
          <ToastCard className="conversation-export-toast" role="status">
            <ToastHeader><ToastTitle>{t("messages.exportProgressTitle")}</ToastTitle></ToastHeader>
            <ToastBody className="conversation-export-toast-body">
              {t(`messages.exportStage.${progress.stage}`)}
            </ToastBody>
            {progress.stage !== "completed" && progress.stage !== "error" ? (
              <div className="update-toast-progress">
                <div className="update-toast-progress-bar">
                  <span
                    className={`update-toast-progress-fill${percent === null ? " is-indeterminate" : ""}`}
                    style={{ width: percent === null ? "24%" : `${percent}%` }}
                  />
                </div>
                <div className="update-toast-progress-meta">
                  {t("messages.exportProgressMeta")
                    .replace("{messages}", String(progress.messageCount))
                    .replace("{images}", String(progress.imageCount))}
                </div>
              </div>
            ) : null}
            {progress.error ? <ToastError>{progress.error}</ToastError> : null}
            <ToastActions>
              {busy ? (
                <button type="button" className="secondary" onClick={onCancelExport}>
                  {t("common.cancel")}
                </button>
              ) : null}
              {progress.stage === "completed" && progress.path ? (
                <button type="button" className="primary" onClick={() => void revealItemInDir(progress.path!)}>
                  {t("messages.exportReveal")}
                </button>
              ) : null}
              {!busy ? (
                <button type="button" className="secondary" onClick={onDismissProgress}>
                  {t("common.close")}
                </button>
              ) : null}
            </ToastActions>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </>
  );
}
