import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";

type Props = {
  appSettings: AppSettings;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
};

export function SettingsArtifactStorage({ appSettings, onUpdateAppSettings }: Props) {
  const { t } = useI18n();
  const saved = appSettings.artifactRoot ?? "";
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved;

  const browse = async () => {
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false, title: t("settings.artifacts.browseTitle") });
      if (typeof selected === "string") setDraft(selected);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onUpdateAppSettings({ ...appSettings, artifactRoot: draft.trim() || null });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-field">
      <label className="settings-field-label" htmlFor="settings-artifact-root">
        {t("settings.artifacts.title")}
      </label>
      <div className="settings-help" id="settings-artifact-help">{t("settings.artifacts.help")}</div>
      <div className="settings-field-row">
        <input
          id="settings-artifact-root"
          className="settings-input"
          value={draft}
          placeholder={t("settings.artifacts.defaultPath")}
          aria-describedby="settings-artifact-help"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && dirty && !busy) void save(); }}
        />
        <button type="button" className="ghost settings-button-compact" disabled={busy || appSettings.backendMode === "remote"} onClick={() => void browse()}>
          {t("common.browse")}
        </button>
      </div>
      <div className="settings-help">{t("settings.artifacts.limitations")}</div>
      {appSettings.backendMode === "remote" && <div className="settings-help">{t("settings.artifacts.remoteHelp")}</div>}
      <div className="settings-field-actions">
        <button type="button" className="ghost settings-button-compact" disabled={busy || !draft} onClick={() => setDraft("")}>
          {t("settings.artifacts.useDefault")}
        </button>
        <button type="button" className="primary settings-button-compact" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
      {error && <div className="settings-help settings-help-error" role="alert">{error}</div>}
    </div>
  );
}
