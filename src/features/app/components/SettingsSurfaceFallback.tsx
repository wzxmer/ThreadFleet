import { useI18n } from "@/features/i18n/I18nProvider";

export function SettingsSurfaceFallback() {
  const { t } = useI18n();

  return (
    <section
      className="settings-window settings-surface settings-surface-fallback"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={t("settings.title")}
    >
      <div className="settings-titlebar">
        <div className="settings-title">{t("settings.title")}</div>
      </div>
      <div className="settings-surface-fallback-content">
        <span className="settings-surface-fallback-spinner" aria-hidden="true" />
        <span>{t("settings.loading")}</span>
      </div>
    </section>
  );
}
