import { useEffect } from "react";
import type { AppSettings } from "../../../types";
import { resolveAppLanguage } from "@/features/i18n/appLanguage";
import { composeContentFontFamily, composeUiFontFamily } from "@utils/fonts";

export function useCodeCssVars(appSettings: AppSettings) {
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const root = document.documentElement;
    const uiFontFamily = composeUiFontFamily(
      appSettings.uiLatinFontFamily,
      appSettings.uiCjkFontFamily,
      appSettings.uiFontFamily,
    );
    const codeFontFamily = composeContentFontFamily(
      appSettings.codeFontFamily,
      appSettings.uiCjkFontFamily,
      appSettings.uiFontFamily,
    );
    root.style.setProperty(
      "--ui-font-family",
      uiFontFamily,
    );
    root.style.setProperty("--ui-font-size", `${appSettings.uiFontSize}px`);
    root.style.setProperty("--ui-font-weight", `${appSettings.uiFontWeight}`);
    root.style.setProperty("--code-font-family", codeFontFamily);
    root.style.setProperty(
      "--message-font-size",
      `${appSettings.messageFontSize}px`,
    );
    root.style.setProperty(
      "--process-font-size",
      `${appSettings.processFontSize}px`,
    );
    root.style.setProperty("--message-font-family", uiFontFamily);
    root.style.setProperty(
      "--message-font-weight",
      `${appSettings.uiFontWeight}`,
    );
    root.style.setProperty("--code-font-size", `${appSettings.codeFontSize}px`);
    const resolvedLanguage = resolveAppLanguage(appSettings.appLanguage);
    root.dataset.appLanguage = resolvedLanguage;
    root.lang = resolvedLanguage === "zh" ? "zh-CN" : "en";
  }, [
    appSettings.appLanguage,
    appSettings.codeFontFamily,
    appSettings.codeFontSize,
    appSettings.messageFontSize,
    appSettings.processFontSize,
    appSettings.uiCjkFontFamily,
    appSettings.uiFontFamily,
    appSettings.uiFontSize,
    appSettings.uiFontWeight,
    appSettings.uiLatinFontFamily,
  ]);
}

