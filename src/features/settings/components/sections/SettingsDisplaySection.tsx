import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { AppSettings } from "@/types";
import {
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  CODE_FONT_SIZE_DEFAULT,
  CODE_FONT_FAMILY_PRESETS,
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_CJK_FONT_FAMILY,
  DEFAULT_UI_LATIN_FONT_FAMILY,
  MESSAGE_FONT_SIZE_DEFAULT,
  MESSAGE_FONT_SIZE_MAX,
  MESSAGE_FONT_SIZE_MIN,
  PROCESS_FONT_SIZE_DEFAULT,
  PROCESS_FONT_SIZE_MAX,
  PROCESS_FONT_SIZE_MIN,
  UI_CJK_FONT_FAMILY_PRESETS,
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  UI_FONT_WEIGHT_DEFAULT,
  UI_FONT_WEIGHT_MAX,
  UI_FONT_WEIGHT_MIN,
  UI_LATIN_FONT_FAMILY_PRESETS,
  WINDOWS_UI_CJK_FONT_FAMILY,
} from "@utils/fonts";
import { listSystemFonts } from "@services/tauri";

import {
  SettingsSection,
  SettingsToggleRow,
  SettingsToggleSwitch,
} from "@/features/design-system/components/settings/SettingsPrimitives";
import { RoundedSelect } from "@/features/design-system/components/select/RoundedSelect";
import { useI18n } from "@/features/i18n/I18nProvider";

const FONT_CLARITY_PRESETS: Array<{
  id: string;
  uiLatinFontFamily: string;
  uiCjkFontFamily: string;
  uiFontWeight: number;
}> = [
  {
    id: "standard",
    uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
    uiCjkFontFamily: DEFAULT_UI_CJK_FONT_FAMILY,
    uiFontWeight: UI_FONT_WEIGHT_DEFAULT,
  },
  {
    id: "windows-clear",
    uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
    uiCjkFontFamily: WINDOWS_UI_CJK_FONT_FAMILY,
    uiFontWeight: 500,
  },
  {
    id: "bold-reading",
    uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
    uiCjkFontFamily: DEFAULT_UI_CJK_FONT_FAMILY,
    uiFontWeight: 550,
  },
  {
    id: "light",
    uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
    uiCjkFontFamily: DEFAULT_UI_CJK_FONT_FAMILY,
    uiFontWeight: 400,
  },
];

type SettingsDisplaySectionProps = {
  appSettings: AppSettings;
  reduceTransparency: boolean;
  scaleShortcutTitle: string;
  scaleShortcutText: string;
  scaleDraft: string;
  uiLatinFontDraft?: string;
  uiCjkFontDraft?: string;
  uiFontSizeDraft?: number;
  messageFontSizeDraft?: number;
  processFontSizeDraft?: number;
  uiFontWeightDraft?: number;
  codeFontDraft: string;
  codeFontSizeDraft: number;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  onToggleTransparency: (value: boolean) => void;
  onSetScaleDraft: Dispatch<SetStateAction<string>>;
  onCommitScale: () => Promise<void>;
  onResetScale: () => Promise<void>;
  onSetUiLatinFontDraft?: Dispatch<SetStateAction<string>>;
  onCommitUiLatinFont?: () => Promise<void>;
  onSetUiCjkFontDraft?: Dispatch<SetStateAction<string>>;
  onCommitUiCjkFont?: () => Promise<void>;
  onSetUiFontSizeDraft?: Dispatch<SetStateAction<number>>;
  onCommitUiFontSize?: (nextSize: number) => Promise<void>;
  onSetMessageFontSizeDraft?: Dispatch<SetStateAction<number>>;
  onCommitMessageFontSize?: (nextSize: number) => Promise<void>;
  onSetProcessFontSizeDraft?: Dispatch<SetStateAction<number>>;
  onCommitProcessFontSize?: (nextSize: number) => Promise<void>;
  onSetUiFontWeightDraft?: Dispatch<SetStateAction<number>>;
  onCommitUiFontWeight?: (nextWeight: number) => Promise<void>;
  onSetCodeFontDraft: Dispatch<SetStateAction<string>>;
  onCommitCodeFont: () => Promise<void>;
  onSetCodeFontSizeDraft: Dispatch<SetStateAction<number>>;
  onCommitCodeFontSize: (nextSize: number) => Promise<void>;
  onResetAllFontSizes?: () => Promise<void>;
  onTestNotificationSound: () => void;
  onTestSystemNotification: () => void;
};

