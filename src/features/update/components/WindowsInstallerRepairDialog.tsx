import { useEffect, useState } from "react";
import { ModalShell } from "@/features/design-system/components/modal/ModalShell";
import { useI18n } from "@/features/i18n/I18nProvider";
import { useWindowsInstallerRepair } from "../hooks/useWindowsInstallerRepair";
import type { WindowsInstallerFamily } from "@services/tauri";

type WindowsInstallerRepairDialogProps = {
  open: boolean;
  onClose: () => void;
  onRecheck: () => unknown | Promise<unknown>;
};

export function WindowsInstallerRepairDialog({
  open,
  onClose,
  onRecheck,
}: WindowsInstallerRepairDialogProps) {
  const { t } = useI18n();
  const {
    state,
    preview,
    apply,
    rollback,
    recover,
    reset,
    busy,
    canApply,
    canRollback,
  } = useWindowsInstallerRepair();
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      void preview();
    } else {
      reset();
    }
  }, [open, preview, reset]);

  if (!open) {
    return null;
  }

  const previewState = state.preview;
  const recoveryRequired =
    previewState?.status === "blocked" && previewState.recoveryRequired === true;
  const shortcutBlocked = previewState?.blockers.some((blocker) =>
    /shortcut|\.lnk/i.test(blocker),
  );
  const familyLabel = (family: WindowsInstallerFamily) => {
    if (family === "msi") {
      return t("installerRepair.familyMsi");
    }
    if (family === "nsis") {
      return t("installerRepair.familyNsis");
    }
    return t("installerRepair.familyUnknown");
  };

  const recheck = () => {
    onClose();
    void onRecheck();
  };

  return (
    <ModalShell
      className="update-dialog-modal"
      cardClassName="update-dialog-card"
      onBackdropClick={busy ? undefined : onClose}
      ariaLabelledBy="windows-installer-repair-title"
    >
      <div className="update-dialog-content update-repair-dialog-content">
        <div id="windows-installer-repair-title" className="ds-modal-title">
          {t("installerRepair.title")}
        </div>
        <div className="ds-modal-subtitle">{t("installerRepair.subtitle")}</div>

        {state.phase === "previewing" ? (
          <div className="settings-help">{t("installerRepair.loading")}</div>
        ) : null}

        {state.phase === "ready" && previewState && recoveryRequired ? (
          <div className="settings-help ds-text-danger">
            {t("installerRepair.recoveryRequired")}
          </div>
        ) : null}

        {state.phase === "ready" && previewState && !recoveryRequired ? (
          <>
            <div className="settings-help">
              {t("installerRepair.currentVersion")}{" "}
              <code>{previewState.currentVersion}</code>
            </div>
            {previewState.records.length > 0 ? (
              <div>
                <div className="settings-label">
                  {t("installerRepair.records")}
                </div>
                <ul className="settings-help">
                  {previewState.records.map((record, index) => (
                    <li
                      key={`${record.family}-${record.displayVersion ?? "unknown"}-${index}`}
                    >
                      {familyLabel(record.family)} ·{" "}
                      {t("installerRepair.version")}{" "}
                      {record.displayVersion ??
                        t("installerRepair.versionUnknown")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {previewState.status === "repairable" ? (
              <>
                <div className="settings-help">
                  {t("installerRepair.repairable")}
                </div>
                <div className="settings-help">
                  {t("installerRepair.plannedActions").replace(
                    "{count}",
                    String(previewState.plannedActions.length),
                  )}
                </div>
                <label className="settings-help">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />{" "}
                  {t("installerRepair.acknowledge")}
                </label>
              </>
            ) : previewState.status === "blocked" ? (
              <div className="settings-help ds-text-danger">
                {shortcutBlocked
                  ? t("installerRepair.shortcutBlocked")
                  : t("installerRepair.blocked")}
              </div>
            ) : (
              <div className="settings-help">
                {t("installerRepair.unsupported")}
              </div>
            )}
          </>
        ) : null}

        {state.phase === "applying" ? (
          <div className="settings-help">{t("installerRepair.applying")}</div>
        ) : null}
        {state.phase === "rollingBack" ? (
          <div className="settings-help">
            {t("installerRepair.rollingBack")}
          </div>
        ) : null}
        {state.phase === "recovering" ? (
          <div className="settings-help">{t("installerRepair.recovering")}</div>
        ) : null}
        {state.phase === "recovered" ? (
          <div className="settings-help">{t("installerRepair.recovered")}</div>
        ) : null}
        {state.phase === "completed" ? (
          <>
            <div className="settings-help">{t("installerRepair.success")}</div>
            <div className="settings-help">
              {t("installerRepair.recheckRequired")}
            </div>
          </>
        ) : null}
        {state.phase === "rolledBack" ? (
          <div className="settings-help">{t("installerRepair.rolledBack")}</div>
        ) : null}
        {state.phase === "error" ? (
          <div className="ds-modal-error">{t("installerRepair.error")}</div>
        ) : null}

        <div className="settings-help">{t("installerRepair.vmLimitation")}</div>

        <div className="ds-modal-actions">
          <button
            type="button"
            className="ghost ds-modal-button"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.close")}
          </button>
          {state.phase === "error" || state.phase === "rolledBack" ? (
            <button
              type="button"
              className="secondary ds-modal-button"
              onClick={() => void preview()}
              disabled={busy}
            >
              {t("installerRepair.retryPreview")}
            </button>
          ) : null}
          {state.phase === "ready" && recoveryRequired ? (
            <button
              type="button"
              className="primary ds-modal-button"
              onClick={() => void recover()}
              disabled={busy}
            >
              {t("installerRepair.recover")}
            </button>
          ) : null}
          {state.phase === "ready" &&
          previewState?.status === "repairable" &&
          !recoveryRequired ? (
            <button
              type="button"
              className="primary ds-modal-button"
              onClick={() => void apply()}
              disabled={!canApply || !acknowledged}
            >
              {t("installerRepair.apply")}
            </button>
          ) : null}
          {state.phase === "recovered" ? (
            <button
              type="button"
              className="primary ds-modal-button"
              onClick={() => void preview()}
              disabled={busy}
            >
              {t("installerRepair.repreview")}
            </button>
          ) : null}
          {state.phase === "completed" ? (
            <>
              <button
                type="button"
                className="secondary ds-modal-button"
                onClick={() => void rollback()}
                disabled={!canRollback}
              >
                {t("installerRepair.rollback")}
              </button>
              <button
                type="button"
                className="primary ds-modal-button"
                onClick={recheck}
              >
                {t("installerRepair.recheck")}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </ModalShell>
  );
}
