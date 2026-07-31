import { useEffect, useState } from "react";
import { ModalShell } from "@/features/design-system/components/modal/ModalShell";
import { useI18n } from "@/features/i18n/I18nProvider";
import { useWindowsInstallerMigration } from "../hooks/useWindowsInstallerMigration";
import { exportJsonFile } from "@services/tauri";
import {
  buildInstallerMigrationDiagnosticReport,
  serializeInstallerMigrationDiagnosticReport,
} from "../utils/installerMigrationDiagnostic";

type WindowsInstallerMigrationDialogProps = {
  open: boolean;
  targetVersion: string | null;
  recoveryMode?: boolean;
  onClose: () => void;
};

export function WindowsInstallerMigrationDialog({
  open,
  targetVersion,
  recoveryMode = false,
  onClose,
}: WindowsInstallerMigrationDialogProps) {
  const { t } = useI18n();
  const { state, execute, reset, busy, canResume } =
    useWindowsInstallerMigration();
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) {
      setAcknowledged(false);
    } else {
      reset();
    }
  }, [open, reset]);

  if (!open || !targetVersion) return null;

  const resultMessage = state.result?.message;
  return (
    <ModalShell
      className="update-dialog-modal"
      cardClassName="update-dialog-card"
      onBackdropClick={busy ? undefined : onClose}
      ariaLabelledBy="windows-installer-migration-title"
    >
      <div className="update-dialog-content update-migration-dialog-content">
        <div id="windows-installer-migration-title" className="ds-modal-title">
          {t("installerMigration.title")}
        </div>
        <div className="ds-modal-subtitle">
          {t("installerMigration.targetVersion").replace(
            "{version}",
            targetVersion,
          )}
        </div>

        {state.phase === "idle" ? (
          <>
            <div className="settings-help">
              {recoveryMode
                ? t("installerMigration.recoverySummary")
                : t("installerMigration.summary")}
            </div>
            <label className="settings-help">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />{" "}
              {t("installerMigration.acknowledge")}
            </label>
          </>
        ) : null}

        {state.phase === "executing" ? (
          <div className="settings-help">{t("installerMigration.executing")}</div>
        ) : null}
        {state.phase === "completed" ? (
          <div className="settings-help">
            {state.result?.rebootRequired
              ? t("installerMigration.completedReboot")
              : t("installerMigration.completed")}
          </div>
        ) : null}
        {state.phase === "rolledBack" ? (
          <div className="settings-help">{t("installerMigration.rolledBack")}</div>
        ) : null}
        {state.phase === "blocked" ? (
          <div className="ds-modal-error">
            {resultMessage ?? t("installerMigration.blocked")}
          </div>
        ) : null}
        {state.phase === "interrupted" ? (
          <div className="settings-help ds-text-danger">
            {t("installerMigration.interrupted")}
          </div>
        ) : null}
        {state.phase === "error" ? (
          <div className="ds-modal-error">
            {state.error ?? t("installerMigration.failed")}
          </div>
        ) : null}

        <div className="ds-modal-actions">
          <button
            type="button"
            className="ghost ds-modal-button"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.close")}
          </button>
          {state.phase === "idle" ? (
            <button
              type="button"
              className="primary ds-modal-button"
              onClick={() => void execute()}
              disabled={!acknowledged}
            >
              {recoveryMode
                ? t("installerMigration.resume")
                : t("installerMigration.start")}
            </button>
          ) : null}
          {canResume ? (
            <button
              type="button"
              className="primary ds-modal-button"
              onClick={() => void execute()}
            >
              {t("installerMigration.resume")}
            </button>
          ) : null}
          {state.phase !== "idle" && state.phase !== "executing" ? (
            <button
              type="button"
              className="ghost ds-modal-button"
              onClick={() => {
                const report = buildInstallerMigrationDiagnosticReport(
                  state.phase,
                  state.result,
                );
                void exportJsonFile(
                  serializeInstallerMigrationDiagnosticReport(report),
                  `threadfleet-installer-migration-${Date.now()}.json`,
                  t("installerMigration.exportDiagnosticTitle"),
                );
              }}
            >
              {t("installerMigration.exportDiagnostic")}
            </button>
          ) : null}
        </div>
      </div>
    </ModalShell>
  );
}
