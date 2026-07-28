import type { AppSettings, CodexSyncDiagnostics } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";

type CodexSessionSharingStatusProps = {
  backendMode: AppSettings["backendMode"];
  state: {
    status: "idle" | "loading" | "done";
    result: CodexSyncDiagnostics | null;
    error: string | null;
  };
  onRefresh: () => void;
};

type SharingState = "shared" | "separate" | "remote" | "unresolved";

function resolveSharingState(
  backendMode: AppSettings["backendMode"],
  diagnostics: CodexSyncDiagnostics | null,
): SharingState {
  if (backendMode === "remote") {
    return "remote";
  }
  if (diagnostics?.sharesDefaultCodexSessions === true) {
    return "shared";
  }
  if (diagnostics?.sharesDefaultCodexSessions === false) {
    return "separate";
  }
  return "unresolved";
}

export function CodexSessionSharingStatus({
  backendMode,
  state,
  onRefresh,
}: CodexSessionSharingStatusProps) {
  const { t } = useI18n();
  const sharingState = resolveSharingState(backendMode, state.result);
  const titleKey = `settings.codex.sessionSharing.${sharingState}Title` as const;
  const helpKey = `settings.codex.sessionSharing.${sharingState}Help` as const;

  return (
    <div className="settings-field">
      <div className="settings-field-row settings-field-row-between">
        <div>
          <div className="settings-field-label">
            {t("settings.codex.sessionSharing.title")}
          </div>
          <div className="settings-help">
            {t("settings.codex.sessionSharing.help")}
          </div>
        </div>
        <button
          type="button"
          className="ghost settings-button-compact"
          onClick={onRefresh}
          disabled={state.status === "loading"}
        >
          {state.status === "loading" ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      {state.error && (
        <div className="settings-help settings-help-error">{state.error}</div>
      )}
      {state.result && (
        <div className={`settings-doctor${sharingState === "shared" ? " ok" : ""}`}>
          <div className="settings-doctor-title" role="status">
            {t(titleKey)}
          </div>
          <div className="settings-doctor-body">
            <div>{t(helpKey)}</div>
            <div className="settings-doctor-path">
              {t(
                backendMode === "remote"
                  ? "settings.codex.sessionSharing.remoteHome"
                  : "settings.codex.sessionSharing.currentHome",
              )}
              {t("settings.codex.labelSeparator")}
              {state.result.codexHomePath ?? t("settings.codex.unresolved")}
            </div>
            {backendMode === "local" && (
              <div className="settings-doctor-path">
                {t("settings.codex.sessionSharing.defaultHome")}
                {t("settings.codex.labelSeparator")}
                {state.result.defaultCodexHomePath ?? t("settings.codex.unresolved")}
              </div>
            )}
            <div className="settings-doctor-path">
              {t("settings.codex.sessionSharing.sessionsPath")}
              {t("settings.codex.labelSeparator")}
              {state.result.sessionsPath ?? t("settings.codex.notFound")}
            </div>
            <div>
              {t("settings.codex.sessionSharing.fileCount").replace(
                "{count}",
                String(state.result.sessionFileCount),
              )}
            </div>
            {state.result.latestSessionModifiedMs && (
              <div>
                {t("settings.codex.sessionSharing.latestModified")}
                {t("settings.codex.labelSeparator")}
                {new Date(state.result.latestSessionModifiedMs).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
