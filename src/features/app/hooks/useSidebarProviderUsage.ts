import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  CodexKeyProfile,
  CodexProviderStatus,
} from "@/types";
import type { ThirdPartyKeyUsageSnapshot } from "@app/utils/thirdPartyKeyUsage";
import { getProviderStatus } from "@/services/tauri";
import { resolveCodexProviderBaseUrl } from "@/utils/providerProfiles";
import {
  credentialForSelection,
  credentialSelectionId,
  effectiveUsageCredentialSelection,
} from "@/utils/providerCredentials";
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
  hasThirdPartyUsageSource: boolean;
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
  const activeExecutionProfileId = appSettings.executionCredentialSelection
    ? credentialSelectionId(appSettings.executionCredentialSelection)
    : appSettings.activeCodexKeyProfileId;
  const activeProfile = useMemo(
    () =>
      appSettings.codexKeyProfiles.find(
        (profile) => profile.id === activeExecutionProfileId,
      ) ?? null,
    [activeExecutionProfileId, appSettings.codexKeyProfiles],
  );
  const usageSelection = effectiveUsageCredentialSelection(appSettings);
  const usageCredential = useMemo(
    () => credentialForSelection(appSettings.codexProviders ?? [], usageSelection),
    [appSettings.codexProviders, usageSelection],
  );
  const usageProvider = usageCredential?.provider ?? null;
  const usageProfile = useMemo(
    () =>
      usageCredential
        ? null
        : appSettings.codexKeyProfiles.find(
            (profile) =>
              profile.id ===
              (usageSelection
                ? credentialSelectionId(usageSelection)
                : activeExecutionProfileId),
          ) ?? activeProfile,
    [
      activeExecutionProfileId,
      activeProfile,
      appSettings.codexKeyProfiles,
      usageCredential,
      usageSelection,
    ],
  );
  const usageProfileSignature = useMemo(
    () =>
      usageCredential
        ? JSON.stringify({
            providerId: usageCredential.provider.id,
            providerKind: usageCredential.provider.providerKind ?? null,
            baseUrl: usageCredential.provider.baseUrl ?? null,
            usageProtocol: usageCredential.provider.usageProtocol ?? null,
            groupId: usageCredential.groupId,
            credentialId: usageCredential.credential.id,
            key: usageCredential.credential.key,
            newApiAccessToken: usageCredential.credential.newApiAccessToken ?? null,
          })
        : profileUsageSignature(usageProfile),
    [usageCredential, usageProfile],
  );
  const activeProfileSignature = useMemo(
    () => profileUsageSignature(activeProfile),
    [activeProfile],
  );
  const requestKey = workspaceId
    ? JSON.stringify([
        workspaceId,
        appSettings.codexHome ?? "",
        activeExecutionProfileId ?? "__default__",
        activeProfileSignature,
        resolveCodexProviderBaseUrl(activeProfile?.providerKind, activeProfile?.baseUrl) ?? "",
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
      (usageProvider
        ? usageProvider.providerKind !== "openai"
        : usageProfile
          ? usageProfile.providerKind !== "openai"
          : codexProviderStatus?.isConfigured === true && codexProviderStatus.isThirdParty),
    workspaceId,
    profileId: usageSelection
      ? credentialSelectionId(usageSelection)
      : activeExecutionProfileId,
    profileRevision: usageProfileSignature,
  });

  return {
    workspaceId,
    codexProviderStatus,
    thirdPartyProviderUsage,
    hasThirdPartyUsageSource: Boolean(
      usageProvider
        ? usageProvider.providerKind !== "openai"
        : usageProfile
          ? usageProfile.providerKind !== "openai"
          : codexProviderStatus?.isConfigured === true && codexProviderStatus.isThirdParty,
    ),
  };
}
