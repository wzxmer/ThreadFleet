import { useEffect } from "react";
import type { ThemePreference } from "../../../types";

export function useThemePreference(theme: ThemePreference) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return theme;
}
