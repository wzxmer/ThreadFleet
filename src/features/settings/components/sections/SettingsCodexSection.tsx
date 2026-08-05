import { useEffect, useMemo, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Stethoscope from "lucide-react/dist/esm/icons/stethoscope";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  CodexDoctorResult,
  CodexProvider,
  CredentialSelection,
  CodexKeyProfile,
  CodexSyncDiagnostics,
  CodexStatus,
  CodexUpdateResult,
  ComputerControlAvailability,
  ComputerControlCapabilitySnapshot,
  ModelOption,
} from "@/types";
import {
  SettingsSection,
  SettingsToggleRow,
  SettingsToggleSwitch,
} from "@/features/design-system/components/settings/SettingsPrimitives";
import { FileEditorCard } from "@/features/shared/components/FileEditorCard";
import { useI18n } from "@/features/i18n/I18nProvider";
import { formatReasoningEffortLabel } from "@/features/models/utils/reasoningEffortLabels";
import { getProviderModels } from "@/services/tauri";
import {
  mergeCodexProviderModels,
  resolveCodexProviderBaseUrl,
} from "@/utils/providerProfiles";
import type { ProviderSessionDiagnostics } from "@settings/utils/providerSessionDiagnostics";
import type { SettingsWindowsUiUpdaterControls } from "../SettingsView";
import { WindowsUiUpdatePrompt } from "@/features/update/components/WindowsUiUpdatePrompt";
import { CodexSessionSharingStatus } from "./CodexSessionSharingStatus";

type SettingsCodexSectionProps = {
  mode?: "codex" | "providers";
  appSettings: AppSettings;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  providerSessionDiagnostics?: ProviderSessionDiagnostics | null;
  defaultModels: ModelOption[];
  defaultModelsLoading: boolean;
  defaultModelsError: string | null;
  defaultModelsConnectedWorkspaceCount: number;
  onRefreshDefaultModels: () => void;
  codexPathDraft: string;
  codexArgsDraft: string;
  codexHomeDraft: string;
  codexDirty: boolean;
  codexHomeReconnectState: {
    required: boolean;
    status: "idle" | "running" | "done";
    error: string | null;
  };
  isSavingSettings: boolean;
  doctorState: {
    status: "idle" | "running" | "done";
    result: CodexDoctorResult | null;
  };
  codexUpdateState: {
    status: "idle" | "running" | "done";
    result: CodexUpdateResult | null;
  };
  codexStatusState: {
    status: "idle" | "loading" | "done";
    result: CodexStatus | null;
    error: string | null;
  };
  codexSyncDiagnosticsState: {
    status: "idle" | "loading" | "done";
    result: CodexSyncDiagnostics | null;
    error: string | null;
  };
  mcpStatusState: {
    status: "idle" | "loading" | "done";
    result: unknown | null;
    error: string | null;
    workspaceName: string | null;
  };
  computerControlStatusState: {
    status: "idle" | "loading" | "done";
    result: ComputerControlCapabilitySnapshot | null;
    error: string | null;
    workspaceName: string | null;
  };
  windowsUiUpdater?: SettingsWindowsUiUpdaterControls;
  globalAgentsMeta: string;
  globalAgentsError: string | null;
  globalAgentsContent: string;
  globalAgentsLoading: boolean;
  globalAgentsRefreshDisabled: boolean;
  globalAgentsSaveDisabled: boolean;
  globalAgentsSaveLabel: string;
  globalConfigMeta: string;
  globalConfigError: string | null;
  globalConfigContent: string;
  globalConfigLoading: boolean;
  globalConfigRefreshDisabled: boolean;
  globalConfigSaveDisabled: boolean;
  globalConfigSaveLabel: string;
  onSetCodexPathDraft: Dispatch<SetStateAction<string>>;
  onSetCodexArgsDraft: Dispatch<SetStateAction<string>>;
  onSetCodexHomeDraft: Dispatch<SetStateAction<string>>;
  onSetGlobalAgentsContent: (value: string) => void;
  onSetGlobalConfigContent: (value: string) => void;
  onBrowseCodex: () => Promise<void>;
  onBrowseCodexHome: () => Promise<void>;
  onSaveCodexSettings: () => Promise<void>;
  onReconnectCodexHomeWorkspaces: () => Promise<void>;
  onRunDoctor: () => Promise<void>;
  onRunCodexUpdate: () => Promise<void>;
  onRefreshCodexStatus: () => void;
  onRefreshCodexSyncDiagnostics: () => void;
  onRefreshMcpStatus: () => void;
  onRefreshComputerControlStatus: () => void;
  onRefreshGlobalAgents: () => void;
  onSaveGlobalAgents: () => void;
  onRefreshGlobalConfig: () => void;
  onSaveGlobalConfig: () => void;
};

const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_CODEX_KEY_ENV_VAR = "OPENAI_API_KEY";
const DEFAULT_CODEX_BASE_URL_ENV_VAR = "OPENAI_BASE_URL";
const DISABLED_WINDOWS_UI_UPDATER: SettingsWindowsUiUpdaterControls = {
  enabled: false,
  state: { stage: "idle" },
  checkForUpdates: () => undefined,
  startInstall: () => undefined,
  dismiss: () => undefined,
};
const normalizeEffortValue = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
};

function coerceSavedModelSlug(value: string | null, models: ModelOption[]): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const bySlug = models.find((model) => model.model === trimmed);
  if (bySlug) {
    return bySlug.model;
  }
  const byId = models.find((model) => model.id === trimmed);
  return byId ? byId.model : null;
}

const getReasoningSupport = (model: ModelOption | null): boolean => {
  if (!model) {
    return false;
  }
  return model.supportedReasoningEfforts.length > 0 || model.defaultReasoningEffort !== null;
};

const getReasoningOptions = (model: ModelOption | null): string[] => {
  if (!model) {
    return [];
  }
  const supported = model.supportedReasoningEfforts
    .map((effort) => normalizeEffortValue(effort.reasoningEffort))
    .filter((effort): effort is string => Boolean(effort));
  if (supported.length > 0) {
    return Array.from(new Set(supported));
  }
  const fallback = normalizeEffortValue(model.defaultReasoningEffort);
  return fallback ? [fallback] : [];
};

