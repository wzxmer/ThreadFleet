import { ModalShell } from "@/features/design-system/components/modal/ModalShell";
import { useI18n } from "@/features/i18n/I18nProvider";

type CodexInstallPromptProps = {
  open: boolean;
  stage: "ready" | "downloading" | "error";
  progress?: number;
  error?: string | null;
  onInstall: () => void;
  onChooseExisting: () => void;
  onLater: () => void;
};

export function CodexInstallPrompt({
  open,
  stage,
  progress,
  error,
  onInstall,
  onChooseExisting,
  onLater,
}: CodexInstallPromptProps) {
  const { t } = useI18n();
  if (!open) return null;
  const busy = stage === "downloading";

  return (
    <ModalShell
      ariaLabel={t("codexInstall.title")}
      className="codex-install-modal"
      onBackdropClick={busy ? undefined : onLater}
    >
      <div className="ds-modal-title">{t("codexInstall.title")}</div>
      <div className="ds-modal-subtitle">{t("codexInstall.subtitle")}</div>
      <div className="codex-install-details">
        <span>{t("codexInstall.size")}</span>
        <span>{t("codexInstall.routes")}</span>
      </div>
      {busy && (
        <div className="codex-install-progress" aria-label={t("codexInstall.downloading")}>
          <div className="codex-install-progress-track">
            <span style={{ width: `${Math.max(2, Math.min(progress ?? 0, 100))}%` }} />
          </div>
          <span>{progress ? `${Math.round(progress)}%` : t("codexInstall.connecting")}</span>
        </div>
      )}
      {error && <div className="ds-modal-error">{t("codexInstall.failed")}: {error}</div>}
      <div className="ds-modal-actions">
        <button type="button" className="ghost ds-modal-button" onClick={onLater} disabled={busy}>
          {t("codexInstall.later")}
        </button>
        <button type="button" className="ghost ds-modal-button" onClick={onChooseExisting} disabled={busy}>
          {t("codexInstall.chooseExisting")}
        </button>
        <button type="button" className="primary ds-modal-button" onClick={onInstall} disabled={busy}>
          {busy ? t("codexInstall.installing") : t("codexInstall.install")}
        </button>
      </div>
    </ModalShell>
  );
}
