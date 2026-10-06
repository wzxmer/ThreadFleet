import type { I18nKey } from "@/features/i18n/strings";

type Translate = (key: I18nKey) => string;

export function formatUpdateError(error: string, t: Translate): string {
  const localizedErrors: I18nKey[] = [
    "codexUpdate.settingsChanged",
    "codexUpdate.managedUnavailable",
    "settings.codex.codexCliUpdateFailed",
    "settings.codex.codexCliUpdateUnsupported",
  ];
  if (localizedErrors.some((key) => error === t(key))) return error;
  if (/no compatible installer|no complete package|unsupported.*platform/i.test(error)) {
    return t("update.errorNoInstaller");
  }
  if (/sha-?256|digest|checksum|size mismatch|version mismatch|integrity/i.test(error)) {
    return t("update.errorIntegrity");
  }
  if (/extract|archive|unsafe path|package entry/i.test(error)) {
    return t("update.errorExtract");
  }
  if (/download.*fail|fail.*download/i.test(error)) {
    return t("update.errorDownload");
  }
  if (/permission|access.*denied|os error 5/i.test(error)) {
    return t("update.errorPermission");
  }
  if (/network|fetch|connect|proxy|timed?\s*out|timeout|dns|http|release.*fail|fail.*release/i.test(error)) {
    return t("update.errorNetwork");
  }
  return t("update.errorUnknown");
}

export function formatCodexUpdateMethod(method: string, t: Translate): string {
  if (method === "managed") return t("codexUpdate.methodManaged");
  if (method === "codex") return t("codexUpdate.methodCodex");
  if (method === "npm") return "npm";
  if (method === "brew_formula" || method === "brew_cask") return "Homebrew";
  return t("common.unknown");
}
