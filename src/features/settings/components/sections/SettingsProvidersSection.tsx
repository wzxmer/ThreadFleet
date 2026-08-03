import { useEffect, useMemo, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import Copy from "lucide-react/dist/esm/icons/copy";
import Eye from "lucide-react/dist/esm/icons/eye";
import EyeOff from "lucide-react/dist/esm/icons/eye-off";
import Plus from "lucide-react/dist/esm/icons/plus";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type {
  AppSettings,
  CodexCredential,
  CodexCredentialGroup,
  CodexFunctionToolCapability,
  CodexProvider,
  CodexProviderTransportMode,
} from "@/types";
import {
  SettingsSection,
  SettingsToggleRow,
  SettingsToggleSwitch,
} from "@/features/design-system/components/settings/SettingsPrimitives";
import { useI18n } from "@/features/i18n/I18nProvider";
import {
  getProviderModels,
  getThirdPartyKeyUsage,
  probeProviderFunctionCalling,
  providerSessionLogin,
} from "@/services/tauri";
import {
  mergeCodexProviderModels,
  PROVIDER_REASONING_EFFORT_VALUES,
  resolveCodexProviderBaseUrl,
} from "@/utils/providerProfiles";
import {
  credentialForSelection,
  createProviderEntityId,
  credentialSelectionId,
  maskCredential,
  providerSelection,
  providersFromSettings,
  providersToLegacyProfiles,
} from "@/utils/providerCredentials";
import type { ProviderSessionDiagnostics } from "@settings/utils/providerSessionDiagnostics";

type SettingsProvidersSectionProps = {
  appSettings: AppSettings;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  providerSessionDiagnostics?: ProviderSessionDiagnostics | null;
};

const DEFAULT_KEY_ENV_VAR = "OPENAI_API_KEY";
const DEFAULT_BASE_URL_ENV_VAR = "OPENAI_BASE_URL";
type UsageProbeState = "idle" | "loading" | "available" | "unavailable";

function cloneProvider(provider: CodexProvider): CodexProvider {
  return {
    ...provider,
    cachedModels: [...(provider.cachedModels ?? [])],
    groups: provider.groups.map((group) => ({
      ...group,
      credentials: group.credentials.map((credential) => ({
        ...credential,
        ...(credential.cachedModels
          ? { cachedModels: [...credential.cachedModels] }
          : {}),
      })),
    })),
  };
}

function moveItem<T>(items: T[], index: number, offset: number): T[] {
  const target = index + offset;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function providerWithSingleCredentialGroups(provider: CodexProvider): CodexProvider {
  return {
    ...provider,
    groups: provider.groups.map((group) => ({
      ...group,
      credentials: group.credentials.slice(0, 1),
    })),
  };
}

function providerTransportMode(provider: CodexProvider): CodexProviderTransportMode {
  if (provider.transportMode) return provider.transportMode;
  return provider.useGateway ? "chat-completions-gateway" : "auto";
}

function providerUsesGateway(provider: CodexProvider): boolean {
  const transportMode = providerTransportMode(provider);
  return transportMode === "chat-completions-gateway" ||
    (transportMode === "auto" && Boolean(provider.useGateway));
}

function providerFunctionToolTransport(
  provider: CodexProvider,
): NonNullable<CodexFunctionToolCapability["transport"]> {
  const transportMode = providerTransportMode(provider);
  if (transportMode === "chat-completions-gateway" || transportMode === "responses") {
    return transportMode;
  }
  const baseUrl = provider.baseUrl?.trim();
  const host = baseUrl
    ? (() => {
        try {
          return new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`).hostname;
        } catch {
          return null;
        }
      })()
    : null;
  return provider.useGateway || provider.providerKind === "opencode" || host === "api.duckcoding.ai"
    ? "chat-completions-gateway"
    : "responses";
}

function isCurrentFunctionToolCapability(
  credential: CodexCredential,
  model: string | null | undefined,
  provider: CodexProvider,
): boolean {
  const capabilityTransport = credential.functionToolCapability?.transport;
  const transportMode = providerTransportMode(provider);
  const transportMatches = transportMode === "auto"
    ? capabilityTransport === "responses" || capabilityTransport === "chat-completions-gateway"
    : capabilityTransport === providerFunctionToolTransport(provider);
  return credential.functionToolCapability?.model === (model?.trim() || null) &&
    transportMatches;
}

function selectionBelongsToProvider(
  providerId: string,
  selection: AppSettings["executionCredentialSelection"],
): boolean {
  return selection?.providerId === providerId;
}

export function SettingsProvidersSection({
  appSettings,
  onUpdateAppSettings,
  providerSessionDiagnostics,
}: SettingsProvidersSectionProps) {
  const { t } = useI18n();
  const initialProviders = useMemo(() => providersFromSettings(appSettings), []);
  const createCredential = (): CodexCredential => ({
    id: createProviderEntityId("credential"),
    name: t("settings.codex.defaultCredentialName"),
    key: "",
    newApiAccessToken: null,
    newApiSessionCookie: null,
    keyEnvVar: DEFAULT_KEY_ENV_VAR,
  });
  const createGroup = (): CodexCredentialGroup => ({
    id: createProviderEntityId("group"),
    name: t("settings.codex.defaultGroupName"),
    credentials: [createCredential()],
  });
  const createProvider = (): CodexProvider => ({
    id: createProviderEntityId("provider"),
    name: "",
    providerKind: "custom",
    usageProtocol: "auto",
    baseUrlEnvVar: DEFAULT_BASE_URL_ENV_VAR,
    baseUrl: null,
    model: null,
    contextWindow: null,
    maxOutputTokens: null,
    useGateway: false,
    transportMode: "auto",
    supportsThinking: true,
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
    lastModelRefreshAtMs: null,
    cachedModels: [],
    groups: [createGroup()],
  });

  const [providers, setProviders] = useState<CodexProvider[]>(initialProviders);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    initialProviders[0]?.id ?? null,
  );
  const [draft, setDraft] = useState<CodexProvider>(() =>
    initialProviders[0] ? cloneProvider(initialProviders[0]) : createProvider(),
  );
  const [isNewDraft, setIsNewDraft] = useState(initialProviders.length === 0);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [modelFetchState, setModelFetchState] = useState<{
    status: "idle" | "loading" | "done" | "error";
    error: string | null;
  }>({ status: "idle", error: null });
  const [behaviorSaving, setBehaviorSaving] = useState(false);
  const [behaviorError, setBehaviorError] = useState(false);
  const [probingCredentialId, setProbingCredentialId] = useState<string | null>(null);
  const [usageProbeStates, setUsageProbeStates] = useState<Record<string, UsageProbeState>>({});
  const [sessionLoginCredentialId, setSessionLoginCredentialId] = useState<string | null>(null);
  const [sessionLoginError, setSessionLoginError] = useState<string | null>(null);

  useEffect(() => {
    const next = providersFromSettings(appSettings);
    setProviders(next);
    if (next.length === 0) return;
    const selected = next.find((provider) => provider.id === selectedProviderId) ?? next[0];
    setSelectedProviderId(selected.id);
    setDraft(cloneProvider(selected));
    setIsNewDraft(false);
  }, [appSettings.codexProviders, appSettings.codexKeyProfiles]);

  const executionProviderId = appSettings.executionCredentialSelection?.providerId ?? null;
  const singleCredentialDraft = providerWithSingleCredentialGroups(draft);
  const persistedProvider = providers.find((provider) => provider.id === draft.id) ?? null;
  const draftMatchesPersistedProvider = Boolean(
    persistedProvider && JSON.stringify(persistedProvider) === JSON.stringify(draft),
  );
  const firstCredential =
    singleCredentialDraft.groups.flatMap((group) => group.credentials)[0] ?? null;
  const selectedCredential =
    appSettings.executionCredentialSelection?.providerId === draft.id
      ? credentialForSelection(
          [singleCredentialDraft],
          appSettings.executionCredentialSelection,
        )?.credential ?? null
      : null;
  const modelCredential = selectedCredential ?? firstCredential;
  const modelCache = mergeCodexProviderModels(
    modelCredential?.cachedModels ?? draft.cachedModels,
    draft.model?.trim()
      ? [{ id: draft.model.trim(), name: null, contextWindow: null }]
      : [],
  );
  const resolvedBaseUrl = resolveCodexProviderBaseUrl(draft.providerKind, draft.baseUrl ?? "") ?? "";
  const usageCredentials = useMemo(
    () =>
      providerWithSingleCredentialGroups(draft).groups
        .map((group) => group.credentials[0])
        .filter((credential): credential is CodexCredential => Boolean(credential)),
    [draft],
  );
  const usageCredentialSignature = useMemo(
    () =>
      JSON.stringify(
        usageCredentials.map((credential) => ({
          id: credential.id,
          key: credential.key,
          newApiAccessToken: credential.newApiAccessToken ?? null,
          newApiSessionCookie: credential.newApiSessionCookie ?? null,
        })),
      ),
    [usageCredentials],
  );
  const providerValid =
    draft.name.trim().length > 0 &&
    singleCredentialDraft.groups.length > 0 &&
    singleCredentialDraft.groups.every(
      (group) =>
        group.name.trim().length > 0 &&
        group.credentials.length > 0 &&
        group.credentials.every(
          (credential) =>
            credential.name.trim().length > 0 && credential.key.trim().length > 0,
        ),
    ) &&
    (draft.providerKind !== "opencode" || Boolean(draft.model?.trim())) &&
    (!providerUsesGateway(draft) || Boolean(resolvedBaseUrl));

  const selectProvider = (provider: CodexProvider) => {
    setSelectedProviderId(provider.id);
    setDraft(cloneProvider(provider));
    setIsNewDraft(false);
    setVisibleSecrets(new Set());
    setModelFetchState({ status: "idle", error: null });
    setUsageProbeStates({});
    setSessionLoginError(null);
  };

  const startNewProvider = () => {
    const next = createProvider();
    setSelectedProviderId(null);
    setDraft(next);
    setIsNewDraft(true);
    setVisibleSecrets(new Set());
    setModelFetchState({ status: "idle", error: null });
    setUsageProbeStates({});
    setSessionLoginError(null);
  };

  const duplicateProvider = () => {
    const source = providerWithSingleCredentialGroups(draft);
    const duplicate: CodexProvider = {
      ...cloneProvider(source),
      id: createProviderEntityId("provider"),
      name: `${draft.name || t("settings.codex.unnamedProvider")} ${t("settings.codex.copySuffix")}`,
      groups: source.groups.map((group) => ({
        ...group,
        id: createProviderEntityId("group"),
        credentials: group.credentials.map((credential) => ({
          ...credential,
          id: createProviderEntityId("credential"),
          key: "",
          newApiAccessToken: null,
          newApiSessionCookie: null,
          cachedModels: [],
          lastModelRefreshAtMs: null,
        })),
      })),
    };
    setSelectedProviderId(null);
    setDraft(duplicate);
    setIsNewDraft(true);
    setVisibleSecrets(new Set());
  };

  const persistProvider = async (activate: boolean) => {
    if (!providerValid || saveState === "saving") return;
    const normalizedDraft = providerWithSingleCredentialGroups(draft);
    const normalized: CodexProvider = {
      ...cloneProvider(normalizedDraft),
      name: draft.name.trim(),
      transportMode: providerTransportMode(draft),
      useGateway: providerTransportMode(draft) === "chat-completions-gateway",
      baseUrl: resolvedBaseUrl || null,
      model: draft.model?.trim() || null,
      baseUrlEnvVar: draft.baseUrlEnvVar.trim() || DEFAULT_BASE_URL_ENV_VAR,
      groups: normalizedDraft.groups.map((group) => ({
        ...group,
        name: group.name.trim(),
        credentials: group.credentials.map((credential) => ({
          ...credential,
          name: group.name.trim() || credential.name.trim() || t("settings.codex.defaultCredentialName"),
          key: credential.key.trim(),
          newApiAccessToken: credential.newApiAccessToken?.trim() || null,
          newApiSessionCookie: credential.newApiSessionCookie?.trim() || null,
          keyEnvVar: credential.keyEnvVar.trim() || DEFAULT_KEY_ENV_VAR,
        })),
      })),
    };
    const nextProviders = isNewDraft
      ? [...providers, normalized]
      : providers.map((provider) => (provider.id === normalized.id ? normalized : provider));
    const nextSelection = providerSelection(normalized);
    const preservedExecutionSelection = credentialForSelection(
      nextProviders,
      appSettings.executionCredentialSelection,
    )
      ? appSettings.executionCredentialSelection ?? null
      : null;
    const preservedUsageSelection = credentialForSelection(
      nextProviders,
      appSettings.usageCredentialSelection,
    )
      ? appSettings.usageCredentialSelection ?? null
      : null;
    setSaveState("saving");
    try {
      await onUpdateAppSettings({
        ...appSettings,
        codexProviders: nextProviders,
        codexKeyProfiles: providersToLegacyProfiles(nextProviders),
        activeCodexKeyProfileId: preservedExecutionSelection
          ? credentialSelectionId(preservedExecutionSelection)
          : null,
        executionCredentialSelection: preservedExecutionSelection,
        usageCredentialSelection: preservedUsageSelection,
        ...(activate && nextSelection
          ? {
              executionCredentialSelection: nextSelection,
              activeCodexKeyProfileId: credentialSelectionId(nextSelection),
            }
          : {}),
      });
      setProviders(nextProviders);
      setSelectedProviderId(normalized.id);
      setDraft(cloneProvider(normalized));
      setIsNewDraft(false);
      setSaveState("idle");
    } catch {
      setSaveState("error");
    }
  };

  const deleteProvider = async (providerId: string) => {
    if (saveState === "saving") return;
    const nextProviders = providers.filter((provider) => provider.id !== providerId);
    const clearExecution = selectionBelongsToProvider(
      providerId,
      appSettings.executionCredentialSelection,
    );
    const clearUsage = selectionBelongsToProvider(providerId, appSettings.usageCredentialSelection);
    setSaveState("saving");
    try {
      await onUpdateAppSettings({
        ...appSettings,
        codexProviders: nextProviders,
        codexKeyProfiles: providersToLegacyProfiles(nextProviders),
        activeCodexKeyProfileId: clearExecution ? null : appSettings.activeCodexKeyProfileId,
        executionCredentialSelection: clearExecution
          ? null
          : appSettings.executionCredentialSelection ?? null,
        usageCredentialSelection: clearUsage ? null : appSettings.usageCredentialSelection ?? null,
      });
      setProviders(nextProviders);
      const nextSelected = nextProviders[0] ?? null;
      if (nextSelected) selectProvider(nextSelected);
      else startNewProvider();
      setSaveState("idle");
    } catch {
      setSaveState("error");
    }
  };

  const updateGroup = (groupId: string, update: (group: CodexCredentialGroup) => CodexCredentialGroup) => {
    setDraft((current) => ({
      ...current,
      groups: current.groups.map((group) => (group.id === groupId ? update(group) : group)),
    }));
  };

  const updateCredential = (
    groupId: string,
    credentialId: string,
    patch: Partial<CodexCredential>,
  ) => {
    updateGroup(groupId, (group) => ({
      ...group,
      credentials: group.credentials.map((credential) =>
        credential.id === credentialId ? { ...credential, ...patch } : credential,
      ),
    }));
  };

  useEffect(() => {
    let canceled = false;
    const credentials = usageCredentials;
    if (
      !draftMatchesPersistedProvider ||
      !resolvedBaseUrl ||
      draft.providerKind === "openai" ||
      draft.usageProtocol === "disabled" ||
      credentials.length === 0
    ) {
      setUsageProbeStates({});
      return () => {
        canceled = true;
      };
    }
    setUsageProbeStates(
      Object.fromEntries(credentials.map((credential) => [credential.id, "loading" as const])),
    );
    void Promise.all(
      credentials.map(async (credential) => {
        try {
          const snapshot = await getThirdPartyKeyUsage(
            resolvedBaseUrl,
            credential.key,
            draft.usageProtocol ?? "auto",
            credential.newApiAccessToken,
            credential.newApiSessionCookie,
          );
          const canDisplayQuota = Boolean(
            snapshot &&
              (snapshot.balanceUsd !== null || snapshot.isUnlimited),
          );
          return [credential.id, canDisplayQuota ? "available" : "unavailable"] as const;
        } catch {
          return [credential.id, "unavailable"] as const;
        }
      }),
    ).then((entries) => {
      if (!canceled) {
        setUsageProbeStates(Object.fromEntries(entries));
      }
    });
    return () => {
      canceled = true;
    };
  }, [
    draft.providerKind,
    draft.usageProtocol,
    draftMatchesPersistedProvider,
    resolvedBaseUrl,
    usageCredentials,
    usageCredentialSignature,
  ]);

  const loginForUsage = async (groupId: string, credentialId: string) => {
    if (
      !persistedProvider ||
      !draftMatchesPersistedProvider ||
      !resolvedBaseUrl ||
      sessionLoginCredentialId
    ) {
      return;
    }
    const credential = draft.groups
      .find((group) => group.id === groupId)
      ?.credentials.find((item) => item.id === credentialId);
    if (!credential) return;
    setSessionLoginCredentialId(credentialId);
    setSessionLoginError(null);
    try {
      const cachedSessionCookie = credential.newApiSessionCookie?.trim();
      if (cachedSessionCookie) {
        const cachedUsage = await getThirdPartyKeyUsage(
          resolvedBaseUrl,
          credential.key,
          draft.usageProtocol ?? "auto",
          credential.newApiAccessToken,
          cachedSessionCookie,
        );
        if (cachedUsage?.balanceScope === "account" && cachedUsage.balanceUsd !== null) {
          setUsageProbeStates((current) => ({ ...current, [credentialId]: "available" }));
          return;
        }
      }
      const sessionCookie = await providerSessionLogin(
        resolvedBaseUrl,
        draft.usageProtocol ?? "auto",
      );
      const nextProviders = providers.map((provider) =>
        provider.id !== persistedProvider.id
          ? provider
          : {
              ...provider,
              groups: provider.groups.map((group) =>
                group.id !== groupId
                  ? group
                  : {
                      ...group,
                      credentials: group.credentials.map((item) =>
                        item.id === credentialId
                          ? { ...item, newApiSessionCookie: sessionCookie }
                          : item,
                      ),
                    },
              ),
            },
      );
      await onUpdateAppSettings({
        ...appSettings,
        codexProviders: nextProviders,
        codexKeyProfiles: providersToLegacyProfiles(nextProviders),
      });
      setProviders(nextProviders);
      const nextProvider = nextProviders.find((provider) => provider.id === persistedProvider.id);
      if (nextProvider) setDraft(cloneProvider(nextProvider));
      setUsageProbeStates((current) => ({ ...current, [credentialId]: "loading" }));
    } catch (error) {
      setSessionLoginError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionLoginCredentialId(null);
    }
  };

  const probeFunctionToolCalling = async (groupId: string, credentialId: string) => {
    if (!persistedProvider || !draftMatchesPersistedProvider || probingCredentialId) return;
    const selection = providerSelection(persistedProvider, groupId, credentialId);
    const model = persistedProvider.model?.trim() || null;
    if (!selection || !model) return;

    setProbingCredentialId(credentialId);
    try {
      const probe = await probeProviderFunctionCalling(selection);
      const functionToolCapability: CodexFunctionToolCapability = {
        ...probe,
        model,
        checkedAtMs: Date.now(),
      };
      const nextProviders = providers.map((provider) =>
        provider.id !== persistedProvider.id
          ? provider
          : {
              ...provider,
              groups: provider.groups.map((group) =>
                group.id !== groupId
                  ? group
                  : {
                      ...group,
                      credentials: group.credentials.map((credential) =>
                        credential.id === credentialId
                          ? { ...credential, functionToolCapability }
                          : credential,
                      ),
                    },
              ),
            },
      );
      const nextProvider = nextProviders.find((provider) => provider.id === persistedProvider.id);
      await onUpdateAppSettings({
        ...appSettings,
        codexProviders: nextProviders,
        codexKeyProfiles: providersToLegacyProfiles(nextProviders),
      });
      setProviders(nextProviders);
      if (nextProvider) setDraft(cloneProvider(nextProvider));
    } catch {
      const nextProviders = providers.map((provider) =>
        provider.id !== persistedProvider.id
          ? provider
          : {
              ...provider,
              groups: provider.groups.map((group) =>
                group.id !== groupId
                  ? group
                  : {
                      ...group,
                      credentials: group.credentials.map((credential) =>
                        credential.id === credentialId
                          ? {
                              ...credential,
                              functionToolCapability: {
                                 state: "error" as const,
                                model,
                                transport: providerUsesGateway(provider)
                                  ? ("chat-completions-gateway" as const)
                                  : ("responses" as const),
                                checkedAtMs: Date.now(),
                                failureCode: "request_failed",
                              },
                            }
                          : credential,
                      ),
                    },
              ),
            },
      );
      const nextProvider = nextProviders.find((provider) => provider.id === persistedProvider.id);
      await onUpdateAppSettings({
        ...appSettings,
        codexProviders: nextProviders,
        codexKeyProfiles: providersToLegacyProfiles(nextProviders),
      });
      setProviders(nextProviders);
      if (nextProvider) setDraft(cloneProvider(nextProvider));
    } finally {
      setProbingCredentialId(null);
    }
  };

  const fetchModels = async () => {
    if (!resolvedBaseUrl || !modelCredential?.key.trim()) {
      setModelFetchState({
        status: "error",
        error: t("settings.codex.providerModelsNeedUrlAndKey"),
      });
      return;
    }
    setModelFetchState({ status: "loading", error: null });
    try {
      const models = await getProviderModels(resolvedBaseUrl, modelCredential.key.trim());
      const refreshedAtMs = Date.now();
      setDraft((current) => ({
        ...current,
        groups: current.groups.map((group) => ({
          ...group,
          credentials: group.credentials.map((credential) =>
            credential.id !== modelCredential.id
              ? credential
              : {
                  ...credential,
                  cachedModels: mergeCodexProviderModels(
                    credential.cachedModels,
                    models,
                  ),
                  lastModelRefreshAtMs: refreshedAtMs,
                },
          ),
        })),
      }));
      setModelFetchState({
        status: "done",
        error: models.length ? null : t("settings.codex.providerModelsEmpty"),
      });
    } catch (error) {
      setModelFetchState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const toggleBehavior = async (field: "preserveSessionLibraryOnProviderSwitch" | "syncProviderProfileToLocalConfig") => {
    if (behaviorSaving) return;
    setBehaviorSaving(true);
    setBehaviorError(false);
    try {
      await onUpdateAppSettings({ ...appSettings, [field]: !appSettings[field] });
    } catch {
      setBehaviorError(true);
    } finally {
      setBehaviorSaving(false);
    }
  };

  const staleReasonKey = providerSessionDiagnostics
    ? ({
          none: "settings.codex.diagnosticsStaleNone",
          "continuity-disabled": "settings.codex.diagnosticsStaleContinuityDisabled",
          "runtime-refresh-pending": "settings.codex.diagnosticsStaleRuntimeRefreshPending",
          "pagination-incomplete": "settings.codex.diagnosticsStalePaginationIncomplete",
          "snapshot-unavailable": "settings.codex.diagnosticsStaleSnapshotUnavailable",
          "snapshot-incomplete": "settings.codex.diagnosticsStaleSnapshotIncomplete",
          "verification-inconclusive": "settings.codex.diagnosticsStaleVerificationInconclusive",
        } as const)[providerSessionDiagnostics.staleReason]
    : "settings.codex.diagnosticsUnavailable" as const;
  const fallbackKey = providerSessionDiagnostics
    ? ({
          none: "settings.codex.diagnosticsFallbackNone",
          "runtime-authoritative": "settings.codex.diagnosticsFallbackRuntimeAuthoritative",
          "retained-previous-list": "settings.codex.diagnosticsFallbackRetainedList",
          "awaiting-runtime-list": "settings.codex.diagnosticsFallbackAwaitingList",
        } as const)[providerSessionDiagnostics.fallback]
    : "settings.codex.diagnosticsUnavailable" as const;
  const staleReason = t(staleReasonKey);
  const fallback = t(fallbackKey);

  return (
    <div className="settings-provider-editor">
      <SettingsSection
        title={t("settings.codex.keyProfile")}
        subtitle={t("settings.codex.keyProfileHelp")}
        className="settings-provider-editor-section"
      >
        <div className="settings-provider-toolbar">
          <button type="button" className="ghost settings-button-compact" onClick={startNewProvider}>
            <Plus size={14} aria-hidden="true" />
            {t("settings.codex.newProvider")}
          </button>
          <button
            type="button"
            className="ghost settings-button-compact"
            disabled={isNewDraft}
            onClick={duplicateProvider}
          >
            <Copy size={14} aria-hidden="true" />
            {t("settings.codex.duplicateProvider")}
          </button>
          <span className="settings-provider-toolbar-spacer" />
          <button
            type="button"
            className="ghost settings-button-compact"
            disabled={!providerValid || saveState === "saving"}
            onClick={() => void persistProvider(false)}
          >
            {t("common.save")}
          </button>
          <button
            type="button"
            className="primary settings-button-compact"
            disabled={!providerValid || saveState === "saving"}
            onClick={() => void persistProvider(true)}
          >
            {t("settings.codex.saveAndEnable")}
          </button>
        </div>
        {saveState === "error" ? (
          <div className="settings-help settings-help-error" role="alert">
            {t("settings.codex.providerSettingSaveFailed")}
          </div>
        ) : null}
        <div className="settings-provider-workspace">
          <aside className="settings-provider-master" aria-label={t("settings.codex.providerList") }>
            <button
              type="button"
              className={`settings-provider-list-item ${executionProviderId ? "" : "is-selected"}`}
              aria-pressed={!executionProviderId}
              onClick={() =>
                void onUpdateAppSettings({
                  ...appSettings,
                  activeCodexKeyProfileId: null,
                  executionCredentialSelection: null,
                })
              }
            >
              <span className="settings-provider-list-copy">
                <strong>{t("settings.codex.defaultEnvVars")}</strong>
                <small>{t("settings.codex.defaultConfigSource")}</small>
              </span>
              {!executionProviderId ? <Check size={13} aria-hidden="true" /> : null}
            </button>
            {providers.map((provider) => {
              const selected = !isNewDraft && selectedProviderId === provider.id;
              const enabled = executionProviderId === provider.id;
              return (
                <div key={provider.id} className="settings-provider-list-row">
                  <button
                    type="button"
                    className={`settings-provider-list-item ${selected ? "is-selected" : ""}`}
                    onClick={() => selectProvider(provider)}
                    aria-pressed={selected}
                  >
                    <span className="settings-provider-list-copy">
                      <strong>{provider.name}</strong>
                      <small>{provider.baseUrl || t("settings.codex.providerUrlNotSet")}</small>
                      <span className="settings-provider-badges">
                        {enabled ? <span>{t("settings.codex.enabledBadge")}</span> : null}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ghost icon-button settings-provider-list-delete"
                    aria-label={`${t("common.delete")} ${provider.name}`}
                    title={t("common.delete")}
                    onClick={() => void deleteProvider(provider.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </aside>
          <div className="settings-provider-detail">
            <section className="settings-provider-form-section">
              <div className="settings-subsection-title">{t("settings.codex.connectionSection")}</div>
              <div className="settings-provider-form-grid">
                <label>
                  <span>{t("settings.codex.providerName")}</span>
                  <input
                    className="settings-input"
                    value={draft.name}
                    aria-label={t("settings.codex.keyProfileNameAria")}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label>
                  <span>{t("settings.codex.providerKindAria")}</span>
                  <select
                    className="settings-select"
                    value={draft.providerKind ?? "custom"}
                    aria-label={t("settings.codex.providerKindAria")}
                    onChange={(event) => {
                      const providerKind = event.target.value as CodexProvider["providerKind"];
                      setDraft({
                        ...draft,
                        providerKind,
                        baseUrl:
                          draft.baseUrl || resolveCodexProviderBaseUrl(providerKind, null) || null,
                        useGateway: providerKind === "opencode" ? true : draft.useGateway,
                        transportMode:
                          providerKind === "opencode"
                            ? "chat-completions-gateway"
                            : providerTransportMode(draft),
                      });
                    }}
                  >
                    <option value="custom">{t("settings.codex.providerKindCustom")}</option>
                    <option value="openai">{t("settings.codex.providerKindOpenai")}</option>
                    <option value="deepseek">{t("settings.codex.providerKindDeepseek")}</option>
                    <option value="openrouter">{t("settings.codex.providerKindOpenrouter")}</option>
                    <option value="opencode">{t("settings.codex.providerKindOpencode")}</option>
                  </select>
                </label>
                <label className="settings-provider-form-wide">
                  <span>{t("settings.codex.baseUrlAria")}</span>
                  <input
                    className="settings-input"
                    value={draft.baseUrl ?? ""}
                    aria-label={t("settings.codex.baseUrlAria")}
                    onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value || null })}
                  />
                </label>
                <label>
                  <span>{t("settings.codex.usageProtocolAria")}</span>
                  <select
                    className="settings-select"
                    value={draft.usageProtocol ?? "auto"}
                    aria-label={t("settings.codex.usageProtocolAria")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        usageProtocol: event.target.value as CodexProvider["usageProtocol"],
                      })
                    }
                  >
                    <option value="auto">{t("settings.codex.usageProtocolAuto")}</option>
                    <option value="sub2">{t("settings.codex.usageProtocolSub2")}</option>
                    <option value="new-api">{t("settings.codex.usageProtocolNewApi")}</option>
                    <option value="disabled">{t("settings.codex.usageProtocolDisabled")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("settings.codex.transportModeAria")}</span>
                  <select
                    className="settings-select"
                    value={providerTransportMode(draft)}
                    aria-label={t("settings.codex.transportModeAria")}
                    disabled={draft.providerKind === "opencode"}
                    onChange={(event) => {
                      const transportMode = event.target.value as CodexProviderTransportMode;
                      setDraft({
                        ...draft,
                        transportMode,
                        useGateway: transportMode === "chat-completions-gateway",
                      });
                    }}
                  >
                    <option value="auto">{t("settings.codex.transportModeAuto")}</option>
                    <option value="responses">{t("settings.codex.transportModeResponses")}</option>
                    <option value="chat-completions-gateway">
                      {t("settings.codex.transportModeChatCompletionsGateway")}
                    </option>
                  </select>
                </label>
              </div>
            </section>

            <section className="settings-provider-form-section settings-provider-credentials-section">
              <div className="settings-provider-section-header">
                <div>
                  <div className="settings-subsection-title">{t("settings.codex.credentialsSection")}</div>
                  <div className="settings-help">{t("settings.codex.credentialsHelp")}</div>
                </div>
                <button
                  type="button"
                  className="ghost settings-button-compact"
                  onClick={() => setDraft({ ...draft, groups: [...draft.groups, createGroup()] })}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t("settings.codex.addCredential")}
                </button>
              </div>
              <div className="settings-provider-groups settings-provider-key-groups">
                {draft.groups.map((group, groupIndex) => {
                  const credential = group.credentials[0] ?? null;
                  const visible = credential ? visibleSecrets.has(credential.id) : false;
                  const capability = credential?.functionToolCapability;
                  const capabilityCurrent = credential
                    ? isCurrentFunctionToolCapability(credential, draft.model, draft)
                    : false;
                  const capabilityState = capabilityCurrent ? capability?.state ?? "unknown" : "unknown";
                  const usageProbeState = credential
                    ? usageProbeStates[credential.id] ?? "idle"
                    : "idle";
                  const capabilityLabel =
                    capabilityState === "verified"
                      ? t("settings.codex.functionToolStateVerified")
                      : capabilityState === "unsupported"
                        ? t("settings.codex.functionToolStateUnsupported")
                        : capabilityState === "incompatible"
                          ? t("settings.codex.functionToolStateIncompatible")
                          : capabilityState === "error"
                            ? t("settings.codex.functionToolStateError")
                            : t("settings.codex.functionToolStateUnknown");
                  const canProbe = Boolean(
                    credential &&
                      draftMatchesPersistedProvider &&
                      draft.model?.trim() &&
                      credential.key.trim(),
                  );
                  return (
                    <div key={group.id} className="settings-provider-key-card">
                      <div className="settings-provider-key-card-header">
                        <label className="settings-provider-key-group-name">
                          <span>{t("settings.codex.groupName")}</span>
                          <input
                            className="settings-input"
                            value={group.name}
                            aria-label={t("settings.codex.keyProfileGroupNameAria")}
                            onChange={(event) => {
                              const nextName = event.target.value;
                              updateGroup(group.id, (current) => ({
                                ...current,
                                name: nextName,
                                credentials: current.credentials.map((item, itemIndex) =>
                                  itemIndex === 0 ? { ...item, name: nextName || item.name } : item,
                                ),
                              }));
                            }}
                          />
                        </label>
                        <div className="settings-provider-key-card-actions">
                          <button
                            type="button"
                            className="ghost icon-button"
                            disabled={groupIndex === 0}
                            aria-label={t("settings.codex.moveGroupUp")}
                            title={t("settings.codex.moveGroupUp")}
                            onClick={() => setDraft({ ...draft, groups: moveItem(draft.groups, groupIndex, -1) })}
                          ><ChevronUp size={14} aria-hidden="true" /></button>
                          <button
                            type="button"
                            className="ghost icon-button"
                            disabled={groupIndex === draft.groups.length - 1}
                            aria-label={t("settings.codex.moveGroupDown")}
                            title={t("settings.codex.moveGroupDown")}
                            onClick={() => setDraft({ ...draft, groups: moveItem(draft.groups, groupIndex, 1) })}
                          ><ChevronDown size={14} aria-hidden="true" /></button>
                          <button
                            type="button"
                            className="ghost icon-button"
                            aria-label={`${t("common.delete")} ${group.name}`}
                            title={t("common.delete")}
                            onClick={() => setDraft({ ...draft, groups: draft.groups.filter((item) => item.id !== group.id) })}
                          ><Trash2 size={14} aria-hidden="true" /></button>
                        </div>
                      </div>
                      {credential ? (
                        <div className="settings-provider-key-fields">
                          <label className="settings-provider-api-key-field">
                            <span>{t("settings.codex.apiKeyAria")}</span>
                            <div className="settings-provider-secret-input">
                              <input
                                className="settings-input"
                                type={visible ? "text" : "password"}
                                value={credential.key}
                                placeholder={maskCredential(credential.key) || t("settings.codex.apiKeyPlaceholder")}
                                aria-label={t("settings.codex.apiKeyAria")}
                                onChange={(event) =>
                                  updateCredential(group.id, credential.id, { key: event.target.value })
                                }
                              />
                              <button
                                type="button"
                                className="ghost icon-button"
                                aria-label={visible ? t("common.hide") : t("common.show")}
                                title={visible ? t("common.hide") : t("common.show")}
                                onClick={() =>
                                  setVisibleSecrets((current) => {
                                    const next = new Set(current);
                                    if (next.has(credential.id)) next.delete(credential.id);
                                    else next.add(credential.id);
                                    return next;
                                  })
                                }
                              >
                                {visible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                              </button>
                            </div>
                          </label>
                          {draft.providerKind !== "openai" && draft.usageProtocol !== "disabled" ? (
                            <div className="settings-provider-access-token-field">
                              <div className="settings-field-row">
                                <button
                                  type="button"
                                  className="ghost settings-button-compact"
                                  disabled={sessionLoginCredentialId !== null}
                                  onClick={() => void loginForUsage(group.id, credential.id)}
                                >
                                  {sessionLoginCredentialId === credential.id
                                    ? t("common.loading")
                                    : t("settings.codex.loginForUsage")}
                                </button>
                                {credential.newApiSessionCookie ? (
                                  <span className="settings-help settings-help-inline">
                                    {t("settings.codex.sessionCookieSaved")}
                                  </span>
                                ) : null}
                              </div>
                              <span className="settings-help">
                                {t("settings.codex.loginForUsageHelp")}
                              </span>
                              {usageProbeState === "loading" ? (
                                <span className="settings-help">{t("settings.codex.checkingProviderUsage")}</span>
                              ) : null}
                              {sessionLoginError && sessionLoginCredentialId === null ? (
                                <span className="settings-help settings-help-error">{sessionLoginError}</span>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="settings-provider-tool-capability" aria-live="polite">
                            <div className="settings-provider-tool-capability-copy">
                              <span>{t("settings.codex.functionToolCapability")}</span>
                              <strong className={`is-${capabilityState}`}>{capabilityLabel}</strong>
                              {capability?.failureCode && capabilityCurrent ? (
                                <small>{capability.failureCode}</small>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              className="ghost settings-button-compact"
                              disabled={!canProbe || probingCredentialId !== null}
                              title={
                                !draftMatchesPersistedProvider
                                  ? t("settings.codex.functionToolSaveBeforeVerify")
                                  : undefined
                              }
                              onClick={() => void probeFunctionToolCalling(group.id, credential.id)}
                            >
                              {probingCredentialId === credential.id
                                ? t("common.loading")
                                : t("settings.codex.verifyFunctionTool")}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="settings-provider-form-section">
              <div className="settings-subsection-title">{t("settings.codex.modelSection")}</div>
              <div className="settings-provider-form-grid settings-provider-model-grid">
                <label className="settings-provider-form-wide settings-provider-model-field">
                  <span>{t("settings.codex.providerModelAria")}</span>
                  <div className="settings-field-row">
                    {modelCache.length > 0 ? (
                      <select
                        className="settings-select"
                        value={draft.model ?? ""}
                        aria-label={t("settings.codex.providerModelAria")}
                        onChange={(event) => setDraft({ ...draft, model: event.target.value || null })}
                      >
                        <option value="">{t("settings.codex.providerModelPlaceholder")}</option>
                        {modelCache.map((model) => (
                          <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="settings-input"
                        value={draft.model ?? ""}
                        aria-label={t("settings.codex.providerModelAria")}
                        onChange={(event) => setDraft({ ...draft, model: event.target.value || null })}
                      />
                    )}
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      disabled={modelFetchState.status === "loading"}
                      onClick={() => void fetchModels()}
                    >
                      {modelFetchState.status === "loading"
                        ? t("common.loading")
                        : t("settings.codex.fetchProviderModels")}
                    </button>
                  </div>
                </label>
                <label className="settings-provider-number-field">
                  <span>{t("settings.codex.contextWindowAria")}</span>
                  <input
                    className="settings-input"
                    type="number"
                    min="1"
                    value={draft.contextWindow ?? ""}
                    onChange={(event) =>
                      setDraft({ ...draft, contextWindow: parsePositiveInteger(event.target.value) })
                    }
                  />
                </label>
                <label className="settings-provider-number-field">
                  <span>{t("settings.codex.maxOutputTokensAria")}</span>
                  <input
                    className="settings-input"
                    type="number"
                    min="1"
                    value={draft.maxOutputTokens ?? ""}
                    onChange={(event) =>
                      setDraft({ ...draft, maxOutputTokens: parsePositiveInteger(event.target.value) })
                    }
                  />
                </label>
                <label className="settings-checkbox settings-provider-checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.supportsThinking)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        supportsThinking: event.target.checked,
                        supportsReasoningEffort: event.target.checked
                          ? draft.supportsReasoningEffort
                          : false,
                      })
                    }
                  />
                  <span>{t("settings.codex.supportsThinking")}</span>
                </label>
                <label className="settings-checkbox settings-provider-checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.supportsReasoningEffort)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        supportsThinking: event.target.checked || draft.supportsThinking,
                        supportsReasoningEffort: event.target.checked,
                      })
                    }
                  />
                  <span>{t("settings.codex.supportsReasoningEffort")}</span>
                </label>
                {draft.supportsReasoningEffort ? (
                  <label className="settings-provider-effort-field">
                    <span>{t("settings.codex.defaultReasoningEffort")}</span>
                    <select
                      className="settings-select"
                      value={draft.defaultReasoningEffort ?? "medium"}
                      onChange={(event) =>
                        setDraft({ ...draft, defaultReasoningEffort: event.target.value })
                      }
                    >
                      {PROVIDER_REASONING_EFFORT_VALUES.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              {modelFetchState.error ? (
                <div className="settings-help settings-help-error">{modelFetchState.error}</div>
              ) : null}
              {draft.providerKind === "opencode" && !draft.model?.trim() ? (
                <div className="settings-help settings-help-error">
                  {t("settings.codex.opencodeModelRequired")}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.codex.providerBehavior")}>
        <SettingsToggleRow
          title={t("settings.codex.preserveSessionLibrary")}
          subtitle={t("settings.codex.preserveSessionLibraryHelp")}
        >
          <SettingsToggleSwitch
            pressed={appSettings.preserveSessionLibraryOnProviderSwitch}
            disabled={behaviorSaving}
            aria-label={t("settings.codex.preserveSessionLibrary")}
            onClick={() => void toggleBehavior("preserveSessionLibraryOnProviderSwitch")}
          />
        </SettingsToggleRow>
        <SettingsToggleRow
          title={t("settings.codex.syncProviderToLocalConfig")}
          subtitle={t("settings.codex.syncProviderToLocalConfigHelp")}
        >
          <SettingsToggleSwitch
            pressed={appSettings.syncProviderProfileToLocalConfig}
            disabled={behaviorSaving}
            aria-label={t("settings.codex.syncProviderToLocalConfig")}
            onClick={() => void toggleBehavior("syncProviderProfileToLocalConfig")}
          />
        </SettingsToggleRow>
        {behaviorError ? (
          <div className="settings-help settings-help-error" role="alert">
            {t("settings.codex.providerSettingSaveFailed")}
          </div>
        ) : null}
      </SettingsSection>

      <details className="settings-provider-diagnostics">
        <summary className="settings-provider-diagnostics-title">
          {t("settings.codex.providerDiagnostics")}
        </summary>
        <div className="settings-help">{t("settings.codex.providerDiagnosticsHelp")}</div>
        <dl className="settings-provider-diagnostics-grid">
          <div><dt>{t("settings.codex.diagnosticsWorkspace")}</dt><dd>{providerSessionDiagnostics?.workspaceName ?? t("settings.codex.diagnosticsUnavailable")}</dd></div>
          <div><dt>{t("settings.codex.diagnosticsProvider")}</dt><dd>{providerSessionDiagnostics ? `${providerSessionDiagnostics.providerName ?? t("settings.codex.diagnosticsDefaultProvider")} (${providerSessionDiagnostics.providerKind})` : t("settings.codex.diagnosticsUnavailable")}</dd></div>
          <div><dt>{t("settings.codex.diagnosticsSessionSource")}</dt><dd><code>{providerSessionDiagnostics?.sessionSourceId ?? t("settings.codex.diagnosticsUnavailable")}</code></dd></div>
          <div><dt>{t("settings.codex.diagnosticsRuntimeGeneration")}</dt><dd>{providerSessionDiagnostics?.runtimeGeneration ?? t("settings.codex.diagnosticsUnavailable")}</dd></div>
          <div><dt>{t("settings.codex.diagnosticsListGeneration")}</dt><dd>{providerSessionDiagnostics?.listGeneration ?? t("settings.codex.diagnosticsUnavailable")}</dd></div>
          <div><dt>{t("settings.codex.diagnosticsStaleReason")}</dt><dd>{staleReason}</dd></div>
          <div><dt>{t("settings.codex.diagnosticsStaleThreads")}</dt><dd>{providerSessionDiagnostics?.staleThreadCount ?? 0}</dd></div>
          <div><dt>{t("settings.codex.diagnosticsFallback")}</dt><dd>{fallback}</dd></div>
        </dl>
      </details>
    </div>
  );
}