export function SettingsDisplaySection({
  appSettings,
  reduceTransparency,
  scaleShortcutTitle,
  scaleShortcutText,
  scaleDraft,
  uiLatinFontDraft = DEFAULT_UI_LATIN_FONT_FAMILY,
  uiCjkFontDraft = DEFAULT_UI_CJK_FONT_FAMILY,
  uiFontSizeDraft = UI_FONT_SIZE_DEFAULT,
  messageFontSizeDraft = MESSAGE_FONT_SIZE_DEFAULT,
  processFontSizeDraft = PROCESS_FONT_SIZE_DEFAULT,
  uiFontWeightDraft = UI_FONT_WEIGHT_DEFAULT,
  codeFontDraft,
  codeFontSizeDraft,
  onUpdateAppSettings,
  onToggleTransparency,
  onSetScaleDraft,
  onCommitScale,
  onResetScale,
  onSetUiLatinFontDraft = () => {},
  onCommitUiLatinFont = async () => {},
  onSetUiCjkFontDraft = () => {},
  onCommitUiCjkFont = async () => {},
  onSetUiFontSizeDraft = () => {},
  onCommitUiFontSize = async () => {},
  onSetMessageFontSizeDraft = () => {},
  onCommitMessageFontSize = async () => {},
  onSetProcessFontSizeDraft = () => {},
  onCommitProcessFontSize = async () => {},
  onSetUiFontWeightDraft = () => {},
  onCommitUiFontWeight = async () => {},
  onSetCodeFontDraft,
  onCommitCodeFont,
  onSetCodeFontSizeDraft,
  onCommitCodeFontSize,
  onResetAllFontSizes = async () => {},
  onTestNotificationSound,
  onTestSystemNotification,
}: SettingsDisplaySectionProps) {
  const { t } = useI18n();
  const showCodexUsage = appSettings.showCodexUsage !== false;
  const languageOptions = [
    { value: "system", label: t("language.auto") },
    { value: "zh", label: t("language.zh") },
    { value: "en", label: t("language.en") },
  ] satisfies Array<{ value: AppSettings["appLanguage"]; label: string }>;
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void listSystemFonts()
      .then((fonts) => {
        if (active) {
          setSystemFonts(fonts);
        }
      })
      .catch(() => {
        if (active) {
          setSystemFonts([]);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const uiLatinFontOptions = [
    ...UI_LATIN_FONT_FAMILY_PRESETS,
    ...systemFonts.map((font) => ({
      label: font,
      value: `"${font}", "Segoe UI", system-ui, sans-serif`,
    })),
  ].filter(
    (option, index, options) =>
      options.findIndex((candidate) => candidate.value === option.value) === index,
  );
  const uiCjkFontOptions = [
    ...UI_CJK_FONT_FAMILY_PRESETS,
    ...systemFonts.map((font) => ({
      label: font,
      value: `"${font}", "Microsoft YaHei UI", sans-serif`,
    })),
  ].filter(
    (option, index, options) =>
      options.findIndex((candidate) => candidate.value === option.value) === index,
  );
  const codeFontOptions = [
    ...CODE_FONT_FAMILY_PRESETS,
    ...systemFonts.map((font) => ({
      label: font,
      value: `"${font}", "Cascadia Mono", monospace`,
    })),
  ].filter(
    (option, index, options) =>
      options.findIndex((candidate) => candidate.value === option.value) === index,
  );

  const applyFontClarityPreset = (preset: (typeof FONT_CLARITY_PRESETS)[number]) => {
    onSetUiLatinFontDraft(preset.uiLatinFontFamily);
    onSetUiCjkFontDraft(preset.uiCjkFontFamily);
    onSetUiFontWeightDraft(preset.uiFontWeight);
    void onUpdateAppSettings({
      ...appSettings,
      uiLatinFontFamily: preset.uiLatinFontFamily,
      uiCjkFontFamily: preset.uiCjkFontFamily,
      uiFontWeight: preset.uiFontWeight,
    });
  };

  const activeFontClarityPresetId =
    FONT_CLARITY_PRESETS.find(
      (preset) =>
        preset.uiLatinFontFamily === appSettings.uiLatinFontFamily &&
        preset.uiCjkFontFamily === appSettings.uiCjkFontFamily &&
        preset.uiFontWeight === appSettings.uiFontWeight,
    )?.id ?? null;
  return (
    <SettingsSection
      title={t("settings.display.title")}
      subtitle={t("settings.display.subtitle")}
    >
      <div className="settings-subsection-title">
        {t("settings.display.sectionTitle")}
      </div>
      <div className="settings-subsection-subtitle">
        {t("settings.display.sectionSubtitle")}
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="language-select">
          {t("settings.display.language")}
        </label>
        <RoundedSelect
          ariaLabel={t("settings.display.language")}
          className="settings-select"
          value={appSettings.appLanguage}
          options={languageOptions}
          onChange={(nextValue) =>
            void onUpdateAppSettings({
              ...appSettings,
              appLanguage: nextValue as AppSettings["appLanguage"],
            })
          }
        />
        <div className="settings-help">
          {t("settings.display.languageHelp")}
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="theme-select">
          {t("settings.display.theme")}
        </label>
        <select
          id="theme-select"
          className="settings-select"
          value={appSettings.theme}
          onChange={(event) =>
            void onUpdateAppSettings({
              ...appSettings,
              theme: event.target.value as AppSettings["theme"],
            })
          }
        >
          <option value="light">{t("settings.display.themeLight")}</option>
          <option value="dark">{t("settings.display.themeDark")}</option>
        </select>
      </div>
      <SettingsToggleRow
        title={t("settings.display.showCodexUsageTitle")}
        subtitle={t("settings.display.showCodexUsageSubtitle")}
      >
        <SettingsToggleSwitch
          aria-label={t("settings.display.showCodexUsageTitle")}
          pressed={showCodexUsage}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              showCodexUsage: !showCodexUsage,
            })
          }
        />
      </SettingsToggleRow>
      <SettingsToggleRow
        title={t("settings.display.showRemainingTitle")}
        subtitle={t("settings.display.showRemainingSubtitle")}
      >
        <SettingsToggleSwitch
          aria-label={t("settings.display.showRemainingTitle")}
          pressed={appSettings.usageShowRemaining}
          disabled={!showCodexUsage}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              usageShowRemaining: !appSettings.usageShowRemaining,
            })
          }
        />
      </SettingsToggleRow>
      <SettingsToggleRow
        title={t("settings.display.showFilePathTitle")}
        subtitle={t("settings.display.showFilePathSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.showMessageFilePath}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              showMessageFilePath: !appSettings.showMessageFilePath,
            })
          }
        />
      </SettingsToggleRow>
      <SettingsToggleRow
        title={t("settings.display.collapseToolsTitle")}
        subtitle={t("settings.display.collapseToolsSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.messageToolGroupsCollapsedByDefault}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              messageToolGroupsCollapsedByDefault:
                !appSettings.messageToolGroupsCollapsedByDefault,
            })
          }
        />
      </SettingsToggleRow>
      <SettingsToggleRow
        title={t("settings.display.splitDiffTitle")}
        subtitle={t("settings.display.splitDiffSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.splitChatDiffView}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              splitChatDiffView: !appSettings.splitChatDiffView,
            })
          }
        />
      </SettingsToggleRow>
      <SettingsToggleRow
        title={t("settings.display.reduceTransparencyTitle")}
        subtitle={t("settings.display.reduceTransparencySubtitle")}
      >
        <SettingsToggleSwitch
          pressed={reduceTransparency}
          onClick={() => onToggleTransparency(!reduceTransparency)}
        />
      </SettingsToggleRow>
      <div className="settings-toggle-row settings-scale-row">
        <div>
          <div className="settings-toggle-title">{t("settings.display.uiScale")}</div>
          <div className="settings-toggle-subtitle" title={scaleShortcutTitle}>
            {scaleShortcutText}
          </div>
        </div>
        <div className="settings-scale-controls">
          <input
            id="ui-scale"
            type="text"
            inputMode="decimal"
            className="settings-input settings-input--scale"
            value={scaleDraft}
            aria-label={t("settings.display.uiScale")}
            onChange={(event) => onSetScaleDraft(event.target.value)}
            onBlur={() => {
              void onCommitScale();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onCommitScale();
              }
            }}
          />
          <button
            type="button"
            className="ghost settings-scale-reset"
            onClick={() => {
              void onResetScale();
            }}
          >
            {t("common.reset")}
          </button>
        </div>
      </div>
      <div className="settings-field">
        <div className="settings-field-label">{t("settings.display.fontClarity")}</div>
        <div className="settings-clarity-options" role="radiogroup" aria-label={t("settings.display.fontClarity")}>
          {FONT_CLARITY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`settings-clarity-option${
                activeFontClarityPresetId === preset.id ? " is-selected" : ""
              }`}
              role="radio"
              aria-checked={activeFontClarityPresetId === preset.id}
              onClick={() => applyFontClarityPreset(preset)}
            >
              <span className="settings-clarity-title">
                {t(`settings.display.fontClarity.${preset.id}.title` as any)}
              </span>
              <span className="settings-clarity-subtitle">
                {t(`settings.display.fontClarity.${preset.id}.subtitle` as any)}
              </span>
            </button>
          ))}
        </div>
        <div className="settings-help">
          {t("settings.display.fontClarityHelp")}
        </div>
      </div>
      <div className="settings-field">
        <div className="settings-field-label">
          {t("settings.display.uiLatinFont")}
        </div>
        <RoundedSelect
          ariaLabel={t("settings.display.uiLatinFont")}
          className="settings-select settings-font-select"
          popoverClassName="settings-font-select-popover"
          value={
            uiLatinFontOptions.some((preset) => preset.value === uiLatinFontDraft)
              ? uiLatinFontDraft
              : "custom"
          }
          options={[...uiLatinFontOptions, { label: t("common.custom"), value: "custom" }]}
          onChange={(nextValue) => {
            if (nextValue === "custom") {
              return;
            }
            onSetUiLatinFontDraft(nextValue);
            void onUpdateAppSettings({
              ...appSettings,
              uiLatinFontFamily: nextValue,
            });
          }}
        />
        <div className="settings-field-row">
          <input
            type="text"
            className="settings-input"
            aria-label={t("settings.display.customUiLatinFont")}
            value={uiLatinFontDraft}
            onChange={(event) => onSetUiLatinFontDraft(event.target.value)}
            onBlur={() => {
              void onCommitUiLatinFont();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onCommitUiLatinFont();
              }
            }}
          />
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              onSetUiLatinFontDraft(DEFAULT_UI_LATIN_FONT_FAMILY);
              void onUpdateAppSettings({
                ...appSettings,
                uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
              });
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">
          {t("settings.display.uiLatinFontHelp")}
        </div>
      </div>
      <div className="settings-field">
        <div className="settings-field-label">
          {t("settings.display.uiCjkFont")}
        </div>
        <RoundedSelect
          ariaLabel={t("settings.display.uiCjkFont")}
          className="settings-select settings-font-select"
          popoverClassName="settings-font-select-popover"
          value={
            uiCjkFontOptions.some((preset) => preset.value === uiCjkFontDraft)
              ? uiCjkFontDraft
              : "custom"
          }
          options={[...uiCjkFontOptions, { label: t("common.custom"), value: "custom" }]}
          onChange={(nextValue) => {
            if (nextValue === "custom") {
              return;
            }
            onSetUiCjkFontDraft(nextValue);
            void onUpdateAppSettings({
              ...appSettings,
              uiCjkFontFamily: nextValue,
            });
          }}
        />
        <div className="settings-field-row">
          <input
            type="text"
            className="settings-input"
            aria-label={t("settings.display.customUiCjkFont")}
            value={uiCjkFontDraft}
            onChange={(event) => onSetUiCjkFontDraft(event.target.value)}
            onBlur={() => {
              void onCommitUiCjkFont();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onCommitUiCjkFont();
              }
            }}
          />
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              onSetUiCjkFontDraft(DEFAULT_UI_CJK_FONT_FAMILY);
              void onUpdateAppSettings({
                ...appSettings,
                uiCjkFontFamily: DEFAULT_UI_CJK_FONT_FAMILY,
              });
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">
          {t("settings.display.uiCjkFontHelp")}
        </div>
      </div>
      <div className="settings-field">
        <div className="settings-field-row settings-field-row-between">
          <div>
            <div className="settings-field-label">
              {t("settings.display.fontSizeCategories")}
            </div>
            <div className="settings-help">
              {t("settings.display.fontSizeCategoriesHelp")}
            </div>
          </div>
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => void onResetAllFontSizes()}
          >
            {t("settings.display.resetAllFontSizes")}
          </button>
        </div>
      </div>
      <div className="settings-font-size-grid">
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="ui-font-size">
          {t("settings.display.uiFontSize")}
        </label>
        <div className="settings-field-row">
          <input
            id="ui-font-size"
            type="range"
            min={UI_FONT_SIZE_MIN}
            max={UI_FONT_SIZE_MAX}
            step={1}
            className="settings-input settings-input--range"
            value={uiFontSizeDraft}
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onSetUiFontSizeDraft(nextValue);
              void onCommitUiFontSize(nextValue);
            }}
          />
          <div className="settings-scale-value">{uiFontSizeDraft}px</div>
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              onSetUiFontSizeDraft(UI_FONT_SIZE_DEFAULT);
              void onCommitUiFontSize(UI_FONT_SIZE_DEFAULT);
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">{t("settings.display.uiFontSizeHelp")}</div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="message-font-size">
          {t("settings.display.messageFontSize")}
        </label>
        <div className="settings-field-row">
          <input
            id="message-font-size"
            type="range"
            min={MESSAGE_FONT_SIZE_MIN}
            max={MESSAGE_FONT_SIZE_MAX}
            step={1}
            className="settings-input settings-input--range"
            value={messageFontSizeDraft}
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onSetMessageFontSizeDraft(nextValue);
              void onCommitMessageFontSize(nextValue);
            }}
          />
          <div className="settings-scale-value">{messageFontSizeDraft}px</div>
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              onSetMessageFontSizeDraft(MESSAGE_FONT_SIZE_DEFAULT);
              void onCommitMessageFontSize(MESSAGE_FONT_SIZE_DEFAULT);
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">
          {t("settings.display.messageFontSizeHelp")}
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="process-font-size">
          {t("settings.display.processFontSize")}
        </label>
        <div className="settings-field-row">
          <input
            id="process-font-size"
            type="range"
            min={PROCESS_FONT_SIZE_MIN}
            max={PROCESS_FONT_SIZE_MAX}
            step={1}
            className="settings-input settings-input--range"
            value={processFontSizeDraft}
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onSetProcessFontSizeDraft(nextValue);
              void onCommitProcessFontSize(nextValue);
            }}
          />
          <div className="settings-scale-value">{processFontSizeDraft}px</div>
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              onSetProcessFontSizeDraft(PROCESS_FONT_SIZE_DEFAULT);
              void onCommitProcessFontSize(PROCESS_FONT_SIZE_DEFAULT);
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">
          {t("settings.display.processFontSizeHelp")}
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="code-font-size">
          {t("settings.display.codeFontSize")}
        </label>
        <div className="settings-field-row">
          <input
            id="code-font-size"
            type="range"
            min={CODE_FONT_SIZE_MIN}
            max={CODE_FONT_SIZE_MAX}
            step={1}
            className="settings-input settings-input--range"
            value={codeFontSizeDraft}
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onSetCodeFontSizeDraft(nextValue);
              void onCommitCodeFontSize(nextValue);
            }}
          />
          <div className="settings-scale-value">{codeFontSizeDraft}px</div>
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              onSetCodeFontSizeDraft(CODE_FONT_SIZE_DEFAULT);
              void onCommitCodeFontSize(CODE_FONT_SIZE_DEFAULT);
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">{t("settings.display.codeFontSizeHelp")}</div>
      </div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="ui-font-weight">
          {t("settings.display.uiFontWeight")}
        </label>
        <div className="settings-field-row">
          <input
            id="ui-font-weight"
            type="range"
            min={UI_FONT_WEIGHT_MIN}
            max={UI_FONT_WEIGHT_MAX}
            step={50}
            className="settings-input settings-input--range"
            value={uiFontWeightDraft}
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onSetUiFontWeightDraft(nextValue);
              void onCommitUiFontWeight(nextValue);
            }}
          />
          <div className="settings-scale-value">{uiFontWeightDraft}</div>
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              onSetUiFontWeightDraft(UI_FONT_WEIGHT_DEFAULT);
              void onCommitUiFontWeight(UI_FONT_WEIGHT_DEFAULT);
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">{t("settings.display.uiFontWeightHelp")}</div>
      </div>
      <div className="settings-field">
        <div className="settings-field-label">
          {t("settings.display.codeFont")}
        </div>
        <RoundedSelect
          ariaLabel={t("settings.display.codeFont")}
          className="settings-select settings-font-select"
          popoverClassName="settings-font-select-popover"
          value={
            codeFontOptions.some((preset) => preset.value === codeFontDraft)
              ? codeFontDraft
              : "custom"
          }
          options={[...codeFontOptions, { label: t("common.custom"), value: "custom" }]}
          onChange={(nextValue) => {
            if (nextValue === "custom") {
              return;
            }
            onSetCodeFontDraft(nextValue);
            void onUpdateAppSettings({
              ...appSettings,
              codeFontFamily: nextValue,
            });
          }}
        />
        <div className="settings-field-row">
          <input
            type="text"
            className="settings-input"
            aria-label={t("settings.display.customCodeFont")}
            value={codeFontDraft}
            onChange={(event) => onSetCodeFontDraft(event.target.value)}
            onBlur={() => {
              void onCommitCodeFont();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onCommitCodeFont();
              }
            }}
          />
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              onSetCodeFontDraft(DEFAULT_CODE_FONT_FAMILY);
              void onUpdateAppSettings({
                ...appSettings,
                codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
              });
            }}
          >
            {t("common.reset")}
          </button>
        </div>
        <div className="settings-help">{t("settings.display.codeFontHelp")}</div>
      </div>
      <div className="settings-subsection-title">{t("settings.display.sound")}</div>
      <div className="settings-subsection-subtitle">{t("settings.display.soundSubtitle")}</div>
      <SettingsToggleRow
        title={t("settings.display.notificationSoundsTitle")}
        subtitle={t("settings.display.notificationSoundsSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.notificationSoundsEnabled}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              notificationSoundsEnabled: !appSettings.notificationSoundsEnabled,
            })
          }
        />
      </SettingsToggleRow>
      <SettingsToggleRow
        title={t("settings.display.systemNotificationsTitle")}
        subtitle={t("settings.display.systemNotificationsSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.systemNotificationsEnabled}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              systemNotificationsEnabled: !appSettings.systemNotificationsEnabled,
            })
          }
        />
      </SettingsToggleRow>
      <SettingsToggleRow
        title={t("settings.display.subagentNotificationsTitle")}
        subtitle={t("settings.display.subagentNotificationsSubtitle")}
      >
        <SettingsToggleSwitch
          pressed={appSettings.subagentSystemNotificationsEnabled}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              subagentSystemNotificationsEnabled:
                !appSettings.subagentSystemNotificationsEnabled,
            })
          }
        />
      </SettingsToggleRow>
      <div className="settings-sound-actions">
        <button
          type="button"
          className="ghost settings-button-compact"
        onClick={onTestNotificationSound}
        >
          {t("settings.display.testSound")}
        </button>
        <button
          type="button"
          className="ghost settings-button-compact"
          onClick={onTestSystemNotification}
        >
          {t("settings.display.testNotification")}
        </button>
      </div>
    </SettingsSection>
  );
}
