import { useEffect, useState } from "react";
import type { AgentCliCandidate, AgentEngine, AppSettings } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import { pickAgentCliPath } from "@services/tauri";
import { useAgentCliDiscovery } from "../hooks/useAgentCliDiscovery";

type SettingsAgentRuntimeSectionProps = {
  appSettings: AppSettings;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
};

const AUTO_SELECTION = "__auto__";
const MANUAL_SELECTION = "__manual__";

type CliInstallationFieldProps = {
  engine: AgentEngine;
  configuredPath: string | null;
  executionHost: string;
  saving: boolean;
  onSavePath: (path: string | null) => Promise<void>;
};

function CliInstallationField({
  engine,
  configuredPath,
  executionHost,
  saving,
  onSavePath,
}: CliInstallationFieldProps) {
  const { t } = useI18n();
  const discovery = useAgentCliDiscovery(engine, configuredPath, executionHost);
  const [pathDraft, setPathDraft] = useState(configuredPath ?? "");
  const [manualMode, setManualMode] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const engineLabel = t(engine === "codex" ? "agents.engineCodex" : "agents.engineGemini");
  const selectionId = `agent-cli-${engine}-selection`;
  const pathId = `agent-cli-${engine}-path`;

  useEffect(() => {
    setPathDraft(configuredPath ?? "");
    setManualMode(false);
  }, [configuredPath]);

  const sourceLabel = (candidate: AgentCliCandidate) =>
    t(
      candidate.source === "managed"
        ? "agents.sourceManaged"
        : candidate.source === "system"
          ? "agents.sourceSystem"
          : "agents.sourceCustom",
    );
  const candidateLabel = (candidate: AgentCliCandidate) =>
    `${candidate.version ?? t("agents.versionUnknown")} · ${sourceLabel(candidate)} · ${candidate.path}${
      candidate.runnable ? "" : ` · ${t("agents.unavailable")}`
    }`;

  const selectedCandidate = configuredPath
    ? discovery.candidates.find((candidate) => candidate.path === configuredPath)
    : discovery.candidates.find((candidate) => candidate.source === "system") ??
      discovery.candidates.find((candidate) => candidate.source === "managed");
  const selection = manualMode
    ? MANUAL_SELECTION
    : configuredPath
      ? selectedCandidate
        ? configuredPath
        : MANUAL_SELECTION
      : AUTO_SELECTION;
  const draftChanged = pathDraft.trim() !== (configuredPath ?? "");

  const browse = async () => {
    setBrowseError(null);
    try {
      const path = await pickAgentCliPath();
      if (path) {
        setPathDraft(path);
        setManualMode(true);
      }
    } catch (failure) {
      setBrowseError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="settings-field">
      <div className="settings-field-label settings-field-label--section">{engineLabel}</div>
      <label className="settings-field-label" htmlFor={selectionId}>
        {t("agents.cliSelection")}
      </label>
      <div className="settings-field-row">
        <select
          id={selectionId}
          className="settings-select settings-input"
          value={selection}
          disabled={saving}
          onChange={(event) => {
            const value = event.target.value;
            if (value === MANUAL_SELECTION) {
              setManualMode(true);
              return;
            }
            setManualMode(false);
            setPathDraft(value === AUTO_SELECTION ? "" : value);
            void onSavePath(value === AUTO_SELECTION ? null : value);
          }}
        >
          <option value={AUTO_SELECTION}>{t("agents.autoDetect")}</option>
          {discovery.candidates.map((candidate) => (
            <option key={candidate.path} value={candidate.path} disabled={!candidate.runnable}>
              {candidateLabel(candidate)}
            </option>
          ))}
          <option value={MANUAL_SELECTION}>{t("agents.manualPath")}</option>
        </select>
        <button
          type="button"
          className="ghost settings-button-compact"
          disabled={discovery.loading || saving}
          onClick={() => void discovery.refresh()}
        >
          {discovery.loading ? t("agents.detecting") : t("agents.refreshDetection")}
        </button>
      </div>
      {discovery.error ? (
        <div className="settings-help settings-help-error" role="status">
          {t("agents.detectionFailed")}: {discovery.error}
        </div>
      ) : !discovery.loading && !discovery.candidates.some((candidate) => candidate.runnable) ? (
        <div className="settings-help">{t("agents.noInstallations")}</div>
      ) : null}
      {selectedCandidate ? (
        <div className="settings-help">
          {t("agents.activePath")}: {candidateLabel(selectedCandidate)}
          {selectedCandidate.error ? (
            <div className="settings-help-error">{selectedCandidate.error}</div>
          ) : null}
        </div>
      ) : null}
      <label className="settings-field-label" htmlFor={pathId}>
        {t("agents.path")}
      </label>
      <div className="settings-field-row">
        <input
          id={pathId}
          className="settings-input"
          value={pathDraft}
          placeholder={t("agents.pathPlaceholder")}
          disabled={saving}
          onChange={(event) => {
            setPathDraft(event.target.value);
            setManualMode(true);
          }}
        />
        <button
          type="button"
          className="ghost settings-button-compact"
          disabled={saving}
          onClick={() => void browse()}
        >
          {t("common.browse")}
        </button>
        <button
          type="button"
          className="primary settings-button-compact"
          disabled={saving || !draftChanged}
          onClick={() => void onSavePath(pathDraft.trim() || null)}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
      {browseError ? (
        <div className="settings-help settings-help-error" role="status">{browseError}</div>
      ) : null}
      {engine === "gemini" ? <div className="settings-help">{t("agents.geminiHelp")}</div> : null}
    </div>
  );
}

export function SettingsAgentRuntimeSection({
  appSettings,
  onUpdateAppSettings,
}: SettingsAgentRuntimeSectionProps) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (changes: Partial<AppSettings>) => {
    setSaving(true);
    setError(null);
    try {
      await onUpdateAppSettings({ ...appSettings, ...changes });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="settings-field">
        <div className="settings-field-label settings-field-label--section">
          {t("agents.runtimeTitle")}
        </div>
        <div className="settings-help">{t("agents.runtimeHelp")}</div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="agent-default-engine">
          {t("agents.defaultEngine")}
        </label>
        <select
          id="agent-default-engine"
          className="settings-select"
          value={appSettings.defaultAgentEngine ?? "codex"}
          disabled={saving}
          onChange={(event) => void save({ defaultAgentEngine: event.target.value as AgentEngine })}
        >
          <option value="codex">{t("agents.engineCodex")}</option>
          <option value="gemini">{t("agents.engineGemini")}</option>
        </select>
        <div className="settings-help">{t("agents.engineHelp")}</div>
      </div>
      {(["codex", "gemini"] as const).map((engine) => (
        <CliInstallationField
          key={engine}
          engine={engine}
          configuredPath={(engine === "codex" ? appSettings.codexBin : appSettings.geminiBin) ?? null}
          executionHost={`${appSettings.backendMode}:${appSettings.remoteBackendHost ?? ""}`}
          saving={saving}
          onSavePath={(path) => save(engine === "codex" ? { codexBin: path } : { geminiBin: path })}
        />
      ))}
      <div className="settings-help">{t("agents.cliChangeHelp")}</div>
      {error ? (
        <div className="settings-help settings-help-error" role="status">
          {t("agents.saveFailed")}: {error}
        </div>
      ) : null}
    </div>
  );
}
