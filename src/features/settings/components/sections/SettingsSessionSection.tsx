import { useEffect, useState } from "react";
import type { AppSettings } from "@/types";
import {
  CHAT_SCROLLBACK_DEFAULT,
  CHAT_SCROLLBACK_MAX,
  CHAT_SCROLLBACK_MIN,
  CHAT_SCROLLBACK_PRESETS,
  clampChatScrollbackItems,
  isChatScrollbackPreset,
} from "@utils/chatScrollback";
import {
  SettingsSection,
  SettingsToggleRow,
  SettingsToggleSwitch,
} from "@/features/design-system/components/settings/SettingsPrimitives";
import { useI18n } from "@/features/i18n/I18nProvider";
import { useSessionCleanupSettings } from "@settings/hooks/useSessionCleanupSettings";
import { SessionAutoDeleteEnablePrompt } from "../session/SessionAutoDeleteEnablePrompt";
import { SessionImmediateCleanupPrompt } from "../session/SessionImmediateCleanupPrompt";
import { SettingsArtifactStorage } from "./SettingsArtifactStorage";

const AUTO_ARCHIVE_DAY_OPTIONS = [3, 5, 7, 15, 30] as const;
const AUTO_DELETE_DAY_OPTIONS = [30, 60, 90, 180] as const;
type SettingsSessionSectionProps = {
  appSettings: AppSettings;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
};

