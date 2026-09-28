import { ModalShell } from "@/features/design-system/components/modal/ModalShell";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { CodexCliUpdateCheckResult } from "@/types";

type CodexCliUpdatePromptProps = {
  open: boolean;
  check: CodexCliUpdateCheckResult | null;
  installEnabled: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function CodexCliUpdatePrompt({
  open,
  check,
  installEnabled,
  busy,
  error,
  onCancel,
  onConfirm,
}: CodexCliUpdatePromptProps) {
  const { t } = useI18n();
  if (!open || check?.status !== "available" || !check.package) {
    return null;
  }
  return (
    <ModalShell
      ariaLabelledBy="codex-cli-update-title"
      ariaDescribedBy="codex-cli-update-description"
      cardClassName="windows-ui-update-confirm"
      onBackdropClick={busy ? undefined : onCancel}
    >
      <div className="ds-modal-title" id="codex-cli-update-title">
        {t("codexUpdate.title")}
      </div>
      <div className="ds-modal-subtitle" id="codex-cli-update-description">
        {installEnabled
          ? t("codexUpdate.description")
          : t("codexUpdate.remoteDescription")}
      </div>
      <dl className="windows-ui-update-confirm-details">
        <div>
          <dt>{t("codexUpdate.currentVersion")}</dt>
          <dd><code>{check.currentVersion ?? "-"}</code></dd>
        </div>
        <div>
          <dt>{t("codexUpdate.targetVersion")}</dt>
          <dd><code>{check.latestVersion ?? check.package.version}</code></dd>
        </div>
      </dl>
      {error && <div className="ds-modal-error">{error}</div>}
      <div className="ds-modal-actions">
        <button type="button" className="ghost ds-modal-button" onClick={onCancel} disabled={busy}>
          {t("codexUpdate.later")}
        </button>
        {installEnabled && (
          <button type="button" className="primary ds-modal-button" onClick={onConfirm} disabled={busy}>
            {busy ? t("codexUpdate.installing") : t("codexUpdate.install")}
          </button>
        )}
      </div>
    </ModalShell>
  );
}
