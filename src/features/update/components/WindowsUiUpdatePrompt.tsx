import { ModalShell } from "@/features/design-system/components/modal/ModalShell";
import { useI18n } from "@/features/i18n/I18nProvider";

type WindowsUiUpdatePromptProps = {
  open: boolean;
  version: string | null;
  assetSize: number | null;
  assetSha256: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

function formatBytes(value: number | null) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return "-";
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

export function WindowsUiUpdatePrompt({
  open,
  version,
  assetSize,
  assetSha256,
  onCancel,
  onConfirm,
}: WindowsUiUpdatePromptProps) {
  const { t } = useI18n();
  if (!open || !version || !assetSha256) {
    return null;
  }

  return (
    <ModalShell
      ariaLabelledBy="windows-ui-update-title"
      ariaDescribedBy="windows-ui-update-description"
      cardClassName="windows-ui-update-confirm"
      onBackdropClick={onCancel}
    >
      <div className="ds-modal-title" id="windows-ui-update-title">
        {t("settings.codex.windowsUiUpdateConfirmTitle")}
      </div>
      <div className="ds-modal-subtitle" id="windows-ui-update-description">
        {t("settings.codex.windowsUiUpdateConfirmDescription")} <code>v{version}</code>
      </div>
      <dl className="windows-ui-update-confirm-details">
        <div>
          <dt>{t("settings.codex.windowsUiUpdateSource")}</dt>
          <dd><code>sbroenne/mcp-windows</code></dd>
        </div>
        <div>
          <dt>{t("settings.codex.windowsUiUpdateSize")}</dt>
          <dd>{formatBytes(assetSize)}</dd>
        </div>
        <div>
          <dt>SHA-256</dt>
          <dd><code>{assetSha256}</code></dd>
        </div>
      </dl>
      <div className="ds-modal-subtitle">
        {t("settings.codex.windowsUiUpdateRestartNotice")}
      </div>
      <div className="ds-modal-actions">
        <button type="button" className="ghost ds-modal-button" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary ds-modal-button" onClick={onConfirm}>
          {t("settings.codex.windowsUiUpdateConfirmInstall")}
        </button>
      </div>
    </ModalShell>
  );
}
