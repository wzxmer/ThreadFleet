import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { AppSettings, InstalledManagedCodex } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";

export function useManagedCodexActivation(
  appSettings: AppSettings,
  queueSaveSettings: (next: AppSettings) => Promise<unknown>,
  setAppSettings: Dispatch<SetStateAction<AppSettings>>,
) {
  const { t } = useI18n();
  const settingsRef = useRef(appSettings);
  settingsRef.current = appSettings;
  return useCallback(async (installed: InstalledManagedCodex, previousCodexBin: string | null) => {
    const current = settingsRef.current;
    if (current.backendMode !== "local" || current.codexBin !== previousCodexBin) {
      throw new Error(t("codexUpdate.settingsChanged"));
    }
    await queueSaveSettings({ ...current, codexBin: installed.path });
    setAppSettings((settings) => ({ ...settings, codexBin: installed.path }));
  }, [queueSaveSettings, setAppSettings, t]);
}
