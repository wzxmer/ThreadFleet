import type { ManagedSession, SessionSource, SessionSourceCapabilities } from "@/types";
import type { I18nKey } from "@/features/i18n/strings";

export type SessionSourceCapability = keyof SessionSourceCapabilities;

const LEGACY_LOCAL_CODEX_CAPABILITIES: SessionSourceCapabilities = {
  browse: true,
  preview: true,
  search: true,
  derive: true,
  archive: true,
  delete: true,
  openExternal: false,
  resumeInApp: true,
};

export function getSessionSourceCapabilities(
  source: SessionSource | undefined,
): SessionSourceCapabilities {
  return source?.capabilities ?? LEGACY_LOCAL_CODEX_CAPABILITIES;
}

export function sessionSourceSupports(
  source: SessionSource | undefined,
  capability: SessionSourceCapability,
): boolean {
  return getSessionSourceCapabilities(source)[capability];
}

export function allSessionSourcesSupport(
  sessions: ManagedSession[],
  byId: Map<string, SessionSource>,
  capability: SessionSourceCapability,
): boolean {
  return sessions.every((session) =>
    sessionSourceSupports(byId.get(session.sourceId), capability),
  );
}

export type SessionSourceCapabilityLevel = "full" | "limited" | "unavailable";

export function getSessionSourceCapabilityLevel(
  source: SessionSource | undefined,
): SessionSourceCapabilityLevel {
  const capabilities = getSessionSourceCapabilities(source);
  const full = capabilities.browse
    && capabilities.preview
    && capabilities.search
    && capabilities.derive
    && capabilities.archive
    && capabilities.delete
    && capabilities.resumeInApp;
  if (full) return "full";
  return Object.values(capabilities).some(Boolean) ? "limited" : "unavailable";
}

type Translate = (key: I18nKey) => string;

export function getSessionSourceAdapterLabel(source: SessionSource | undefined, t: Translate) {
  switch (source?.adapterKind ?? "codex") {
    case "claudeCode": return t("sessionManager.sourceAdapterClaudeCode");
    case "geminiCli": return t("sessionManager.sourceAdapterGeminiCli");
    case "openCode": return t("sessionManager.sourceAdapterOpenCode");
    case "unsupported": return t("sessionManager.sourceAdapterUnsupported");
    case "codex": return t("sessionManager.sourceAdapterCodex");
  }
}

export function getSessionSourceHostLabel(source: SessionSource | undefined, t: Translate) {
  const host = source?.host ?? { kind: "local" as const, id: null, platform: undefined };
  const label = host.kind === "wsl"
    ? t("sessionManager.sourceHostWsl")
    : host.kind === "remote"
      ? t("sessionManager.sourceHostRemote")
      : t("sessionManager.sourceHostLocal");
  const platform = host.platform === "windows"
    ? t("sessionManager.sourcePlatformWindows")
    : host.platform === "macos"
      ? t("sessionManager.sourcePlatformMacos")
      : host.platform === "linux"
        ? t("sessionManager.sourcePlatformLinux")
        : host.platform === "unknown"
          ? t("sessionManager.sourcePlatformUnknown")
          : null;
  return [host.id ? `${label}: ${host.id}` : label, platform].filter(Boolean).join(" - ");
}

export function getSessionSourceCapabilityLabel(source: SessionSource | undefined, t: Translate) {
  switch (getSessionSourceCapabilityLevel(source)) {
    case "full": return t("sessionManager.sourceCapabilityFull");
    case "limited": return t("sessionManager.sourceCapabilityLimited");
    case "unavailable": return t("sessionManager.sourceCapabilityUnavailable");
  }
}
