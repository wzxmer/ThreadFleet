import { ModalShell } from "@/features/design-system/components/modal/ModalShell";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { CodexCliUpdateCheckResult } from "@/types";

type CodexCliUpdatePromptProps = {
  open: boolean;
  check: CodexCliUpdateCheckResult | null;
  installEnabled: boolean;
  busy: boolean;
  progress: number | null;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

function formatBytes(value: number | null | undefined) {
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

export function CodexCliUpdatePrompt({
  open,
  check,
  installEnabled,
  busy,
  progress,
  error,
  onCancel,
  onConfirm,
}: CodexCliUpdatePromptProps) {
  const { t } = useI18n();
  if (!open || check?.status !== "available" || !check.package) {
    return null;
  }
  const sourceKey =
    check.source === "tencent"
      ? "codexUpdate.sourceTencent"
      : check.source === "aliyun"
        ? "codexUpdate.sourceAliyun"
        : "codexUpdate.sourceGithub";

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
        <div>
          <dt>{t("codexUpdate.route")}</dt>
          <dd>{t(sourceKey)}</dd>
        </div>
        <div>
          <dt>{t("codexUpdate.size")}</dt>
          <dd>{formatBytes(check.package.size)}</dd>
        </div>
      </dl>
      {progress !== null && (
        <div className="codex-install-progress" aria-label={t("codexUpdate.downloading")}>
          <div className="codex-install-progress-track">
            <span style={{ width: `${Math.max(2, Math.min(progress, 100))}%` }} />
          </div>
          <span>{Math.round(progress)}%</span>
        </div>
      )}
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
