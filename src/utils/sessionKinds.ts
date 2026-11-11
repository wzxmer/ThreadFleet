import type { ManagedSession } from "@/types";

export const CODEX_METADATA_SESSION_SOURCE_KIND = "codexMonitorMetadata";

export function isMetadataSession(session: Pick<ManagedSession, "sourceKind">) {
  return session.sourceKind === CODEX_METADATA_SESSION_SOURCE_KIND;
}