export function SettingsSessionSection({
  appSettings,
  onUpdateAppSettings,
}: SettingsSessionSectionProps) {
  const { t } = useI18n();
  const {
    cleanupPrompt,
    cleanupBusy,
    cleanupError,
    cleanupSummary,
    openCleanupPrompt,
    closeCleanupPrompt,
    confirmEnableAutoDelete,
    confirmImmediateCleanup,
  } = useSessionCleanupSettings({ appSettings, onUpdateAppSettings });
  const scrollbackUnlimited = appSettings.chatHistoryScrollbackItems === null;
  const [scrollbackDraft, setScrollbackDraft] = useState(() => {
    const value = appSettings.chatHistoryScrollbackItems;
    return typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : String(CHAT_SCROLLBACK_DEFAULT);
  });

  useEffect(() => {
    const value = appSettings.chatHistoryScrollbackItems;
    if (typeof value === "number" && Number.isFinite(value)) {
      setScrollbackDraft(String(value));
    }
  }, [appSettings.chatHistoryScrollbackItems]);

  const scrollbackPresetValue = (() => {
    const value = appSettings.chatHistoryScrollbackItems;
    if (typeof value === "number" && isChatScrollbackPreset(value)) {
      return String(value);
    }
    return "custom";
  })();

  const commitScrollback = () => {
    if (scrollbackUnlimited) {
      return;
    }
    const trimmed = scrollbackDraft.trim();
    const parsed = trimmed ? Number(trimmed) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      const current = appSettings.chatHistoryScrollbackItems;
      const fallback =
        typeof current === "number" && Number.isFinite(current)
          ? current
          : CHAT_SCROLLBACK_DEFAULT;
      setScrollbackDraft(String(fallback));
      return;
    }
    const nextValue = clampChatScrollbackItems(parsed);
    setScrollbackDraft(String(nextValue));
    if (appSettings.chatHistoryScrollbackItems === nextValue) {
      return;
    }
    void onUpdateAppSettings({
      ...appSettings,
      chatHistoryScrollbackItems: nextValue,
    });
  };

  const toggleUnlimitedScrollback = () => {
    const nextUnlimited = !scrollbackUnlimited;
    if (nextUnlimited) {
      void onUpdateAppSettings({
        ...appSettings,
        chatHistoryScrollbackItems: null,
      });
      return;
    }
    const trimmed = scrollbackDraft.trim();
    const parsed = trimmed ? Number(trimmed) : Number.NaN;
    const nextValue = Number.isFinite(parsed)
      ? clampChatScrollbackItems(parsed)
      : CHAT_SCROLLBACK_DEFAULT;
    setScrollbackDraft(String(nextValue));
    void onUpdateAppSettings({
      ...appSettings,
      chatHistoryScrollbackItems: nextValue,
    });
  };

  const selectScrollbackPreset = (rawValue: string) => {
    if (scrollbackUnlimited || rawValue === "custom") {
      return;
    }
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const nextValue = clampChatScrollbackItems(parsed);
    setScrollbackDraft(String(nextValue));
    void onUpdateAppSettings({
      ...appSettings,
      chatHistoryScrollbackItems: nextValue,
    });
  };

  return (
    <SettingsSection
      title={t("settings.session.title")}
      subtitle={t("settings.session.subtitle")}
    >
      <SettingsArtifactStorage appSettings={appSettings} onUpdateAppSettings={onUpdateAppSettings} />
      <div className="settings-subsection-title">{t("settings.session.lifecycle")}</div>
      <SettingsToggleRow
        title={t("settings.session.autoArchiveTitle")}
        subtitle={t("settings.session.autoArchiveSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.autoArchiveThreadsEnabled}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              autoArchiveThreadsEnabled: !appSettings.autoArchiveThreadsEnabled,
            })
          }
        />
      </SettingsToggleRow>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="auto-archive-days">
          {t("settings.session.autoArchiveDays")}
        </label>
        <select
          id="auto-archive-days"
          className="settings-select"
          value={appSettings.autoArchiveThreadsDays}
          disabled={!appSettings.autoArchiveThreadsEnabled}
          onChange={(event) =>
            void onUpdateAppSettings({
              ...appSettings,
              autoArchiveThreadsDays: Number(event.target.value),
            })
          }
        >
          {AUTO_ARCHIVE_DAY_OPTIONS.map((days) => (
            <option key={days} value={days}>
              {t("settings.session.daysValue").replace("{days}", String(days))}
            </option>
          ))}
        </select>
        <div className="settings-help">{t("settings.session.autoArchiveHelp")}</div>
      </div>
      <SettingsToggleRow
        title={t("settings.session.autoDeleteTitle")}
        subtitle={t("settings.session.autoDeleteSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.autoDeleteArchivedThreadsEnabled}
          disabled={cleanupBusy}
          onClick={() => {
            if (appSettings.autoDeleteArchivedThreadsEnabled) {
              void onUpdateAppSettings({
                ...appSettings,
                autoDeleteArchivedThreadsEnabled: false,
              });
              return;
            }
            void openCleanupPrompt("enable");
          }}
        />
      </SettingsToggleRow>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="auto-delete-days">
          {t("settings.session.autoDeleteDays")}
        </label>
        <select
          id="auto-delete-days"
          className="settings-select"
          value={appSettings.autoDeleteArchivedThreadsDays}
          onChange={(event) =>
            void onUpdateAppSettings({
              ...appSettings,
              autoDeleteArchivedThreadsDays: Number(event.target.value) as
                | 30
                | 60
                | 90
                | 180,
            })
          }
        >
          {AUTO_DELETE_DAY_OPTIONS.map((days) => (
            <option key={days} value={days}>
              {t("settings.session.daysValue").replace("{days}", String(days))}
            </option>
          ))}
        </select>
        <div className="settings-help">{t("settings.session.autoDeleteHelp")}</div>
        <button
          type="button"
          className="ghost settings-button-compact"
          disabled={cleanupBusy}
          onClick={() => void openCleanupPrompt("immediate")}
        >
          {cleanupBusy
            ? t("settings.session.cleanupPreviewing")
            : t("settings.session.immediateCleanup")}
        </button>
        {cleanupError && !cleanupPrompt && (
          <div className="settings-error">{cleanupError}</div>
        )}
        {cleanupSummary && <div className="settings-help">{cleanupSummary}</div>}
      </div>
      <SettingsToggleRow
        title={t("settings.session.autoTitleTitle")}
        subtitle={t("settings.session.autoTitleSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.threadTitleAutogenerationEnabled}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              threadTitleAutogenerationEnabled:
                !appSettings.threadTitleAutogenerationEnabled,
            })
          }
        />
      </SettingsToggleRow>

      <div className="settings-subsection-title">{t("settings.session.history")}</div>
      <div className="settings-subsection-subtitle">
        {t("settings.session.historySubtitle")}
      </div>
      <SettingsToggleRow
        title={t("settings.session.unlimitedHistoryTitle")}
        subtitle={t("settings.session.unlimitedHistorySubtitle")}
      >
        <SettingsToggleSwitch
          pressed={scrollbackUnlimited}
          onClick={toggleUnlimitedScrollback}
          data-scrollback-control="true"
        />
      </SettingsToggleRow>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="chat-scrollback-preset">
          {t("settings.session.historyPreset")}
        </label>
        <select
          id="chat-scrollback-preset"
          className="settings-select"
          value={scrollbackPresetValue}
          onChange={(event) => selectScrollbackPreset(event.target.value)}
          data-scrollback-control="true"
          disabled={scrollbackUnlimited}
        >
          <option value="custom">{t("common.custom")}</option>
          {CHAT_SCROLLBACK_PRESETS.map((value) => (
            <option key={value} value={value}>
              {value === CHAT_SCROLLBACK_DEFAULT
                ? t("settings.session.defaultValue").replace("{value}", String(value))
                : value}
            </option>
          ))}
        </select>
        <div className="settings-help">{t("settings.session.historyPresetHelp")}</div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="chat-scrollback-items">
          {t("settings.session.maxEntries")}
        </label>
        <div className="settings-field-row">
          <input
            id="chat-scrollback-items"
            type="text"
            inputMode="numeric"
            className="settings-input"
            value={scrollbackDraft}
            disabled={scrollbackUnlimited}
            onChange={(event) => setScrollbackDraft(event.target.value)}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                nextTarget instanceof HTMLElement &&
                nextTarget.dataset.scrollbackControl === "true"
              ) {
                return;
              }
              commitScrollback();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitScrollback();
              }
            }}
          />
          <button
            type="button"
            className="ghost settings-button-compact"
            data-scrollback-control="true"
            disabled={scrollbackUnlimited}
            onClick={() => {
              setScrollbackDraft(String(CHAT_SCROLLBACK_DEFAULT));
              void onUpdateAppSettings({
                ...appSettings,
                chatHistoryScrollbackItems: CHAT_SCROLLBACK_DEFAULT,
              });
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">
          {t("settings.session.maxEntriesHelp")
            .replace("{min}", String(CHAT_SCROLLBACK_MIN))
            .replace("{max}", String(CHAT_SCROLLBACK_MAX))}
        </div>
      </div>
      {cleanupPrompt?.kind === "enable" && (
        <SessionAutoDeleteEnablePrompt
          eligibleCount={cleanupPrompt.eligibleCount}
          busy={cleanupBusy}
          error={cleanupError}
          onCancel={closeCleanupPrompt}
          onConfirm={() => void confirmEnableAutoDelete()}
        />
      )}
      {cleanupPrompt?.kind === "immediate" && (
        <SessionImmediateCleanupPrompt
          eligibleCount={cleanupPrompt.eligibleCount}
          busy={cleanupBusy}
          error={cleanupError}
          onCancel={closeCleanupPrompt}
          onConfirm={() => void confirmImmediateCleanup()}
        />
      )}
    </SettingsSection>
  );
}
