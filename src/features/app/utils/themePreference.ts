import type { ThemePreference } from "@/types";

export function resolveNextThemePreference(theme: ThemePreference): ThemePreference {
  return theme === "dark" ? "light" : "dark";
}