const createCodexKeyProfileId = () =>
  `codex-key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const migratedProviderId = (profileId: string) => `provider-${profileId}`;
const migratedGroupId = (profileId: string) => `group-${profileId}`;
const migratedCredentialId = (profileId: string) => `credential-${profileId}`;

function profileIdFromSelection(selection: CredentialSelection | null | undefined): string | null {
  return selection
    ? `${selection.providerId}:${selection.groupId}:${selection.credentialId}`
    : null;
}

function selectionFromProfileId(profileId: string): CredentialSelection | null {
  const [providerId, groupId, credentialId, extra] = profileId.split(":");
  if (!providerId || !groupId || !credentialId || extra) {
    return null;
  }
  return { providerId, groupId, credentialId };
}

function selectionForProfileId(profileId: string): CredentialSelection {
  return (
    selectionFromProfileId(profileId) ?? {
      providerId: migratedProviderId(profileId),
      groupId: migratedGroupId(profileId),
      credentialId: migratedCredentialId(profileId),
    }
  );
}

function sameSelection(
  left: CredentialSelection | null | undefined,
  right: CredentialSelection | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.providerId === right.providerId &&
      left.groupId === right.groupId &&
      left.credentialId === right.credentialId,
  );
}

function profileToProvider(profile: CodexKeyProfile): CodexProvider {
  const selection = selectionFromProfileId(profile.id);
  const providerId = selection?.providerId ?? migratedProviderId(profile.id);
  const groupId = selection?.groupId ?? migratedGroupId(profile.id);
  const credentialId = selection?.credentialId ?? migratedCredentialId(profile.id);
  return {
    id: providerId,
    name: profile.name,
    providerKind: profile.providerKind ?? "custom",
    usageProtocol: profile.usageProtocol ?? "auto",
    baseUrlEnvVar: profile.baseUrlEnvVar || DEFAULT_CODEX_BASE_URL_ENV_VAR,
    baseUrl: profile.baseUrl ?? null,
    model: profile.model ?? null,
    contextWindow: profile.contextWindow ?? null,
    maxOutputTokens: profile.maxOutputTokens ?? null,
    useGateway: Boolean(profile.useGateway),
    supportsThinking: Boolean(profile.supportsThinking) || Boolean(profile.supportsReasoningEffort),
    supportsReasoningEffort: Boolean(profile.supportsReasoningEffort),
    lastModelRefreshAtMs: profile.lastModelRefreshAtMs ?? null,
    cachedModels: profile.cachedModels ?? [],
    groups: [
      {
        id: groupId,
        name: profile.groupName?.trim() || profile.name,
        credentials: [
          {
            id: credentialId,
            name: profile.name,
            key: profile.key,
            newApiAccessToken: profile.newApiAccessToken ?? null,
            keyEnvVar: profile.keyEnvVar || DEFAULT_CODEX_KEY_ENV_VAR,
          },
        ],
      },
    ],
  };
}

function profilesToProviders(profiles: CodexKeyProfile[]): CodexProvider[] {
  return profiles.map(profileToProvider);
}

export function SettingsCodexSection({
  mode = "codex",
  appSettings,
  onUpdateAppSettings,
  providerSessionDiagnostics = null,
  defaultModels,
  defaultModelsLoading,
  defaultModelsError,
  defaultModelsConnectedWorkspaceCount,
  onRefreshDefaultModels,
  codexPathDraft,
  codexArgsDraft,
  codexHomeDraft,
  codexDirty,
  codexHomeReconnectState,
  isSavingSettings,
  doctorState,
  codexUpdateState,
  codexStatusState,
  codexSyncDiagnosticsState,
  mcpStatusState,
  computerControlStatusState,
  windowsUiUpdater = DISABLED_WINDOWS_UI_UPDATER,
  globalAgentsMeta,
  globalAgentsError,
  globalAgentsContent,
  globalAgentsLoading,
  globalAgentsRefreshDisabled,
  globalAgentsSaveDisabled,
  globalAgentsSaveLabel,
  globalConfigMeta,
  globalConfigError,
  globalConfigContent,
  globalConfigLoading,
  globalConfigRefreshDisabled,
  globalConfigSaveDisabled,
  globalConfigSaveLabel,
  onSetCodexPathDraft,
  onSetCodexArgsDraft,
  onSetCodexHomeDraft,
  onSetGlobalAgentsContent,
  onSetGlobalConfigContent,
  onBrowseCodex,
  onBrowseCodexHome,
  onSaveCodexSettings,
  onReconnectCodexHomeWorkspaces,
  onRunDoctor,
  onRunCodexUpdate,
  onRefreshCodexStatus,
  onRefreshCodexSyncDiagnostics,
  onRefreshMcpStatus,
  onRefreshComputerControlStatus,
  onRefreshGlobalAgents,
  onSaveGlobalAgents,
  onRefreshGlobalConfig,
  onSaveGlobalConfig,
}: SettingsCodexSectionProps) {
  const { language, t } = useI18n();
  const loadingLabel = t("common.loading");
  const refreshLabel = t("common.refresh");
  const saveLabel = t("common.save");
  const savingLabel = t("common.saving");
  const unknownLabel = t("common.unknown");
  const foundLabel = t("settings.codex.found");
  const notFoundLabel = t("settings.codex.notFound");
  const okLabel = t("settings.codex.ok");
  const failedLabel = t("settings.codex.failed");
  const computerControlAvailabilityLabel = (
    availability: ComputerControlAvailability,
  ) => {
    switch (availability) {
      case "ready":
        return t("settings.codex.computerControlReady");
      case "missing":
        return t("settings.codex.computerControlMissing");
      case "failed":
        return t("settings.codex.computerControlFailed");
      case "unsupported":
        return t("settings.codex.computerControlUnsupported");
      default:
        return t("settings.codex.computerControlUnknown");
    }
  };
  const latestModelSlug = defaultModels[0]?.model ?? null;
  const savedModelSlug = useMemo(
    () => coerceSavedModelSlug(appSettings.lastComposerModelId, defaultModels),
    [appSettings.lastComposerModelId, defaultModels],
  );
  const selectedModelSlug = savedModelSlug ?? latestModelSlug ?? "";
  const selectedModel = useMemo(
    () => defaultModels.find((model) => model.model === selectedModelSlug) ?? null,
    [defaultModels, selectedModelSlug],
  );
  const reasoningSupported = useMemo(
    () => getReasoningSupport(selectedModel),
    [selectedModel],
  );
  const reasoningOptions = useMemo(
    () => getReasoningOptions(selectedModel),
    [selectedModel],
  );
  const savedEffort = useMemo(
    () => normalizeEffortValue(appSettings.lastComposerReasoningEffort),
    [appSettings.lastComposerReasoningEffort],
  );
  const selectedEffort = useMemo(() => {
    if (!reasoningSupported) {
      return "";
    }
    if (savedEffort && reasoningOptions.includes(savedEffort)) {
      return savedEffort;
    }
    if (reasoningOptions.includes(DEFAULT_REASONING_EFFORT)) {
      return DEFAULT_REASONING_EFFORT;
    }
    const fallback = normalizeEffortValue(selectedModel?.defaultReasoningEffort);
    if (fallback && reasoningOptions.includes(fallback)) {
      return fallback;
    }
    return reasoningOptions[0] ?? "";
  }, [reasoningOptions, reasoningSupported, savedEffort, selectedModel]);
  const [keyProfileNameDraft, setKeyProfileNameDraft] = useState("");
  const [keyProfileGroupNameDraft, setKeyProfileGroupNameDraft] = useState("");
  const [keyProfileKeyDraft, setKeyProfileKeyDraft] = useState("");
  const [keyProfileKeyVisible, setKeyProfileKeyVisible] = useState(false);
  const [keyProfileNewApiAccessTokenDraft, setKeyProfileNewApiAccessTokenDraft] =
    useState("");
  const [keyProfileNewApiAccessTokenVisible, setKeyProfileNewApiAccessTokenVisible] =
    useState(false);
  const [keyProfileBaseUrlDraft, setKeyProfileBaseUrlDraft] = useState("");
  const [keyProfileProviderKindDraft, setKeyProfileProviderKindDraft] =
    useState<CodexKeyProfile["providerKind"]>("custom");
  const [keyProfileUsageProtocolDraft, setKeyProfileUsageProtocolDraft] =
    useState<NonNullable<CodexKeyProfile["usageProtocol"]>>("auto");
  const [keyProfileModelDraft, setKeyProfileModelDraft] = useState("");
  const [keyProfileContextWindowDraft, setKeyProfileContextWindowDraft] = useState("");
  const [keyProfileMaxOutputTokensDraft, setKeyProfileMaxOutputTokensDraft] = useState("");
  const [toolOutputTokenLimitDraft, setToolOutputTokenLimitDraft] = useState(
    appSettings.toolOutputTokenLimit == null ? "" : String(appSettings.toolOutputTokenLimit),
  );
  const [keyProfileUseGatewayDraft, setKeyProfileUseGatewayDraft] = useState(false);
  const [keyProfileSupportsThinkingDraft, setKeyProfileSupportsThinkingDraft] =
    useState(false);
  const [keyProfileSupportsReasoningEffortDraft, setKeyProfileSupportsReasoningEffortDraft] =
    useState(false);
  const [keyProfileModelFetchState, setKeyProfileModelFetchState] = useState<{
    status: "idle" | "loading" | "done" | "error";
    error: string | null;
  }>({ status: "idle", error: null });
  const [keyProfileFetchedModels, setKeyProfileFetchedModels] = useState<
    NonNullable<CodexKeyProfile["cachedModels"]>
  >([]);
  const [keyProfileFetchedAtMs, setKeyProfileFetchedAtMs] = useState<number | null>(null);
  const [providerSettingSaving, setProviderSettingSaving] = useState<
    "continuity" | "config-sync" | null
  >(null);
  const [providerSettingError, setProviderSettingError] = useState<string | null>(null);
  const [editingKeyProfileId, setEditingKeyProfileId] = useState<string | null>(null);
  const [windowsUiUpdateConfirmOpen, setWindowsUiUpdateConfirmOpen] = useState(false);
  const keyProfiles = appSettings.codexKeyProfiles ?? [];
  const selectedExecutionProfileId =
    profileIdFromSelection(appSettings.executionCredentialSelection) ??
    appSettings.activeCodexKeyProfileId;
  const selectedKeyProfile =
    keyProfiles.find((profile) => profile.id === selectedExecutionProfileId) ??
    keyProfiles.find((profile) => profile.id === appSettings.activeCodexKeyProfileId) ??
    keyProfiles.find((profile) =>
      sameSelection(selectionForProfileId(profile.id), appSettings.executionCredentialSelection),
    );
  const editingKeyProfile = editingKeyProfileId
    ? keyProfiles.find((profile) => profile.id === editingKeyProfileId) ?? null
    : null;
  const fetchedDraftModelOptions = mergeCodexProviderModels(
    editingKeyProfile?.cachedModels,
    keyProfileFetchedModels,
  );
  const draftModelOptions = mergeCodexProviderModels(
    fetchedDraftModelOptions,
    keyProfileModelDraft.trim()
      ? [{ id: keyProfileModelDraft.trim(), name: null, contextWindow: null }]
      : [],
  );
  const resolvedKeyProfileBaseUrl = resolveCodexProviderBaseUrl(
    keyProfileProviderKindDraft,
    keyProfileBaseUrlDraft,
  ) ?? "";
  const keyProfileGatewayRequired = keyProfileProviderKindDraft === "opencode";
  const keyProfileModelRequired = keyProfileProviderKindDraft === "opencode";
  const keyProfileDraftValid =
    keyProfileNameDraft.trim().length > 0 &&
    keyProfileKeyDraft.trim().length > 0 &&
    (!keyProfileModelRequired || keyProfileModelDraft.trim().length > 0) &&
    (!keyProfileUseGatewayDraft || resolvedKeyProfileBaseUrl.length > 0);

  const resetKeyProfileDrafts = () => {
    setEditingKeyProfileId(null);
    setKeyProfileNameDraft("");
    setKeyProfileGroupNameDraft("");
    setKeyProfileKeyDraft("");
    setKeyProfileKeyVisible(false);
    setKeyProfileNewApiAccessTokenDraft("");
    setKeyProfileNewApiAccessTokenVisible(false);
    setKeyProfileBaseUrlDraft("");
    setKeyProfileProviderKindDraft("custom");
    setKeyProfileUsageProtocolDraft("auto");
    setKeyProfileModelDraft("");
    setKeyProfileContextWindowDraft("");
    setKeyProfileMaxOutputTokensDraft("");
    setKeyProfileUseGatewayDraft(false);
    setKeyProfileSupportsThinkingDraft(false);
    setKeyProfileSupportsReasoningEffortDraft(false);
    setKeyProfileModelFetchState({ status: "idle", error: null });
    setKeyProfileFetchedModels([]);
    setKeyProfileFetchedAtMs(null);
  };

  const parsePositiveIntegerDraft = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  };

  const commitToolOutputTokenLimit = () => {
    const trimmed = toolOutputTokenLimitDraft.trim();
    const nextValue = parsePositiveIntegerDraft(toolOutputTokenLimitDraft);
    if (trimmed && nextValue === null) {
      setToolOutputTokenLimitDraft(
        appSettings.toolOutputTokenLimit == null
          ? ""
          : String(appSettings.toolOutputTokenLimit),
      );
      return;
    }
    if (nextValue === (appSettings.toolOutputTokenLimit ?? null)) {
      return;
    }
    void onUpdateAppSettings({
      ...appSettings,
      toolOutputTokenLimit: nextValue,
    });
  };

  const updateCodexKeySettings = (patch: Partial<AppSettings>) => {
    void onUpdateAppSettings({
      ...appSettings,
      ...patch,
    });
  };

  const updateProviderBehaviorSetting = async (
    setting: "continuity" | "config-sync",
  ) => {
    if (providerSettingSaving) {
      return;
    }
    setProviderSettingSaving(setting);
    setProviderSettingError(null);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        ...(setting === "continuity"
          ? {
              preserveSessionLibraryOnProviderSwitch:
                !appSettings.preserveSessionLibraryOnProviderSwitch,
            }
          : {
              syncProviderProfileToLocalConfig:
                !appSettings.syncProviderProfileToLocalConfig,
            }),
      });
    } catch {
      setProviderSettingError(t("settings.codex.providerSettingSaveFailed"));
    } finally {
      setProviderSettingSaving(null);
    }
  };

  const providerStaleReasonLabel = providerSessionDiagnostics
    ? {
        none: t("settings.codex.diagnosticsStaleNone"),
        "continuity-disabled": t(
          "settings.codex.diagnosticsStaleContinuityDisabled",
        ),
        "runtime-refresh-pending": t(
          "settings.codex.diagnosticsStaleRuntimeRefreshPending",
        ),
        "pagination-incomplete": t(
          "settings.codex.diagnosticsStalePaginationIncomplete",
        ),
        "snapshot-unavailable": t(
          "settings.codex.diagnosticsStaleSnapshotUnavailable",
        ),
        "snapshot-incomplete": t(
          "settings.codex.diagnosticsStaleSnapshotIncomplete",
        ),
        "verification-inconclusive": t(
          "settings.codex.diagnosticsStaleVerificationInconclusive",
        ),
      }[providerSessionDiagnostics.staleReason]
    : unknownLabel;
  const providerFallbackLabel = providerSessionDiagnostics
    ? {
        none: t("settings.codex.diagnosticsFallbackNone"),
        "runtime-authoritative": t(
          "settings.codex.diagnosticsFallbackRuntimeAuthoritative",
        ),
        "retained-previous-list": t(
          "settings.codex.diagnosticsFallbackRetainedList",
        ),
        "awaiting-runtime-list": t(
          "settings.codex.diagnosticsFallbackAwaitingList",
        ),
      }[providerSessionDiagnostics.fallback]
    : unknownLabel;

  const handleSelectKeyProfile = (profileId: string) => {
    if (profileId === "__codex_default__") {
      updateCodexKeySettings({
        activeCodexKeyProfileId: null,
        executionCredentialSelection: null,
      });
      return;
    }
    const selection = selectionForProfileId(profileId);
    updateCodexKeySettings({
      activeCodexKeyProfileId: profileId,
      executionCredentialSelection: selection,
    });
  };

  const handleAddKeyProfile = (activate: boolean) => {
    if (!keyProfileDraftValid) {
      return;
    }
    const profile: CodexKeyProfile = {
      id: createCodexKeyProfileId(),
      name: keyProfileNameDraft.trim(),
      providerKind: keyProfileProviderKindDraft ?? "custom",
      usageProtocol: keyProfileUsageProtocolDraft,
      newApiAccessToken: keyProfileNewApiAccessTokenDraft.trim() || null,
      keyEnvVar: DEFAULT_CODEX_KEY_ENV_VAR,
      key: keyProfileKeyDraft.trim(),
      baseUrlEnvVar: DEFAULT_CODEX_BASE_URL_ENV_VAR,
      baseUrl: resolvedKeyProfileBaseUrl || null,
      model: keyProfileModelDraft.trim() || null,
      contextWindow: parsePositiveIntegerDraft(keyProfileContextWindowDraft),
      maxOutputTokens: parsePositiveIntegerDraft(keyProfileMaxOutputTokensDraft),
      useGateway: keyProfileGatewayRequired || keyProfileUseGatewayDraft,
      supportsThinking:
        keyProfileSupportsThinkingDraft || keyProfileSupportsReasoningEffortDraft,
      supportsReasoningEffort: keyProfileSupportsReasoningEffortDraft,
      lastModelRefreshAtMs:
        keyProfileFetchedAtMs ??
        (editingKeyProfileId
          ? keyProfiles.find((existing) => existing.id === editingKeyProfileId)
              ?.lastModelRefreshAtMs ?? null
          : null),
      cachedModels:
        keyProfileFetchedModels.length > 0
          ? keyProfileFetchedModels
          : editingKeyProfileId
            ? keyProfiles.find((existing) => existing.id === editingKeyProfileId)
                ?.cachedModels ?? []
            : [],
      groupName: keyProfileGroupNameDraft.trim() || keyProfileNameDraft.trim(),
    };
    if (editingKeyProfileId) {
      const nextProfiles = keyProfiles.map((existing) =>
        existing.id === editingKeyProfileId ? { ...profile, id: existing.id } : existing,
      );
      const nextSelection = selectionForProfileId(editingKeyProfileId);
      updateCodexKeySettings({
        codexKeyProfiles: nextProfiles,
        codexProviders: profilesToProviders(nextProfiles),
        ...(activate
          ? {
              activeCodexKeyProfileId: editingKeyProfileId,
              executionCredentialSelection: nextSelection,
            }
          : {}),
      });
      resetKeyProfileDrafts();
      return;
    }
    const nextProfiles = [...keyProfiles, profile];
    const nextSelection = selectionForProfileId(profile.id);
    updateCodexKeySettings({
      codexKeyProfiles: nextProfiles,
      codexProviders: profilesToProviders(nextProfiles),
      ...(activate
        ? {
            activeCodexKeyProfileId: profile.id,
            executionCredentialSelection: nextSelection,
          }
        : {}),
    });
    resetKeyProfileDrafts();
  };

  const handleEditKeyProfile = (profile: CodexKeyProfile) => {
    setEditingKeyProfileId(profile.id);
    setKeyProfileNameDraft(profile.name);
    setKeyProfileGroupNameDraft(profile.groupName ?? profile.name);
    setKeyProfileKeyDraft(profile.key);
    setKeyProfileKeyVisible(false);
    setKeyProfileBaseUrlDraft(profile.baseUrl ?? "");
    setKeyProfileProviderKindDraft(profile.providerKind ?? "custom");
    setKeyProfileUsageProtocolDraft(profile.usageProtocol ?? "auto");
    setKeyProfileNewApiAccessTokenDraft(profile.newApiAccessToken ?? "");
    setKeyProfileNewApiAccessTokenVisible(false);
    setKeyProfileModelDraft(profile.model ?? "");
    setKeyProfileContextWindowDraft(
      profile.contextWindow == null ? "" : String(profile.contextWindow),
    );
    setKeyProfileMaxOutputTokensDraft(
      profile.maxOutputTokens == null ? "" : String(profile.maxOutputTokens),
    );
    setKeyProfileUseGatewayDraft(Boolean(profile.useGateway));
    setKeyProfileSupportsThinkingDraft(
      Boolean(profile.supportsThinking) || Boolean(profile.supportsReasoningEffort),
    );
    setKeyProfileSupportsReasoningEffortDraft(Boolean(profile.supportsReasoningEffort));
    setKeyProfileModelFetchState({ status: "idle", error: null });
    setKeyProfileFetchedModels(profile.cachedModels ?? []);
    setKeyProfileFetchedAtMs(profile.lastModelRefreshAtMs ?? null);
  };

  const handleFetchKeyProfileModels = async () => {
    if (!resolvedKeyProfileBaseUrl || !keyProfileKeyDraft.trim()) {
      setKeyProfileModelFetchState({
        status: "error",
        error: t("settings.codex.providerModelsNeedUrlAndKey"),
      });
      return;
    }
    setKeyProfileModelFetchState({ status: "loading", error: null });
    try {
      const models = await getProviderModels(
        resolvedKeyProfileBaseUrl,
        keyProfileKeyDraft.trim(),
      );
      const refreshedAt = Date.now();
      setKeyProfileFetchedModels((existing) =>
        mergeCodexProviderModels(existing, editingKeyProfile?.cachedModels, models),
      );
      setKeyProfileFetchedAtMs(refreshedAt);
      setKeyProfileModelFetchState({
        status: "done",
        error:
          models.length > 0
            ? null
            : t("settings.codex.providerModelsEmpty"),
      });
    } catch (error) {
      setKeyProfileModelFetchState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleDeleteKeyProfile = (profileId: string) => {
    const nextProfiles = keyProfiles.filter((profile) => profile.id !== profileId);
    const profileSelection = selectionForProfileId(profileId);
    const wasExecutionSelection =
      selectedExecutionProfileId === profileId ||
      sameSelection(appSettings.executionCredentialSelection, profileSelection);
    const wasUsageSelection = sameSelection(appSettings.usageCredentialSelection, profileSelection);
    updateCodexKeySettings({
      codexKeyProfiles: nextProfiles,
      codexProviders: profilesToProviders(nextProfiles),
      activeCodexKeyProfileId:
        appSettings.activeCodexKeyProfileId === profileId || wasExecutionSelection
          ? null
          : appSettings.activeCodexKeyProfileId,
      executionCredentialSelection: wasExecutionSelection
        ? null
        : appSettings.executionCredentialSelection,
      usageCredentialSelection: wasUsageSelection ? null : appSettings.usageCredentialSelection,
    });
    if (editingKeyProfileId === profileId) {
      resetKeyProfileDrafts();
    }
  };

  const didNormalizeDefaultsRef = useRef(false);
  useEffect(() => {
    setToolOutputTokenLimitDraft(
      appSettings.toolOutputTokenLimit == null ? "" : String(appSettings.toolOutputTokenLimit),
    );
  }, [appSettings.toolOutputTokenLimit]);

  useEffect(() => {
    if (didNormalizeDefaultsRef.current) {
      return;
    }
    if (!defaultModels.length) {
      return;
    }
    const savedRawModel = (appSettings.lastComposerModelId ?? "").trim();
    const savedRawEffort = (appSettings.lastComposerReasoningEffort ?? "").trim();
    const shouldNormalizeModel = savedRawModel.length === 0 || savedModelSlug === null;
    const shouldNormalizeEffort =
      reasoningSupported &&
      (savedRawEffort.length === 0 ||
        savedEffort === null ||
        !reasoningOptions.includes(savedEffort));
    if (!shouldNormalizeModel && !shouldNormalizeEffort) {
      didNormalizeDefaultsRef.current = true;
      return;
    }

    const next: AppSettings = {
      ...appSettings,
      lastComposerModelId: shouldNormalizeModel ? selectedModelSlug : appSettings.lastComposerModelId,
      lastComposerReasoningEffort: shouldNormalizeEffort
        ? selectedEffort
        : appSettings.lastComposerReasoningEffort,
    };
    didNormalizeDefaultsRef.current = true;
    void onUpdateAppSettings(next);
  }, [
    appSettings,
    defaultModels.length,
    onUpdateAppSettings,
    reasoningOptions,
    reasoningSupported,
    savedEffort,
    savedModelSlug,
    selectedModelSlug,
    selectedEffort,
  ]);

  return (
    <SettingsSection
      title={mode === "providers" ? t("settings.section.providers") : "Codex"}
      subtitle={
        mode === "providers" ? t("settings.codex.keyProfileHelp") : t("settings.codex.subtitle")
      }
    >
      {mode === "codex" ? (
        <>
      <div className="settings-field">
        <div className="settings-field-row settings-field-row-between">
          <div>
            <div className="settings-field-label">{t("settings.codex.localConfig")}</div>
            <div className="settings-help">
              {t("settings.codex.localConfigHelpPrefix")} <code>CODEX_HOME</code>
              {t("settings.codex.localConfigHelpSuffix")} <code>~/.codex</code>.
            </div>
          </div>
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={onRefreshCodexStatus}
            disabled={codexStatusState.status === "loading"}
          >
            {codexStatusState.status === "loading" ? loadingLabel : refreshLabel}
          </button>
        </div>
        {codexStatusState.error && (
          <div className="settings-help settings-help-error">
            {t("settings.codex.readFailed")}: {codexStatusState.error}
          </div>
        )}
        {codexStatusState.result && (
          <div className="settings-doctor ok">
            <div className="settings-doctor-title">
              {t("settings.codex.configLinked").replace(
                "{source}",
                codexStatusState.result.codexHomeSource,
              )}
            </div>
            <div className="settings-doctor-body">
              <div>CODEX_HOME: {codexStatusState.result.codexHomePath ?? t("settings.codex.unresolved")}</div>
              <div>
                config.toml:{" "}
                {codexStatusState.result.configExists ? foundLabel : notFoundLabel}
                {codexStatusState.result.configPath
                  ? ` (${codexStatusState.result.configPath})`
                  : ""}
              </div>
              <div>
                AGENTS.md:{" "}
                {codexStatusState.result.globalAgentsExists ? foundLabel : notFoundLabel}
                {codexStatusState.result.globalAgentsPath
                  ? ` (${codexStatusState.result.globalAgentsPath})`
                  : ""}
              </div>
              <div>
                {t("settings.codex.skillsCount")
                  .replace("{codex}", String(codexStatusState.result.codexSkillsCount))
                  .replace("{agents}", String(codexStatusState.result.agentsSkillsCount))}
              </div>
              <div>
                {t("settings.codex.defaultModel")}
                {t("settings.codex.labelSeparator")}
                {codexStatusState.result.model ??
                  (codexStatusState.result.modelError
                    ? t("settings.codex.readFailedShort")
                    : t("settings.codex.notSet"))}
              </div>
              {codexStatusState.result.modelError && (
                <div>{codexStatusState.result.modelError}</div>
              )}
            </div>
          </div>
        )}
        {!codexStatusState.result && codexStatusState.status === "loading" && (
          <div className="settings-help">{t("settings.codex.loadingLocalConfig")}</div>
        )}
      </div>

      <CodexSessionSharingStatus
        backendMode={appSettings.backendMode}
        state={codexSyncDiagnosticsState}
        onRefresh={onRefreshCodexSyncDiagnostics}
      />

      <div className="settings-divider" />

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="codex-path">
          {t("settings.codex.defaultPath")}
        </label>
        <div className="settings-field-row">
          <input
            id="codex-path"
            className="settings-input"
            value={codexPathDraft}
            placeholder="codex"
            onChange={(event) => onSetCodexPathDraft(event.target.value)}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void onBrowseCodex();
            }}
          >
            {t("common.browse")}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => onSetCodexPathDraft("")}
          >
            {t("settings.codex.usePath")}
          </button>
        </div>
        <div className="settings-help">{t("settings.codex.pathHelp")}</div>
        <label className="settings-field-label" htmlFor="codex-args">
          {t("settings.codex.defaultArgs")}
        </label>
        <div className="settings-field-row">
          <input
            id="codex-args"
            className="settings-input"
            value={codexArgsDraft}
            placeholder="--profile personal"
            onChange={(event) => onSetCodexArgsDraft(event.target.value)}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => onSetCodexArgsDraft("")}
          >
            {t("common.clear")}
          </button>
        </div>
        <div className="settings-help">
          {t("settings.codex.argsHelpPrefix")} <code>app-server</code>
          {t("settings.codex.argsHelpSuffix")}
        </div>
        <label className="settings-field-label" htmlFor="codex-home">
          CODEX_HOME
        </label>
        <div className="settings-field-row">
          <input
            id="codex-home"
            className="settings-input"
            value={codexHomeDraft}
            placeholder="%USERPROFILE%\\.codex"
            onChange={(event) => onSetCodexHomeDraft(event.target.value)}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void onBrowseCodexHome();
            }}
          >
            {t("common.browse")}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => onSetCodexHomeDraft("")}
          >
            {t("settings.codex.useDefault")}
          </button>
        </div>
        <div className="settings-help">
          {t("settings.codex.homeHelp")}
        </div>
        {codexHomeReconnectState.required && (
          <div className="settings-doctor">
            <div className="settings-doctor-title">
              CODEX_HOME 已更改，需要重连已连接项目后生效。
            </div>
            {codexHomeReconnectState.error && (
              <div className="settings-help settings-help-error">
                {codexHomeReconnectState.error}
              </div>
            )}
            <div className="settings-field-actions">
              <button
                type="button"
                className="primary settings-button-compact"
                onClick={() => {
                  void onReconnectCodexHomeWorkspaces();
                }}
                disabled={codexHomeReconnectState.status === "running"}
              >
                {codexHomeReconnectState.status === "running"
                  ? "重连中..."
                  : "重连已连接项目"}
              </button>
            </div>
          </div>
        )}
        <div className="settings-help">
          {t("settings.codex.sharedHelp")}
        </div>
        <div className="settings-help">
          {t("settings.codex.unsupportedArgsPrefix")}: <code>-m</code>/
          <code>--model</code>, <code>-a</code>/<code>--ask-for-approval</code>,{" "}
          <code>-s</code>/<code>--sandbox</code>, <code>--full-auto</code>,{" "}
          <code>--dangerously-bypass-approvals-and-sandbox</code>, <code>--oss</code>,{" "}
          <code>--local-provider</code> {t("common.and")} <code>--no-alt-screen</code>.
        </div>
        <div className="settings-field-actions">
          {codexDirty && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                void onSaveCodexSettings();
              }}
              disabled={isSavingSettings}
            >
              {isSavingSettings ? savingLabel : saveLabel}
            </button>
          )}
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              void onRunDoctor();
            }}
            disabled={doctorState.status === "running"}
          >
            <Stethoscope aria-hidden />
            {doctorState.status === "running"
              ? t("settings.codex.checking")
              : t("settings.codex.runDoctor")}
          </button>
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={() => {
              void onRunCodexUpdate();
            }}
            disabled={codexUpdateState.status === "running"}
            title={t("settings.codex.updateCodex")}
          >
            <Stethoscope aria-hidden />
            {codexUpdateState.status === "running"
              ? t("settings.codex.updating")
              : t("settings.codex.update")}
          </button>
        </div>

        {doctorState.result && (
          <div className={`settings-doctor ${doctorState.result.ok ? "ok" : "error"}`}>
            <div className="settings-doctor-title">
              {doctorState.result.ok
                ? t("settings.codex.doctorOk")
                : t("settings.codex.doctorIssue")}
            </div>
            <div className="settings-doctor-body">
              <div>
                Codex: {doctorState.result.resolvedCodexBin ?? doctorState.result.codexBin ?? "codex"}
              </div>
              <div>{t("settings.codex.version")}: {doctorState.result.version ?? unknownLabel}</div>
              <div>
                npm @openai/codex: {doctorState.result.npmGlobalCodexVersion ?? unknownLabel}
              </div>
              <div>App-server: {doctorState.result.appServerOk ? okLabel : failedLabel}</div>
              <div>
                Node:{" "}
                {doctorState.result.nodeOk
                  ? `${okLabel} (${doctorState.result.nodeVersion ?? unknownLabel})`
                  : t("settings.codex.missing")}
              </div>
              {doctorState.result.details && <div>{doctorState.result.details}</div>}
              {doctorState.result.nodeDetails && <div>{doctorState.result.nodeDetails}</div>}
              {doctorState.result.path && (
                <div className="settings-doctor-path">PATH: {doctorState.result.path}</div>
              )}
            </div>
          </div>
        )}

        {codexUpdateState.result && (
          <div
            className={`settings-doctor ${codexUpdateState.result.ok ? "ok" : "error"}`}
          >
            <div className="settings-doctor-title">
              {codexUpdateState.result.ok
                ? codexUpdateState.result.upgraded
                  ? t("settings.codex.updated")
                  : t("settings.codex.alreadyLatest")
                : t("settings.codex.updateFailed")}
            </div>
            <div className="settings-doctor-body">
              <div>{t("settings.codex.method")}: {codexUpdateState.result.method}</div>
              {codexUpdateState.result.package && (
                <div>{t("settings.codex.package")}: {codexUpdateState.result.package}</div>
              )}
              <div>
                {t("settings.codex.version")}:{" "}
                {codexUpdateState.result.afterVersion ??
                  codexUpdateState.result.beforeVersion ??
                  unknownLabel}
              </div>
              {codexUpdateState.result.details && <div>{codexUpdateState.result.details}</div>}
              {codexUpdateState.result.output && (
                <details>
                  <summary>{t("settings.codex.output")}</summary>
                  <pre>{codexUpdateState.result.output}</pre>
                </details>
              )}
            </div>
          </div>
        )}
      </div>

        </>
      ) : null}
      {mode === "providers" ? (
      <div className="settings-field">
        <div className="settings-field-label settings-field-label--section">
          {t("settings.codex.providerBehavior")}
        </div>
        <SettingsToggleRow
          title={t("settings.codex.preserveSessionLibrary")}
          subtitle={t("settings.codex.preserveSessionLibraryHelp")}
        >
          <SettingsToggleSwitch
            pressed={appSettings.preserveSessionLibraryOnProviderSwitch}
            disabled={providerSettingSaving !== null}
            data-button-elevation="none"
            aria-label={t("settings.codex.preserveSessionLibrary")}
            onClick={() => void updateProviderBehaviorSetting("continuity")}
          />
        </SettingsToggleRow>
        <SettingsToggleRow
          title={t("settings.codex.syncProviderToLocalConfig")}
          subtitle={t("settings.codex.syncProviderToLocalConfigHelp")}
        >
          <SettingsToggleSwitch
            pressed={appSettings.syncProviderProfileToLocalConfig}
            disabled={providerSettingSaving !== null}
            data-button-elevation="none"
            aria-label={t("settings.codex.syncProviderToLocalConfig")}
            onClick={() => void updateProviderBehaviorSetting("config-sync")}
          />
        </SettingsToggleRow>
        {providerSettingError ? (
          <div className="settings-help settings-help-error" role="alert">
            {providerSettingError}
          </div>
        ) : null}
        <div className="settings-divider" />
        <div className="settings-field-label">
          {t("settings.codex.keyProfile")}
        </div>
        <div className="settings-help">
          {t("settings.codex.keyProfileHelp")}
        </div>
        <div className="settings-provider-profile-list">
          <button
            type="button"
            className={`settings-provider-profile ${selectedKeyProfile ? "" : "is-active"}`}
            onClick={() => handleSelectKeyProfile("__codex_default__")}
            aria-pressed={!selectedKeyProfile}
          >
            <span className="settings-provider-profile-copy">
              <span className="settings-provider-profile-name">
                {t("settings.codex.defaultEnvVars")}
              </span>
              <span className="settings-provider-profile-url">
                {t("settings.codex.defaultConfigSource")}
              </span>
            </span>
            <span className="settings-provider-profile-status">
              {!selectedKeyProfile ? <Check size={13} aria-hidden="true" /> : null}
              {t(selectedKeyProfile ? "settings.codex.profileDisabled" : "settings.codex.profileEnabled")}
            </span>
          </button>
          {keyProfiles.map((profile) => {
            const isActive = profile.id === selectedKeyProfile?.id;
            const profileUrl = resolveCodexProviderBaseUrl(
              profile.providerKind,
              profile.baseUrl ?? "",
            );
            return (
              <div
                key={profile.id}
                className={`settings-provider-profile-shell ${isActive ? "is-active" : ""}`}
              >
                <button
                  type="button"
                  className="settings-provider-profile settings-provider-profile--managed"
                  onClick={() => handleSelectKeyProfile(profile.id)}
                  aria-pressed={isActive}
                >
                  <span className="settings-provider-profile-copy">
                    <span className="settings-provider-profile-name">{profile.name}</span>
                    <span className="settings-provider-profile-url">
                      {profileUrl || t("settings.codex.providerUrlNotSet")}
                    </span>
                  </span>
                  <span className="settings-provider-profile-status">
                    {isActive ? <Check size={13} aria-hidden="true" /> : null}
                    {t(isActive ? "settings.codex.profileEnabled" : "settings.codex.profileDisabled")}
                  </span>
                </button>
                <div className="settings-provider-profile-actions">
                  <button
                    type="button"
                    className="ghost settings-provider-profile-action"
                    onClick={() => handleEditKeyProfile(profile)}
                    aria-label={`${t("common.edit")} ${profile.name}`}
                    title={t("common.edit")}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="ghost settings-provider-profile-action"
                    onClick={() => handleDeleteKeyProfile(profile.id)}
                    aria-label={`${t("common.delete")} ${profile.name}`}
                    title={t("common.delete")}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {selectedKeyProfile && (
          <div className="settings-help settings-provider-profile-injection">
            {t("settings.codex.currentInject")} <code>{DEFAULT_CODEX_KEY_ENV_VAR}</code>
            {resolveCodexProviderBaseUrl(
              selectedKeyProfile.providerKind,
              selectedKeyProfile.baseUrl ?? "",
            ) ? (
              <>
                {" "}
                {t("common.and")} <code>{DEFAULT_CODEX_BASE_URL_ENV_VAR}</code>
              </>
            ) : null}
            .
          </div>
        )}
        <div className="settings-key-profile-grid">
          <input
            className="settings-input"
            placeholder={t("settings.codex.keyProfileNamePlaceholder")}
            value={keyProfileNameDraft}
            onChange={(event) => setKeyProfileNameDraft(event.target.value)}
            aria-label={t("settings.codex.keyProfileNameAria")}
          />
          <select
            className="settings-select"
            value={keyProfileProviderKindDraft ?? "custom"}
            aria-label={t("settings.codex.providerKindAria")}
            onChange={(event) => {
              const providerKind = event.target.value as CodexKeyProfile["providerKind"];
              setKeyProfileProviderKindDraft(providerKind);
              if (!keyProfileBaseUrlDraft.trim()) {
                setKeyProfileBaseUrlDraft(
                  resolveCodexProviderBaseUrl(providerKind, null) ?? "",
                );
              }
              if (providerKind === "opencode") {
                setKeyProfileUseGatewayDraft(true);
              }
            }}
          >
            <option value="custom">{t("settings.codex.providerKindCustom")}</option>
            <option value="openai">{t("settings.codex.providerKindOpenai")}</option>
            <option value="deepseek">{t("settings.codex.providerKindDeepseek")}</option>
            <option value="openrouter">{t("settings.codex.providerKindOpenrouter")}</option>
            <option value="opencode">{t("settings.codex.providerKindOpencode")}</option>
          </select>
          <select
            className="settings-select"
            value={keyProfileUsageProtocolDraft}
            aria-label={t("settings.codex.usageProtocolAria")}
            onChange={(event) =>
              setKeyProfileUsageProtocolDraft(
                event.target.value as NonNullable<CodexKeyProfile["usageProtocol"]>,
              )
            }
          >
            <option value="auto">{t("settings.codex.usageProtocolAuto")}</option>
            <option value="sub2">{t("settings.codex.usageProtocolSub2")}</option>
            <option value="new-api">{t("settings.codex.usageProtocolNewApi")}</option>
            <option value="disabled">{t("settings.codex.usageProtocolDisabled")}</option>
          </select>
          <input
            className="settings-input"
            placeholder={t("settings.codex.keyProfileGroupNamePlaceholder")}
            value={keyProfileGroupNameDraft}
            onChange={(event) => setKeyProfileGroupNameDraft(event.target.value)}
            aria-label={t("settings.codex.keyProfileGroupNameAria")}
          />
          <div className="settings-field-row">
            <input
              className="settings-input"
              type={keyProfileKeyVisible ? "text" : "password"}
              placeholder={t("settings.codex.apiKeyPlaceholder")}
              value={keyProfileKeyDraft}
              onChange={(event) => setKeyProfileKeyDraft(event.target.value)}
              aria-label={t("settings.codex.apiKeyAria")}
            />
            <button
              type="button"
              className="ghost settings-button-compact"
              onClick={() => setKeyProfileKeyVisible((visible) => !visible)}
            >
              {keyProfileKeyVisible ? t("common.hide") : t("common.show")}
            </button>
          </div>
          {keyProfileUsageProtocolDraft === "auto" ||
          keyProfileUsageProtocolDraft === "new-api" ? (
            <div className="settings-key-profile-secret">
              <div className="settings-field-row">
                <input
                  className="settings-input"
                  type={keyProfileNewApiAccessTokenVisible ? "text" : "password"}
                  placeholder={t("settings.codex.newApiAccessTokenPlaceholder")}
                  value={keyProfileNewApiAccessTokenDraft}
                  onChange={(event) =>
                    setKeyProfileNewApiAccessTokenDraft(event.target.value)
                  }
                  aria-label={t("settings.codex.newApiAccessTokenAria")}
                />
                <button
                  type="button"
                  className="ghost settings-button-compact"
                  onClick={() =>
                    setKeyProfileNewApiAccessTokenVisible((visible) => !visible)
                  }
                >
                  {keyProfileNewApiAccessTokenVisible
                    ? t("common.hide")
                    : t("common.show")}
                </button>
              </div>
              <div className="settings-help">
                {t("settings.codex.newApiAccessTokenHelp")}
              </div>
            </div>
          ) : null}
          <input
            className="settings-input"
            placeholder={t("settings.codex.baseUrlPlaceholder")}
            value={keyProfileBaseUrlDraft}
            onChange={(event) => setKeyProfileBaseUrlDraft(event.target.value)}
            aria-label={t("settings.codex.baseUrlAria")}
          />
          <div className="settings-field-row">
            {fetchedDraftModelOptions.length > 0 ? (
              <select
                className="settings-select"
                value={keyProfileModelDraft}
                onChange={(event) => setKeyProfileModelDraft(event.target.value)}
                aria-label={t("settings.codex.providerModelAria")}
              >
                <option value="">{t("settings.codex.providerModelPlaceholder")}</option>
                {draftModelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name ?? model.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="settings-input"
                placeholder={t("settings.codex.providerModelPlaceholder")}
                value={keyProfileModelDraft}
                onChange={(event) => setKeyProfileModelDraft(event.target.value)}
                aria-label={t("settings.codex.providerModelAria")}
              />
            )}
            <button
              type="button"
              className="ghost settings-button-compact"
              disabled={keyProfileModelFetchState.status === "loading"}
              onClick={handleFetchKeyProfileModels}
            >
              {keyProfileModelFetchState.status === "loading"
                ? t("common.loading")
                : t("settings.codex.fetchProviderModels")}
            </button>
          </div>
          {keyProfileModelRequired && !keyProfileModelDraft.trim() ? (
            <div className="settings-help settings-help-error">
              {t("settings.codex.opencodeModelRequired")}
            </div>
          ) : null}
          {keyProfileModelFetchState.error ? (
            <div className="settings-help settings-help-error">
              {keyProfileModelFetchState.error}
            </div>
          ) : null}
          {(keyProfileFetchedAtMs ?? editingKeyProfile?.lastModelRefreshAtMs) ? (
            <div className="settings-help">
              {t("settings.codex.providerModelsLastRefresh")}:{" "}
              {new Date(
                keyProfileFetchedAtMs ?? editingKeyProfile?.lastModelRefreshAtMs ?? 0,
              ).toLocaleString()}
            </div>
          ) : null}
          <input
            className="settings-input"
            type="number"
            min="1"
            step="1"
            placeholder={t("settings.codex.contextWindowPlaceholder")}
            value={keyProfileContextWindowDraft}
            onChange={(event) => setKeyProfileContextWindowDraft(event.target.value)}
            aria-label={t("settings.codex.contextWindowAria")}
          />
          <input
            className="settings-input"
            type="number"
            min="1"
            step="1"
            placeholder={t("settings.codex.maxOutputTokensPlaceholder")}
            value={keyProfileMaxOutputTokensDraft}
            onChange={(event) => setKeyProfileMaxOutputTokensDraft(event.target.value)}
            aria-label={t("settings.codex.maxOutputTokensAria")}
          />
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={keyProfileGatewayRequired || keyProfileUseGatewayDraft}
              disabled={keyProfileGatewayRequired}
              onChange={(event) => setKeyProfileUseGatewayDraft(event.target.checked)}
            />
            <span>{t("settings.codex.useGateway")}</span>
          </label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={keyProfileSupportsThinkingDraft}
              onChange={(event) => {
                const checked = event.target.checked;
                setKeyProfileSupportsThinkingDraft(checked);
                if (!checked) {
                  setKeyProfileSupportsReasoningEffortDraft(false);
                }
              }}
            />
            <span>{t("settings.codex.supportsThinking")}</span>
          </label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={keyProfileSupportsReasoningEffortDraft}
              onChange={(event) => {
                const checked = event.target.checked;
                setKeyProfileSupportsReasoningEffortDraft(checked);
                if (checked) {
                  setKeyProfileSupportsThinkingDraft(true);
                }
              }}
            />
            <span>{t("settings.codex.supportsReasoningEffort")}</span>
          </label>
          {keyProfileGatewayRequired ? (
            <div className="settings-help">
              {t("settings.codex.opencodeGatewayRequired")}
            </div>
          ) : null}
          {keyProfileUseGatewayDraft && !resolvedKeyProfileBaseUrl ? (
            <div className="settings-help settings-help-error">
              {t("settings.codex.gatewayBaseUrlRequired")}
            </div>
          ) : null}
          <button
            type="button"
            className="ghost settings-button-compact"
            disabled={!keyProfileDraftValid}
            onClick={() => handleAddKeyProfile(false)}
          >
            {saveLabel}
          </button>
          <button
            type="button"
            className="ghost settings-button-compact"
            disabled={!keyProfileDraftValid}
            onClick={() => handleAddKeyProfile(true)}
          >
            {t("settings.codex.saveAndEnable")}
          </button>
          {editingKeyProfileId ? (
            <button
              type="button"
              className="ghost settings-button-compact"
              onClick={() => {
                resetKeyProfileDrafts();
              }}
            >
              {t("common.cancel")}
            </button>
          ) : null}
        </div>
        <div className="settings-divider" />
        <details className="settings-provider-diagnostics">
          <summary className="settings-provider-diagnostics-title">
            {t("settings.codex.providerDiagnostics")}
          </summary>
          <div className="settings-help">
            {t("settings.codex.providerDiagnosticsHelp")}
          </div>
          <dl className="settings-provider-diagnostics-grid">
            <div>
              <dt>{t("settings.codex.diagnosticsWorkspace")}</dt>
              <dd>
                {providerSessionDiagnostics?.workspaceName ??
                  t("settings.codex.diagnosticsUnavailable")}
              </dd>
            </div>
            <div>
              <dt>{t("settings.codex.diagnosticsProvider")}</dt>
              <dd>
                {providerSessionDiagnostics
                  ? `${
                      providerSessionDiagnostics.providerName ??
                      t("settings.codex.diagnosticsDefaultProvider")
                    } (${providerSessionDiagnostics.providerKind})`
                  : t("settings.codex.diagnosticsUnavailable")}
              </dd>
            </div>
            <div>
              <dt>{t("settings.codex.diagnosticsSessionSource")}</dt>
              <dd>
                <code>
                  {providerSessionDiagnostics?.sessionSourceId ??
                    t("settings.codex.diagnosticsUnavailable")}
                </code>
              </dd>
            </div>
            <div>
              <dt>{t("settings.codex.diagnosticsRuntimeGeneration")}</dt>
              <dd>
                {providerSessionDiagnostics?.runtimeGeneration ??
                  t("settings.codex.diagnosticsUnavailable")}
              </dd>
            </div>
            <div>
              <dt>{t("settings.codex.diagnosticsListGeneration")}</dt>
              <dd>
                {providerSessionDiagnostics?.listGeneration ??
                  t("settings.codex.diagnosticsUnavailable")}
              </dd>
            </div>
            <div>
              <dt>{t("settings.codex.diagnosticsStaleReason")}</dt>
              <dd>{providerStaleReasonLabel}</dd>
            </div>
            <div>
              <dt>{t("settings.codex.diagnosticsStaleThreads")}</dt>
              <dd>{providerSessionDiagnostics?.staleThreadCount ?? 0}</dd>
            </div>
            <div>
              <dt>{t("settings.codex.diagnosticsFallback")}</dt>
              <dd>{providerFallbackLabel}</dd>
            </div>
          </dl>
        </details>
      </div>
      ) : null}
      {mode === "codex" ? (
        <>
      <div className="settings-divider" />
      <div className="settings-field-label settings-field-label--section">
        {t("settings.codex.defaultParameters")}
      </div>
      <SettingsToggleRow
        title={
          <label htmlFor="default-model">
            {t("settings.codex.model")}
          </label>
        }
        subtitle={
          defaultModelsConnectedWorkspaceCount === 0
            ? t("settings.codex.modelsNeedProject")
            : defaultModelsLoading
              ? t("settings.codex.modelsLoading")
              : defaultModelsError
                ? `${t("settings.codex.modelsLoadFailed")}: ${defaultModelsError}`
                : t("settings.codex.modelsHelp")
        }
      >
        <div className="settings-field-row">
          <select
            id="default-model"
            className="settings-select"
            value={selectedModelSlug}
            disabled={!defaultModels.length || defaultModelsLoading}
            onChange={(event) =>
              void onUpdateAppSettings({
                ...appSettings,
                lastComposerModelId: event.target.value,
              })
            }
            aria-label={t("settings.codex.model")}
          >
            {defaultModels.map((model) => (
              <option key={model.model} value={model.model}>
                {model.displayName?.trim() || model.model}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ghost"
            onClick={onRefreshDefaultModels}
            disabled={defaultModelsLoading || defaultModelsConnectedWorkspaceCount === 0}
          >
            {refreshLabel}
          </button>
        </div>
      </SettingsToggleRow>

      <SettingsToggleRow
        title={
          <label htmlFor="token-efficiency-mode">
            {t("settings.codex.tokenEfficiency")}
          </label>
        }
        subtitle={t("settings.codex.tokenEfficiencyHelp")}
      >
        <select
          id="token-efficiency-mode"
          className="settings-select"
          value={appSettings.tokenEfficiencyMode ?? "quality"}
          onChange={(event) =>
            void onUpdateAppSettings({
              ...appSettings,
              tokenEfficiencyMode: event.target
                .value as AppSettings["tokenEfficiencyMode"],
            })
          }
          aria-label={t("settings.codex.tokenEfficiency")}
        >
          <option value="quality">{t("settings.codex.tokenEfficiencyQuality")}</option>
          <option value="balanced">{t("settings.codex.tokenEfficiencyBalanced")}</option>
          <option value="economy">{t("settings.codex.tokenEfficiencyEconomy")}</option>
        </select>
      </SettingsToggleRow>

      <SettingsToggleRow
        title={
          <label htmlFor="tool-output-token-limit">
            {t("settings.codex.toolOutputTokenLimit")}
          </label>
        }
        subtitle={t("settings.codex.toolOutputTokenLimitHelp")}
      >
        <input
          id="tool-output-token-limit"
          className="settings-input"
          type="number"
          min="1"
          step="1"
          placeholder={t("settings.codex.toolOutputTokenLimitDefault")}
          value={toolOutputTokenLimitDraft}
          onChange={(event) => setToolOutputTokenLimitDraft(event.target.value)}
          onBlur={commitToolOutputTokenLimit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          aria-label={t("settings.codex.toolOutputTokenLimit")}
        />
      </SettingsToggleRow>

      <SettingsToggleRow
        title={
          <label htmlFor="default-effort">
            {t("settings.codex.reasoningEffort")}
          </label>
        }
        subtitle={
          reasoningSupported
            ? t("settings.codex.reasoningHelp")
            : t("settings.codex.reasoningUnsupportedHelp")
        }
      >
        <select
          id="default-effort"
          className="settings-select"
          value={selectedEffort}
          onChange={(event) =>
            void onUpdateAppSettings({
              ...appSettings,
              lastComposerReasoningEffort: event.target.value,
            })
          }
          aria-label={t("settings.codex.reasoningEffort")}
          disabled={!reasoningSupported}
        >
          {!reasoningSupported && <option value="">{t("settings.codex.unsupported")}</option>}
          {reasoningOptions.map((effort) => (
            <option key={effort} value={effort}>
              {formatReasoningEffortLabel(effort)}
            </option>
          ))}
        </select>
      </SettingsToggleRow>

      <SettingsToggleRow
        title={
          <label htmlFor="default-access">
            {t("settings.codex.accessMode")}
          </label>
        }
        subtitle={t("settings.codex.noSessionOverrideHelp")}
      >
        <select
          id="default-access"
          className="settings-select"
          value={appSettings.defaultAccessMode}
          onChange={(event) =>
            void onUpdateAppSettings({
              ...appSettings,
              defaultAccessMode: event.target.value as AppSettings["defaultAccessMode"],
            })
          }
        >
          <option value="read-only">{t("settings.codex.accessReadOnly")}</option>
          <option value="current">{t("settings.codex.accessCurrent")}</option>
          <option value="full-access">{t("settings.codex.accessFull")}</option>
        </select>
      </SettingsToggleRow>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="review-delivery">
          {t("settings.codex.reviewMode")}
        </label>
        <select
          id="review-delivery"
          className="settings-select"
          value={appSettings.reviewDeliveryMode}
          onChange={(event) =>
            void onUpdateAppSettings({
              ...appSettings,
              reviewDeliveryMode: event.target.value as AppSettings["reviewDeliveryMode"],
            })
          }
        >
          <option value="inline">{t("settings.codex.reviewInline")}</option>
          <option value="detached">{t("settings.codex.reviewDetached")}</option>
        </select>
        <div className="settings-help">
          {t("settings.codex.reviewHelpPrefix")} <code>/review</code>{" "}
          {t("settings.codex.reviewHelpSuffix")}
        </div>
      </div>

      <FileEditorCard
        title="Global AGENTS.md"
        meta={globalAgentsMeta}
        error={globalAgentsError}
        value={globalAgentsContent}
        placeholder={t("settings.codex.globalAgentsPlaceholder")}
        disabled={globalAgentsLoading}
        refreshDisabled={globalAgentsRefreshDisabled}
        saveDisabled={globalAgentsSaveDisabled}
        saveLabel={globalAgentsSaveLabel}
        onChange={onSetGlobalAgentsContent}
        onRefresh={onRefreshGlobalAgents}
        onSave={onSaveGlobalAgents}
        helpText={
          <>
            {t("settings.codex.savedIn")} <code>~/.codex/AGENTS.md</code>.
          </>
        }
        classNames={{
          container: "settings-field settings-agents",
          header: "settings-agents-header",
          title: "settings-field-label",
          actions: "settings-agents-actions",
          meta: "settings-help settings-help-inline",
          iconButton: "ghost settings-icon-button",
          error: "settings-agents-error",
          textarea: "settings-agents-textarea",
          help: "settings-help",
        }}
      />

      <div className="settings-field">
        <div className="settings-field-label settings-field-label--section">
          MCP
        </div>
        <div className="settings-help">
          {t("settings.codex.mcpHelpPrefix")}{" "}
          <code>Global config.toml</code> {t("settings.codex.mcpHelpMiddle")}{" "}
          <code>[mcp_servers.&lt;name&gt;]</code>; {t("settings.codex.mcpHelpSuffix")}{" "}
          <code>.codex/config.toml</code>.
        </div>
        <div className="settings-help">
          {t("settings.codex.mcpCommandHelpPrefix")} <code>/mcp</code>{" "}
          {t("settings.codex.mcpCommandHelpMiddle")}{" "}
          <code>codex mcp login &lt;server&gt;</code>.
        </div>
        <div className="settings-computer-control">
          <div className="settings-computer-control-header">
            <div className="settings-computer-control-heading">
              <div className="settings-field-label">
                {t("settings.codex.computerControlTitle")}
              </div>
              <div className="settings-help">
                {t("settings.codex.computerControlHelp")}
              </div>
            </div>
            <button
              type="button"
              className="ghost settings-button-compact"
              onClick={onRefreshComputerControlStatus}
              disabled={computerControlStatusState.status === "loading"}
            >
              {computerControlStatusState.status === "loading"
                ? loadingLabel
                : refreshLabel}
            </button>
          </div>
          <SettingsToggleRow
            className="settings-computer-control-toggle"
            title={t("settings.codex.computerControlRouting")}
            subtitle={t("settings.codex.computerControlRoutingHelp")}
          >
            <SettingsToggleSwitch
              pressed={appSettings.computerControlRoutingEnabled !== false}
              aria-label={t("settings.codex.computerControlRouting")}
              onClick={() =>
                void onUpdateAppSettings({
                  ...appSettings,
                  computerControlRoutingEnabled:
                    appSettings.computerControlRoutingEnabled === false,
                })
              }
            />
          </SettingsToggleRow>
          {computerControlStatusState.error && (
            <div className="settings-help settings-help-error">
              {t("settings.codex.computerControlReadFailed")}: {" "}
              {computerControlStatusState.error === "settings.codex.mcpNeedsWorkspace"
                ? t("settings.codex.mcpNeedsWorkspace")
                : computerControlStatusState.error}
            </div>
          )}
          {computerControlStatusState.result && (
            <>
              <dl
                className="settings-computer-control-status"
                aria-label={t("settings.codex.computerControlStatus")}
              >
                {[
                  [
                    "windows_ui",
                    t("settings.codex.computerControlNativeWindows"),
                  ],
                  [
                    "chrome",
                    t("settings.codex.computerControlSignedInWeb"),
                  ],
                  [
                    "browser",
                    t("settings.codex.computerControlIsolatedWeb"),
                  ],
                ].map(([backend, label]) => {
                  const capability =
                    computerControlStatusState.result?.backends[
                      backend as "windows_ui" | "chrome" | "browser"
                    ];
                  if (!capability) {
                    return null;
                  }
                  return (
                    <div key={backend} className="settings-computer-control-status-row">
                      <dt>{label}</dt>
                      <dd data-status={capability.availability}>
                        {computerControlAvailabilityLabel(capability.availability)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <div className="settings-computer-control-meta">
                <span>
                  {computerControlStatusState.result.executionHost.startsWith("remote:")
                    ? t("settings.codex.computerControlHostRemote")
                    : t("settings.codex.computerControlHostLocal")}
                  {computerControlStatusState.workspaceName
                    ? ` · ${computerControlStatusState.workspaceName}`
                    : ""}
                </span>
                <span>
                  {t("settings.codex.computerControlLastChecked")}: {" "}
                  {new Date(
                    computerControlStatusState.result.observedAtMs,
                  ).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}
                </span>
              </div>
            </>
          )}
          <div className="settings-windows-ui-update">
            <SettingsToggleRow
              className="settings-computer-control-toggle"
              title={t("settings.codex.windowsUiAutoCheck")}
              subtitle={t("settings.codex.windowsUiAutoCheckHelp")}
            >
              <SettingsToggleSwitch
                pressed={appSettings.automaticWindowsUiUpdateChecksEnabled}
                aria-label={t("settings.codex.windowsUiAutoCheck")}
                onClick={() =>
                  void onUpdateAppSettings({
                    ...appSettings,
                    automaticWindowsUiUpdateChecksEnabled:
                      !appSettings.automaticWindowsUiUpdateChecksEnabled,
                  })
                }
              />
            </SettingsToggleRow>
            <div className="settings-windows-ui-update-row">
              <div className="settings-windows-ui-update-summary">
                <div className="settings-field-label">
                  {t("settings.codex.windowsUiUpdateTitle")}
                </div>
                <div
                  className={`settings-help${
                    windowsUiUpdater.state.stage === "error"
                      ? " settings-help-error"
                      : ""
                  }`}
                >
                  {windowsUiUpdater.state.stage === "idle"
                    ? appSettings.backendMode === "remote"
                      ? t("settings.codex.windowsUiUpdateRemoteUnsupported")
                      : t("settings.codex.windowsUiUpdateIdle")
                    : windowsUiUpdater.state.stage === "checking"
                      ? t("settings.codex.windowsUiUpdateChecking")
                      : windowsUiUpdater.state.stage === "unsupported"
                        ? windowsUiUpdater.state.check?.reasonCode === "remoteExecutionHost"
                          ? t("settings.codex.windowsUiUpdateRemoteUnsupported")
                          : t("settings.codex.windowsUiUpdatePlatformUnsupported")
                        : windowsUiUpdater.state.stage === "unmanaged"
                          ? t("settings.codex.windowsUiUpdateUnmanaged")
                          : windowsUiUpdater.state.stage === "upToDate"
                            ? `${t("settings.codex.windowsUiUpdateCurrent")} ${
                                windowsUiUpdater.state.check?.currentVersion ?? "-"
                              } · ${t("settings.codex.windowsUiUpdateLatest")}`
                            : windowsUiUpdater.state.stage === "available"
                              ? windowsUiUpdater.state.check?.installed
                                ? `${t("settings.codex.windowsUiUpdateCurrent")} ${
                                    windowsUiUpdater.state.check.currentVersion ?? "-"
                                  } · ${t("settings.codex.windowsUiUpdateAvailable")} ${
                                    windowsUiUpdater.state.check.release?.version ?? "-"
                                  }`
                                : `${t("settings.codex.windowsUiUpdateNotInstalled")} · ${
                                    t("settings.codex.windowsUiUpdateAvailable")
                                  } ${windowsUiUpdater.state.check?.release?.version ?? "-"}`
                              : windowsUiUpdater.state.stage === "downloading"
                                ? `${t("settings.codex.windowsUiUpdateDownloading")} ${
                                    windowsUiUpdater.state.progress?.totalBytes
                                      ? `${Math.round(
                                          ((windowsUiUpdater.state.progress.downloadedBytes ?? 0) /
                                            windowsUiUpdater.state.progress.totalBytes) *
                                            100,
                                        )}%`
                                      : ""
                                  }`
                                : windowsUiUpdater.state.stage === "installing"
                                  ? t("settings.codex.windowsUiUpdateVerifying")
                                  : windowsUiUpdater.state.stage === "restartRequired"
                                    ? `${t("settings.codex.windowsUiUpdateInstalled")} v${
                                        windowsUiUpdater.state.version ?? "-"
                                      } · ${t("settings.codex.windowsUiUpdateRestartNotice")}`
                                    : `${t("settings.codex.windowsUiUpdateFailed")}: ${
                                        windowsUiUpdater.state.error ?? t("common.unknown")
                                      }`}
                </div>
              </div>
              <div className="settings-windows-ui-update-actions">
                {windowsUiUpdater.state.stage === "available" ? (
                  <button
                    type="button"
                    className="primary settings-button-compact"
                    disabled={!windowsUiUpdater.enabled}
                    onClick={() => setWindowsUiUpdateConfirmOpen(true)}
                  >
                    {t("settings.codex.windowsUiUpdateInstall")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost settings-button-compact"
                    disabled={
                      !windowsUiUpdater.enabled ||
                      windowsUiUpdater.state.stage === "checking" ||
                      windowsUiUpdater.state.stage === "downloading" ||
                      windowsUiUpdater.state.stage === "installing"
                    }
                    onClick={() => void windowsUiUpdater.checkForUpdates()}
                  >
                    {windowsUiUpdater.state.stage === "checking"
                      ? t("settings.codex.windowsUiUpdateChecking")
                      : t("settings.codex.windowsUiUpdateCheck")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="settings-field-actions">
          <button
            type="button"
            className="ghost settings-button-compact"
            onClick={onRefreshMcpStatus}
            disabled={mcpStatusState.status === "loading"}
          >
            {mcpStatusState.status === "loading"
              ? loadingLabel
              : t("settings.codex.refreshMcpStatus")}
          </button>
        </div>
        {mcpStatusState.error && (
          <div className="settings-help settings-help-error">
            {t("settings.codex.mcpStatusReadFailed")}:{" "}
            {mcpStatusState.error === "settings.codex.mcpNeedsWorkspace"
              ? t("settings.codex.mcpNeedsWorkspace")
              : mcpStatusState.error}
          </div>
        )}
        {mcpStatusState.result !== null && (
          <div className="settings-doctor ok">
            <div className="settings-doctor-title">
              {t("settings.codex.mcpStatus")}
              {mcpStatusState.workspaceName ? ` (${mcpStatusState.workspaceName})` : ""}
            </div>
            <div className="settings-doctor-body">
              <pre>{JSON.stringify(mcpStatusState.result, null, 2)}</pre>
            </div>
          </div>
        )}
        <details className="settings-code-details">
          <summary>{t("settings.codex.configSnippet")}</summary>
          <pre>{`[mcp_servers.docs]
