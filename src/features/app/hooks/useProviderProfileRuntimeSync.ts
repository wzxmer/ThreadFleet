import { useEffect, useRef } from "react";
import type {
  AppSettings,
  CodexKeyProfile,
  CodexProvider,
  CredentialSelection,
  WorkspaceInfo,
} from "@/types";
import {
  credentialForSelection,
  providersFromSettings,
  providersToLegacyProfiles,
} from "@/utils/providerCredentials";

export type ProviderRuntimeSettingsSnapshot = {
  activeCodexKeyProfileId: string | null;
  executionCredentialSelection: CredentialSelection | null;
  codexProviders: CodexProvider[];
  syncProviderProfileToLocalConfig: boolean;
};

function restoreExecutionProvider(
  currentProviders: CodexProvider[],
  snapshot: ProviderRuntimeSettingsSnapshot,
): CodexProvider[] {
  const selection = snapshot.executionCredentialSelection;
  const snapshotCredential = credentialForSelection(
    snapshot.codexProviders,
    selection,
  );
  if (!selection || !snapshotCredential) {
    return currentProviders;
  }

  const snapshotProvider = snapshotCredential.provider;
  const snapshotGroup = snapshotProvider.groups.find(
    (group) => group.id === selection.groupId,
  );
  const currentProviderIndex = currentProviders.findIndex(
    (provider) => provider.id === selection.providerId,
  );
  if (currentProviderIndex < 0 || !snapshotGroup) {
    return [...currentProviders, snapshotProvider];
  }

  const currentProvider = currentProviders[currentProviderIndex];
  const currentGroupIndex = currentProvider.groups.findIndex(
    (group) => group.id === selection.groupId,
  );
  const groups = [...currentProvider.groups];
  if (currentGroupIndex < 0) {
    groups.push({
      ...snapshotGroup,
      credentials: [snapshotCredential.credential],
    });
  } else {
    const currentGroup = groups[currentGroupIndex];
    const credentialIndex = currentGroup.credentials.findIndex(
      (credential) => credential.id === selection.credentialId,
    );
    const credentials = [...currentGroup.credentials];
    if (credentialIndex < 0) {
      credentials.push(snapshotCredential.credential);
    } else {
      credentials[credentialIndex] = snapshotCredential.credential;
    }
    groups[currentGroupIndex] = {
      ...currentGroup,
      name: snapshotGroup.name,
      credentials,
    };
  }

  const nextProviders = [...currentProviders];
  nextProviders[currentProviderIndex] = {
    ...snapshotProvider,
    groups,
  };
  return nextProviders;
}

export function restoreProviderRuntimeSettings(
  current: AppSettings,
  snapshot: ProviderRuntimeSettingsSnapshot,
): AppSettings {
  const currentProviders = providersFromSettings(current);
  const providers = restoreExecutionProvider(currentProviders, snapshot);
  const hasExecutionProvider = Boolean(
    credentialForSelection(snapshot.codexProviders, snapshot.executionCredentialSelection),
  );
  return {
    ...current,
    ...(hasExecutionProvider
      ? {
          codexProviders: providers,
          codexKeyProfiles: providersToLegacyProfiles(providers),
        }
      : {}),
    activeCodexKeyProfileId: snapshot.activeCodexKeyProfileId,
    executionCredentialSelection: snapshot.executionCredentialSelection,
    syncProviderProfileToLocalConfig: snapshot.syncProviderProfileToLocalConfig,
  };
}

type UseProviderProfileRuntimeSyncArgs = {
  activeProfile: CodexKeyProfile | null;
  activeWorkspace: WorkspaceInfo | null;
  activeThreadId: string | null;
  settingsLoading: boolean;
  defer: boolean;
  syncLocalConfig: boolean;
  settingsSnapshot: ProviderRuntimeSettingsSnapshot;
  syncWorkspaceRuntime: (
    workspaceId: string,
    threadId: string | null,
  ) => Promise<void>;
  rollbackSettings: (
    settings: ProviderRuntimeSettingsSnapshot,
  ) => Promise<unknown>;
  onError?: (error: unknown) => void;
};

export function useProviderProfileRuntimeSync({
  activeProfile,
  activeWorkspace,
  activeThreadId,
  settingsLoading,
  defer,
  syncLocalConfig,
  settingsSnapshot,
  syncWorkspaceRuntime,
  rollbackSettings,
  onError,
}: UseProviderProfileRuntimeSyncArgs) {
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const settingsSnapshotRef = useRef(settingsSnapshot);
  settingsSnapshotRef.current = settingsSnapshot;
  const lastSuccessfulSettingsRef = useRef(settingsSnapshot);
  const latestRequestIdRef = useRef(0);
  const activeProfileRuntimeKey = activeProfile
    ? JSON.stringify({
        id: activeProfile.id,
        providerKind: activeProfile.providerKind,
        keyEnvVar: activeProfile.keyEnvVar,
        key: activeProfile.key,
        baseUrlEnvVar: activeProfile.baseUrlEnvVar,
        baseUrl: activeProfile.baseUrl,
        model: activeProfile.model,
        contextWindow: activeProfile.contextWindow,
        maxOutputTokens: activeProfile.maxOutputTokens,
        useGateway: activeProfile.useGateway,
        supportsThinking: activeProfile.supportsThinking,
        supportsReasoningEffort: activeProfile.supportsReasoningEffort,
      })
    : "__codex_default__";
  const transactionKey = `${activeProfileRuntimeKey}:${syncLocalConfig}`;
  const desiredTransactionRef = useRef({ key: transactionKey, revision: 0 });
  if (desiredTransactionRef.current.key !== transactionKey) {
    desiredTransactionRef.current = {
      key: transactionKey,
      revision: desiredTransactionRef.current.revision + 1,
    };
  }

  useEffect(() => {
    if (settingsLoading || defer || !activeWorkspace?.connected) {
      return;
    }
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    const desiredRevision = desiredTransactionRef.current.revision;
    const requestedSettings = settingsSnapshotRef.current;
    void syncWorkspaceRuntime(activeWorkspace.id, activeThreadIdRef.current)
      .then(() => {
        lastSuccessfulSettingsRef.current = requestedSettings;
      })
      .catch(async (error) => {
        if (
          latestRequestIdRef.current !== requestId ||
          desiredTransactionRef.current.revision !== desiredRevision
        ) {
          return;
        }
        try {
          await rollbackSettings(lastSuccessfulSettingsRef.current);
          onError?.(error);
        } catch (rollbackError) {
          const switchMessage =
            error instanceof Error ? error.message : String(error);
          const message =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          onError?.(
            new Error(
              `Provider runtime switch failed: ${switchMessage}; settings rollback failed: ${message}`,
            ),
          );
        }
      });
  }, [
    activeWorkspace?.connected,
    activeWorkspace?.id,
    defer,
    onError,
    rollbackSettings,
    settingsLoading,
    syncWorkspaceRuntime,
    transactionKey,
  ]);
}
