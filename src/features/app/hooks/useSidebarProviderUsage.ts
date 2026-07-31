import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  CodexKeyProfile,
  CodexProviderStatus,
} from "@/types";
import type { ThirdPartyKeyUsageSnapshot } from "@app/utils/thirdPartyKeyUsage";
import { getProviderStatus } from "@/services/tauri";
import { resolveCodexProviderBaseUrl } from "@/utils/providerProfiles";
import { useThirdPartyKeyUsage } from "@app/hooks/useThirdPartyKeyUsage";

type UseSidebarProviderUsageArgs = {
  appSettings: AppSettings;
  activeWorkspaceId: string | null;
  homeAccountWorkspaceId: string | null;
  statusDelayMs?: number;
};

type ProviderStatusState = {
  requestKey: string;
  status: CodexProviderStatus;
};

type SidebarProviderUsage = {
  workspaceId: string | null;
  codexProviderStatus: CodexProviderStatus | null;
  thirdPartyProviderUsage: ThirdPartyKeyUsageSnapshot | null;
};

function profileUsageSignature(profile: CodexKeyProfile | null) {
  if (!profile) {
    return "__default__";
  }
  return JSON.stringify({
    id: profile.id,
    providerKind: profile.providerKind ?? null,
    baseUrl: profile.baseUrl ?? null,
    baseUrlEnvVar: profile.baseUrlEnvVar ?? null,
    key: profile.key ?? null,
    keyEnvVar: profile.keyEnvVar ?? null,
  });
}

export function useSidebarProviderUsage({
  appSettings,
  activeWorkspaceId,
  homeAccountWorkspaceId,
  statusDelayMs = 0,
}: UseSidebarProviderUsageArgs): SidebarProviderUsage {
  const workspaceId = activeWorkspaceId ?? homeAccountWorkspaceId;
  const activeProfile = useMemo(
    () =>
      appSettings.codexKeyProfiles.find(
        (profile) => profile.id === appSettings.activeCodexKeyProfileId,
      ) ?? null,
    [appSettings.activeCodexKeyProfileId, appSettings.codexKeyProfiles],
  );
  const activeProfileSignature = useMemo(
    () => profileUsageSignature(activeProfile),
    [activeProfile],
  );
  const activeProfileBaseUrl = activeProfile
    ? resolveCodexProviderBaseUrl(activeProfile.providerKind, activeProfile.baseUrl)
    : null;
  const requestKey = workspaceId
    ? JSON.stringify([
        workspaceId,
        appSettings.codexHome ?? "",
        appSettings.activeCodexKeyProfileId ?? "__default__",
        activeProfileSignature,
        activeProfileBaseUrl ?? "",
      ])
    : null;
  const [statusState, setStatusState] = useState<ProviderStatusState | null>(null);
  const statusCacheRef = useRef(new Map<string, CodexProviderStatus>());

  useEffect(() => {
    if (!workspaceId || !requestKey) {
      setStatusState(null);
      return;
    }
    let canceled = false;
    const cachedStatus = statusCacheRef.current.get(requestKey);
    if (cachedStatus) {
      setStatusState({ requestKey, status: cachedStatus });
    }
    const loadStatus = () => {
      getProviderStatus(workspaceId)
        .then((status) => {
          if (!canceled) {
            statusCacheRef.current.set(requestKey, status);
            setStatusState({ requestKey, status });
          }
        })
        .catch((error) => {
          if (!canceled) {
            const status: CodexProviderStatus = {
              providerName: null,
              baseUrl: null,
              source: "error",
              isConfigured: false,
              isThirdParty: false,
              autoCompactTokenLimit: null,
              modelContextWindow: null,
              error: error instanceof Error ? error.message : String(error),
            };
            statusCacheRef.current.set(requestKey, status);
            setStatusState({ requestKey, status });
          }
        });
    };
    const timeoutId =
      statusDelayMs > 0
        ? window.setTimeout(loadStatus, statusDelayMs)
        : null;
    if (timeoutId === null) {
      loadStatus();
    }
    return () => {
      canceled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [requestKey, statusDelayMs, workspaceId]);

  const codexProviderStatus = requestKey
    ? statusState?.requestKey === requestKey
      ? statusState.status
      : statusCacheRef.current.get(requestKey) ?? null
    : null;
  const thirdPartyProviderUsage = useThirdPartyKeyUsage({
    enabled:
      Boolean(workspaceId) &&
      codexProviderStatus?.isConfigured === true &&
      codexProviderStatus.isThirdParty,
    workspaceId,
    profileId: appSettings.activeCodexKeyProfileId,
    profileRevision: activeProfileSignature,
  });

  return {
    workspaceId,
    codexProviderStatus,
    thirdPartyProviderUsage,
  };
}