url = "https://example.com/mcp"

[mcp_servers.local]
command = "node"
args = ["server.mjs"]
# env = { API_KEY = "$MY_API_KEY" }`}</pre>
        </details>
      </div>

      <WindowsUiUpdatePrompt
        open={windowsUiUpdateConfirmOpen}
        version={windowsUiUpdater.state.check?.release?.version ?? null}
        assetSize={windowsUiUpdater.state.check?.release?.assetSize ?? null}
        assetSha256={windowsUiUpdater.state.check?.release?.assetSha256 ?? null}
        onCancel={() => setWindowsUiUpdateConfirmOpen(false)}
        onConfirm={() => {
          setWindowsUiUpdateConfirmOpen(false);
          void windowsUiUpdater.startInstall();
        }}
      />

      <FileEditorCard
        title="Global config.toml"
        meta={globalConfigMeta}
        error={globalConfigError}
        value={globalConfigContent}
        placeholder={t("settings.codex.globalConfigPlaceholder")}
        disabled={globalConfigLoading}
        refreshDisabled={globalConfigRefreshDisabled}
        saveDisabled={globalConfigSaveDisabled}
        saveLabel={globalConfigSaveLabel}
        onChange={onSetGlobalConfigContent}
        onRefresh={onRefreshGlobalConfig}
        onSave={onSaveGlobalConfig}
        helpText={
          <>
            {t("settings.codex.savedIn")} <code>~/.codex/config.toml</code>.
          </>
        }
        classNames={{
          container: "settings-field settings-agents",
          header: "settings-agents-header",
          title: "settings-field-label",
          actions: "settings-agents-actions",
          meta: "settings-help settings-help-inline",
          iconButton: "ghost settings-icon-button",
          error: "settings-agents-error",
          textarea: "settings-agents-textarea",
          help: "settings-help",
        }}
      />
        </>
      ) : null}
    </SettingsSection>
  );
}
