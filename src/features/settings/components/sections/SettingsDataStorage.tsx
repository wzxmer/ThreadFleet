import { useEffect, useState } from "react";
import { pickStorageDirectory } from "@services/tauri";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { I18nKey } from "@/features/i18n/strings";
import { useStorageMigration } from "@settings/hooks/useStorageMigration";

const states: Record<string, I18nKey> = {
  queued: "settings.storage.queued", copying: "settings.storage.copying", switching: "settings.storage.switching",
  ready: "settings.storage.ready", failed: "settings.storage.failed", cancelled: "settings.storage.cancelled",
  "cleanup-queued": "settings.storage.cleanupQueued", cleaning: "settings.storage.cleaning",
  recovering: "settings.storage.recovering", "recovery-required": "settings.storage.recoveryRequired",
};
const kinds: Record<string, I18nKey> = {
  "app-data": "settings.storage.kind.app-data", "app-cache": "settings.storage.kind.app-cache",
  codex: "settings.storage.kind.codex", "codex-custom": "settings.storage.kind.codex-custom",
  gemini: "settings.storage.kind.gemini", "artifacts-custom": "settings.storage.kind.artifacts-custom",
};

export function SettingsDataStorage({ remote = false }: { remote?: boolean }) {
  const { t } = useI18n();
  const { status, error, busy, perform, saveMaintenance } = useStorageMigration();
  const [root, setRoot] = useState("D:\\ThreadFleetData");
  const [confirmed, setConfirmed] = useState(false);
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState("30");
  const policy = status?.maintenance;
  const policyEnabled = policy?.enabled;
  const retentionDays = policy?.retentionDays;
  useEffect(() => {
    if (policyEnabled !== undefined && retentionDays !== undefined) { setEnabled(policyEnabled); setDays(String(retentionDays)); }
  }, [policyEnabled, retentionDays]);
  const savedRoot = status?.plan?.root;
  useEffect(() => { if (savedRoot) setRoot(savedRoot); }, [savedRoot]);
  const plan = status?.plan;
  const canSchedule = !plan || plan.status === "cancelled" || (plan.status === "ready" && plan.backupsCleaned);
  const waiting = plan?.status === "queued" || plan?.status === "cleanup-queued";
  const browse = async () => {
    setBrowseError(null);
    try {
      const selected = await pickStorageDirectory(t("settings.storage.browse"));
      if (typeof selected === "string") { setRoot(selected); setConfirmed(false); }
    } catch (cause) { setBrowseError(String(cause)); }
  };
  return (
    <div className="settings-field">
      <label className="settings-field-label" htmlFor="settings-data-root">{t("settings.storage.title")}</label>
      <div className="settings-help" id="settings-data-help">{t("settings.storage.help")}</div>
      {remote && <div className="settings-help">{t("settings.storage.remote")}</div>}
      {status && !status.supported ? <div className="settings-help">{t("settings.storage.unsupported")}</div> : <>
        <div className="settings-field-row">
          <input id="settings-data-root" className="settings-input" value={root} aria-describedby="settings-data-help"
            disabled={busy || !canSchedule || !status} onChange={(event) => { setRoot(event.target.value); setConfirmed(false); }} />
          <button type="button" className="ghost settings-button-compact" disabled={busy || !canSchedule || !status} onClick={() => void browse()}>{t("common.browse")}</button>
        </div>
        <div className="settings-help">{t("settings.storage.boundaries")}</div>
        <details className="settings-help">
          <summary>{t("settings.storage.locations")}</summary>
          {(plan?.locations ?? status?.locations ?? []).map((location) => <div key={location.kind}>
            <div>{kinds[location.kind] ? t(kinds[location.kind]) : location.kind}: <code>{location.alias}</code></div>
            <div>→ <code>{canSchedule ? `${root.replace(/[\\/]+$/, "")}\\${location.kind}` : location.destination}</code></div>
          </div>)}
        </details>
        {plan && <div className="settings-help" role="status">{t(states[plan.status] ?? "settings.storage.unknown")}</div>}
        {canSchedule && <>
          <label className="settings-help"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> {t("settings.storage.confirm")}</label>
          <div className="settings-field-actions"><button type="button" className="primary settings-button-compact" disabled={busy || !status || !confirmed || !root.trim()} onClick={() => void perform("schedule", root.trim())}>{t("settings.storage.schedule")}</button></div>
        </>}
        {waiting && <button type="button" className="ghost settings-button-compact" disabled={busy} onClick={() => void perform("cancel")}>{t("common.cancel")}</button>}
        {plan?.status === "failed" && <>
          <button type="button" className="ghost settings-button-compact" disabled={busy} onClick={() => void perform("retry")}>{t("settings.storage.retry")}</button>
          <button type="button" className="ghost settings-button-compact" disabled={busy} onClick={() => void perform("cancel")}>{t("settings.storage.dismiss")}</button>
          <div className="settings-help">{t("settings.storage.failedCopies")}</div>
        </>}
        {plan?.status === "ready" && !plan.backupsCleaned && <>
          <div className="settings-help">{t("settings.storage.backups")}</div>
          <label className="settings-help"><input type="checkbox" checked={cleanupConfirmed} disabled={busy} onChange={(event) => setCleanupConfirmed(event.target.checked)} /> {t("settings.storage.cleanupConfirm")}</label>
          <div className="settings-field-actions"><button type="button" className="ghost settings-button-compact" disabled={busy || !cleanupConfirmed} onClick={() => void perform("cleanup")}>{t("settings.storage.cleanup")}</button></div>
        </>}
        <div className="settings-field">
          <div className="settings-field-label">{t("settings.storage.maintenanceTitle")}</div>
          <div className="settings-help">{t("settings.storage.maintenanceHelp")}</div>
          <label className="settings-help"><input type="checkbox" checked={enabled} disabled={busy || !status} onChange={(event) => setEnabled(event.target.checked)} /> {t("settings.storage.maintenanceEnable")}</label>
          <label className="settings-help" htmlFor="storage-retention">{t("settings.storage.retention")}</label>
          <div className="settings-field-row">
            <input id="storage-retention" type="number" className="settings-input" min={7} max={365} value={days} disabled={busy || !status} onChange={(event) => setDays(event.target.value)} />
            <button type="button" className="ghost settings-button-compact" disabled={busy || !status || !Number.isInteger(Number(days)) || Number(days) < 7 || Number(days) > 365} onClick={() => void saveMaintenance(enabled, Number(days))}>{t("settings.storage.saveMaintenance")}</button>
          </div>
          <div className="settings-help">{t("settings.storage.protectedData")}</div>
          {policy?.lastRun && <div className="settings-help" role="status">{t("settings.storage.lastCleanup").replace("{date}", new Date(policy.lastRun).toLocaleString()).replace("{files}", String(policy.removedFiles)).replace("{size}", (policy.removedBytes / 1024 / 1024).toFixed(1))}</div>}
          {policy?.error && <div className="settings-help settings-help-error" role="alert">{policy.error}</div>}
        </div>
      </>}
      {(error || browseError || plan?.error) && <div className="settings-help settings-help-error" role="alert">{error || browseError || plan?.error}</div>}
    </div>
  );
}
