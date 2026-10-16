import { ModalShell } from "@/features/design-system/components/modal/ModalShell";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { CodexCliUpdateCheckResult } from "@/types";
import type { CodexCliUpdaterStage } from "../hooks/useCodexCliUpdater";
import { formatUpdateError } from "../utils/updatePresentation";
import { CodexCliUpdateProgress } from "./CodexCliUpdateProgress";
import type { CodexCliUpdaterState } from "../hooks/useCodexCliUpdater";

type CodexCliUpdatePromptProps = {
  open: boolean;
  check: CodexCliUpdateCheckResult | null;
  stage?: CodexCliUpdaterStage;
  installedVersion?: string;
  progress?: CodexCliUpdaterState["progress"];
  startedAt?: number;
  finishedAt?: number;
  installEnabled: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  onRecheck?: () => void;
};

export function CodexCliUpdatePrompt({
  open,
  check,
  stage = check?.status ?? "error",
  installedVersion,
  progress,
  startedAt,
  finishedAt,
  installEnabled,
  busy,
  error,
  onCancel,
  onConfirm,
  onRecheck,
}: CodexCliUpdatePromptProps) {
  const { t } = useI18n();
  if (!open) {
    return null;
  }
  const canInstall = check?.status === "available" &&
    (stage === "available" || stage === "installing" || stage === "error");
  const description = canInstall
    ? !installEnabled
      ? t("codexUpdate.remoteDescription")
      : check.source === "managed"
        ? t("codexUpdate.managedDescription")
        : t("codexUpdate.description")
    : stage === "upToDate"
      ? t("settings.codex.codexCliUpdateLatest")
      : stage === "updated"
        ? t("codexUpdate.updatedDescription")
        : stage === "unsupported"
          ? t("settings.codex.codexCliUpdateUnsupported")
          : stage === "notInstalled"
            ? t("settings.codex.missing")
            : stage === "checking"
              ? t("settings.codex.codexCliUpdateChecking")
              : t("settings.codex.codexCliUpdateFailed");
  return (
    <ModalShell
      ariaLabelledBy="codex-cli-update-title"
      ariaDescribedBy="codex-cli-update-description"
      cardClassName="windows-ui-update-confirm"
      onBackdropClick={onCancel}
    >
      <div className="ds-modal-title" id="codex-cli-update-title">
        {canInstall ? t("codexUpdate.title") : t("codexUpdate.resultTitle")}
      </div>
      <div className="ds-modal-subtitle" id="codex-cli-update-description">
        {description}
      </div>
      <dl className="windows-ui-update-confirm-details">
        <div>
          <dt>{t("codexUpdate.currentVersion")}</dt>
          <dd><code>{installedVersion ?? check?.currentVersion ?? "-"}</code></dd>
        </div>
        <div>
          <dt>{t("codexUpdate.targetVersion")}</dt>
          <dd><code>{check?.latestVersion ?? "-"}</code></dd>
        </div>
      </dl>
      {busy && <CodexCliUpdateProgress state={{ stage: "installing", progress, startedAt, finishedAt }} />}
      {error && <div className="ds-modal-error">{formatUpdateError(error, t)}</div>}
      <div className="ds-modal-actions">
        <button type="button" className="ghost ds-modal-button" onClick={onCancel}>
          {busy ? t("codexUpdate.background") : canInstall ? t("codexUpdate.later") : t("common.close")}
        </button>
        {installEnabled && canInstall && (
          <button type="button" className="primary ds-modal-button" onClick={onConfirm} disabled={busy}>
            {busy ? t("codexUpdate.installing") : t("codexUpdate.install")}
          </button>
        )}
        {stage === "error" && !canInstall && onRecheck && (
          <button type="button" className="primary ds-modal-button" onClick={onRecheck}>
            {t("settings.codex.codexCliUpdateCheck")}
          </button>
        )}
      </div>
    </ModalShell>
  );
}
