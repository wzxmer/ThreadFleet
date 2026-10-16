import { useEffect, useState } from "react";
import type { WindowsControlProvider } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import { useWindowsControlMcp } from "@settings/hooks/useWindowsControlMcp";

type Props = {
  sourceKey?: string | null;
  configEditorBusy: boolean;
  onProvider: (provider: WindowsControlProvider) => void;
  onSaved: () => void;
};

export function SettingsWindowsControlMcp({ sourceKey, configEditorBusy, onProvider, onSaved }: Props) {
  const { t } = useI18n();
  const mcp = useWindowsControlMcp(sourceKey);
  const [invalidArgs, setInvalidArgs] = useState(false);
  useEffect(() => {
    if (mcp.config) onProvider(mcp.config.provider);
  }, [mcp.config, onProvider]);
  const disabled = mcp.busy || !mcp.config?.supported || configEditorBusy;

  return (
    <div className="settings-field">
      <label className="settings-field-label" htmlFor="windows-control-provider">
        {t("settings.codex.windowsControlProvider")}
      </label>
      <div className="settings-help">{t("settings.codex.windowsControlProviderHelp")}</div>
      <select id="windows-control-provider" className="settings-select" value={mcp.provider}
        disabled={disabled} onChange={(e) => { mcp.select(e.target.value as WindowsControlProvider); setInvalidArgs(false); }}>
        <option value="sbroenne">{t("settings.codex.windowsControlSbroenne")}</option>
        <option value="cursortouch">{t("settings.codex.windowsControlCursorTouch")}</option>
        <option value="custom">{t("settings.codex.windowsControlCustom")}</option>
      </select>
      <label className="settings-field-label" htmlFor="windows-control-command">{t("settings.codex.windowsControlCommand")}</label>
      <input id="windows-control-command" className="settings-input" value={mcp.command} disabled={disabled}
        onChange={(e) => mcp.setCommand(e.target.value)} />
      <label className="settings-field-label" htmlFor="windows-control-args">{t("settings.codex.windowsControlArgs")}</label>
      <input id="windows-control-args" className="settings-input" value={mcp.args} disabled={disabled}
        onChange={(e) => { mcp.setArgs(e.target.value); setInvalidArgs(false); }} />
      <div className="settings-field-actions">
        <button className="primary settings-button-compact" type="button" disabled={disabled || !mcp.command.trim()}
          onClick={() => void mcp.save().then((result) => {
            setInvalidArgs(result === "invalidArgs");
            if (result === true) onSaved();
          })}>{t("settings.codex.windowsControlApply")}</button>
        <button className="ghost settings-button-compact" type="button" disabled={mcp.busy || configEditorBusy}
          onClick={() => void mcp.refresh()}>{t("common.refresh")}</button>
      </div>
      {configEditorBusy && <div className="settings-help">{t("settings.codex.windowsControlEditorBusy")}</div>}
      {mcp.config?.supported === false && <div className="settings-help">{t("settings.codex.windowsControlUnsupported")}</div>}
      {invalidArgs && <div className="settings-help settings-help-error" role="alert">{t("settings.codex.windowsControlInvalidArgs")}</div>}
      {mcp.error && <div className="settings-help settings-help-error" role="alert">{t("settings.codex.windowsControlFailed")}: {mcp.error}</div>}
      {mcp.saved && <div className="settings-help" role="status">{t("settings.codex.windowsControlSaved")}</div>}
      {mcp.config && !mcp.config.enabled && <div className="settings-help">{t("settings.codex.windowsControlDisabled")}</div>}
    </div>
  );
}
