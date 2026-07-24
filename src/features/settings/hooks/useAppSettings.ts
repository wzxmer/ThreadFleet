import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings, CodexKeyProfile } from "@/types";
import { getAppSettings, runCodexDoctor, updateAppSettings } from "@services/tauri";
import { clampUiScale, UI_SCALE_DEFAULT } from "@utils/uiScale";
import { CHAT_SCROLLBACK_DEFAULT, normalizeChatHistoryScrollbackItems } from "@utils/chatScrollback";
import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_CJK_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_LATIN_FONT_FAMILY,
  CODE_FONT_SIZE_DEFAULT,
  clampCodeFontSize,
  clampMessageFontSize,
  clampProcessFontSize,
  clampMessageFontWeight,
  clampUiFontSize,
  clampUiFontWeight,
  MESSAGE_FONT_SIZE_DEFAULT,
  PROCESS_FONT_SIZE_DEFAULT,
  MESSAGE_FONT_WEIGHT_DEFAULT,
  normalizeFontFamily,
  normalizeUiCjkFontFamily,
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_WEIGHT_DEFAULT,
} from "@utils/fonts";
import {
  DEFAULT_OPEN_APP_ID,
  DEFAULT_OPEN_APP_TARGETS,
  OPEN_APP_STORAGE_KEY,
} from "@app/constants";
import { normalizeOpenAppTargets } from "@app/utils/openApp";
import { getDefaultInterruptShortcut, isMacPlatform } from "@utils/shortcuts";
import { isMobilePlatform } from "@utils/platformPaths";
import { DEFAULT_COMMIT_MESSAGE_PROMPT } from "@utils/commitMessagePrompt";
import {
  normalizeReasoningEffortValue,
  parseReasoningEffortOptions,
} from "@utils/reasoningEfforts";

const allowedThemes = new Set(["system", "light", "dark", "dim"]);
const allowedAppLanguages = new Set(["system", "zh", "en"]);
const allowedThemeAccents = new Set(["codex", "blue", "green", "pink", "orange"]);
const allowedMessageReadingStyles = new Set(["bubble", "native", "cli"]);
const allowedPersonality = new Set(["friendly", "pragmatic"]);
const allowedFollowUpMessageBehavior = new Set(["queue", "steer"]);
const allowedSubagentCheckpointSyncMode = new Set([
  "finalOnly",
  "checkpoints",
  "continuous",
]);
const allowedComposerSendShortcut = new Set([
  "enter",
  "ctrl-enter",
  "steer-priority",
]);
const allowedComposerTriggerMode = new Set(["default", "swap-slash-at"]);
const allowedTokenEfficiencyModes = new Set(["quality", "balanced", "economy"]);
const allowedWorkflowRuntimeModes = new Set(["off", "shadow", "active"]);
const DEFAULT_REMOTE_BACKEND_HOST = "127.0.0.1:4732";
const DEFAULT_REMOTE_BACKEND_ID = "remote-default";
const DEFAULT_REMOTE_BACKEND_NAME = "Primary remote";
const DEFAULT_REMOTE_PROVIDER: AppSettings["remoteBackendProvider"] = "tcp";
const DEFAULT_CODEX_KEY_ENV_VAR = "OPENAI_API_KEY";
const DEFAULT_CODEX_BASE_URL_ENV_VAR = "OPENAI_BASE_URL";
const allowedCodexProviderKinds = new Set([
  "openai",
  "deepseek",
  "openrouter",
  "opencode",
  "custom",
]);
const allowedProviderUsageProtocols = new Set<NonNullable<CodexKeyProfile["usageProtocol"]>>([
  "auto",
  "sub2",
  "new-api",
  "disabled",
]);
const DEFAULT_MESSAGE_USER_BUBBLE_COLOR = "#d9ebff";
const DEFAULT_MESSAGE_USER_TEXT_COLOR = "#102033";
const DEFAULT_MESSAGE_CANVAS_COLOR = "#eef1f6";
const DEFAULT_MESSAGE_ASSISTANT_BUBBLE_COLOR = "#f7f9fc";
const DEFAULT_MESSAGE_ASSISTANT_ACCENT_COLOR = "#8aa8d8";
const DEFAULT_MESSAGE_ASSISTANT_TEXT_COLOR = "#263040";

function normalizeCssColor(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

function normalizeMessageReadingStyle(value: unknown): AppSettings["messageReadingStyle"] {
  if (value === "comfortable") {
    return "native";
  }
  if (typeof value === "string" && allowedMessageReadingStyles.has(value)) {
    return value as AppSettings["messageReadingStyle"];
  }
  return "bubble";
}

type RemoteBackendTarget = AppSettings["remoteBackends"][number];

function normalizeRemoteProvider(value: unknown): AppSettings["remoteBackendProvider"] {
  void value;
  return "tcp";
}

function normalizeRemoteToken(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function normalizeRemoteHost(value: string | null | undefined): string {
  return value?.trim() ? value.trim() : DEFAULT_REMOTE_BACKEND_HOST;
}

function normalizeRemoteName(value: string | null | undefined, fallback: string): string {
  return value?.trim() ? value.trim() : fallback;
}

function normalizeRemoteBackends(settings: AppSettings): {
  remoteBackends: RemoteBackendTarget[];
  activeRemoteBackendId: string | null;
  remoteBackendProvider: AppSettings["remoteBackendProvider"];
  remoteBackendHost: string;
  remoteBackendToken: string | null;
} {
  const legacyProvider = normalizeRemoteProvider(settings.remoteBackendProvider);
  const legacyHost = normalizeRemoteHost(settings.remoteBackendHost);
  const legacyToken = normalizeRemoteToken(settings.remoteBackendToken);
  const usedIds = new Set<string>();

  const normalized = (settings.remoteBackends ?? []).map((entry, index) => {
    const baseId = entry.id?.trim() || `remote-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return {
      id,
      name: normalizeRemoteName(entry.name, `Remote ${index + 1}`),
      provider: normalizeRemoteProvider(entry.provider),
      host: normalizeRemoteHost(entry.host),
      token: normalizeRemoteToken(entry.token),
      lastConnectedAtMs:
        typeof entry.lastConnectedAtMs === "number" && Number.isFinite(entry.lastConnectedAtMs)
          ? entry.lastConnectedAtMs
          : null,
    };
  });

  if (normalized.length === 0) {
    const fallback: RemoteBackendTarget = {
      id: DEFAULT_REMOTE_BACKEND_ID,
      name: DEFAULT_REMOTE_BACKEND_NAME,
      provider: legacyProvider,
      host: legacyHost,
      token: legacyToken,
      lastConnectedAtMs: null,
    };
    return {
      remoteBackends: [fallback],
      activeRemoteBackendId: fallback.id,
      remoteBackendProvider: fallback.provider,
      remoteBackendHost: fallback.host,
      remoteBackendToken: fallback.token,
    };
  }

  const activeIndexById =
    settings.activeRemoteBackendId == null
      ? -1
      : normalized.findIndex((entry) => entry.id === settings.activeRemoteBackendId);
  const activeIndex = activeIndexById >= 0 ? activeIndexById : 0;
  const active = normalized[activeIndex];
  const syncedActive = {
    ...active,
    provider: legacyProvider,
    host: legacyHost,
    token: legacyToken,
  };
  const remoteBackends = [...normalized];
  remoteBackends[activeIndex] = syncedActive;
  return {
    remoteBackends,
    activeRemoteBackendId: syncedActive.id,
    remoteBackendProvider: syncedActive.provider,
    remoteBackendHost: syncedActive.host,
    remoteBackendToken: syncedActive.token,
  };
}

function normalizeCodexKeyProfiles(
  profiles: AppSettings["codexKeyProfiles"] | undefined,
): CodexKeyProfile[] {
  if (!Array.isArray(profiles)) {
    return [];
  }
  const usedIds = new Set<string>();
  return profiles
    .map((profile, index) => {
      const baseId = profile.id?.trim() || `codex-key-${index + 1}`;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      const providerKind = allowedCodexProviderKinds.has(profile.providerKind ?? "")
        ? profile.providerKind
        : "custom";
      const usageProtocol = allowedProviderUsageProtocols.has(profile.usageProtocol ?? "auto")
        ? (profile.usageProtocol ?? "auto")
        : "auto";
      const normalizePositiveInteger = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value > 0
          ? Math.floor(value)
          : null;
      const cachedModels = Array.isArray(profile.cachedModels)
        ? profile.cachedModels
            .map((model) => ({
              id: model.id?.trim() ?? "",
              name: model.name?.trim() || null,
              contextWindow: normalizePositiveInteger(model.contextWindow),
              ...(Array.isArray(model.supportedReasoningEfforts)
                ? {
                    supportedReasoningEfforts: parseReasoningEffortOptions(
                      model.supportedReasoningEfforts,
                    ),
                  }
                : {}),
              ...(typeof model.defaultReasoningEffort === "string"
                ? {
                    defaultReasoningEffort: normalizeReasoningEffortValue(
                      model.defaultReasoningEffort,
                    ),
                  }
                : {}),
            }))
            .filter((model) => model.id.length > 0)
        : [];
      return {
        id,
        name: profile.name?.trim() || `Key ${index + 1}`,
        providerKind,
        usageProtocol,
        keyEnvVar: profile.keyEnvVar?.trim() || DEFAULT_CODEX_KEY_ENV_VAR,
        key: profile.key?.trim() || "",
        baseUrlEnvVar: profile.baseUrlEnvVar?.trim() || DEFAULT_CODEX_BASE_URL_ENV_VAR,
        baseUrl: profile.baseUrl?.trim() || null,
        model: profile.model?.trim() || null,
        contextWindow: normalizePositiveInteger(profile.contextWindow),
        maxOutputTokens: normalizePositiveInteger(profile.maxOutputTokens),
        useGateway: providerKind === "opencode" || Boolean(profile.useGateway),
        supportsThinking:
          Boolean(profile.supportsThinking) || Boolean(profile.supportsReasoningEffort),
        supportsReasoningEffort: Boolean(profile.supportsReasoningEffort),
        lastModelRefreshAtMs:
          typeof profile.lastModelRefreshAtMs === "number" &&
          Number.isFinite(profile.lastModelRefreshAtMs) &&
          profile.lastModelRefreshAtMs > 0
            ? profile.lastModelRefreshAtMs
            : null,
        cachedModels,
        groupName: profile.groupName?.trim() || profile.name?.trim() || `Key ${index + 1}`,
      };
    })
    .filter((profile) => profile.key.length > 0);
}

function buildDefaultSettings(): AppSettings {
  const isMac = isMacPlatform();
  const isMobile = isMobilePlatform();
  const defaultRemote: RemoteBackendTarget = {
    id: DEFAULT_REMOTE_BACKEND_ID,
    name: DEFAULT_REMOTE_BACKEND_NAME,
    provider: DEFAULT_REMOTE_PROVIDER,
    host: DEFAULT_REMOTE_BACKEND_HOST,
    token: null,
    lastConnectedAtMs: null,
  };
  return {
    codexBin: null,
    codexArgs: null,
    codexHome: null,
    sessionSources: [],
    codexKeyProfiles: [],
    activeCodexKeyProfileId: null,
    preserveSessionLibraryOnProviderSwitch: true,
    syncProviderProfileToLocalConfig: false,
    backendMode: isMobile ? "remote" : "local",
    remoteBackendProvider: defaultRemote.provider,
    remoteBackendHost: defaultRemote.host,
    remoteBackendToken: null,
    remoteBackends: [defaultRemote],
    activeRemoteBackendId: defaultRemote.id,
    keepDaemonRunningAfterAppClose: false,
    defaultAccessMode: "current",
    reviewDeliveryMode: "inline",
    composerModelShortcut: isMac ? "cmd+shift+m" : "ctrl+shift+m",
    composerAccessShortcut: isMac ? "cmd+shift+a" : "ctrl+shift+a",
    composerReasoningShortcut: isMac ? "cmd+shift+r" : "ctrl+shift+r",
    composerCollaborationShortcut: "shift+tab",
    interruptShortcut: getDefaultInterruptShortcut(),
    newAgentShortcut: isMac ? "cmd+n" : "ctrl+n",
    newWorktreeAgentShortcut: isMac ? "cmd+shift+n" : "ctrl+shift+n",
    newCloneAgentShortcut: isMac ? "cmd+alt+n" : "ctrl+alt+n",
    archiveThreadShortcut: isMac ? "cmd+ctrl+a" : "ctrl+alt+a",
    toggleProjectsSidebarShortcut: isMac ? "cmd+shift+p" : "ctrl+shift+p",
    toggleGitSidebarShortcut: isMac ? "cmd+shift+g" : "ctrl+shift+g",
    branchSwitcherShortcut: isMac ? "cmd+b" : "ctrl+b",
    toggleDebugPanelShortcut: isMac ? "cmd+shift+d" : "ctrl+shift+d",
    toggleTerminalShortcut: isMac ? "cmd+shift+t" : "ctrl+shift+t",
    cycleAgentNextShortcut: isMac ? "cmd+ctrl+down" : "ctrl+alt+down",
    cycleAgentPrevShortcut: isMac ? "cmd+ctrl+up" : "ctrl+alt+up",
    cycleWorkspaceNextShortcut: isMac ? "cmd+shift+down" : "ctrl+alt+shift+down",
    cycleWorkspacePrevShortcut: isMac ? "cmd+shift+up" : "ctrl+alt+shift+up",
    lastComposerModelId: null,
    lastComposerReasoningEffort: null,
    tokenEfficiencyMode: "quality",
    toolOutputTokenLimit: null,
    workflowRuntimeMode: "shadow",
    uiScale: UI_SCALE_DEFAULT,
    appLanguage: "system",
    theme: "system",
    themeAccent: "codex",
    showCodexUsage: true,
    usageShowRemaining: false,
    showMessageFilePath: true,
    messageToolGroupsCollapsedByDefault: false,
    messageReadingStyle: "bubble",
    messageCanvasColor: DEFAULT_MESSAGE_CANVAS_COLOR,
    messageUserBubbleColor: DEFAULT_MESSAGE_USER_BUBBLE_COLOR,
    messageUserTextColor: DEFAULT_MESSAGE_USER_TEXT_COLOR,
    messageAssistantBubbleColor: DEFAULT_MESSAGE_ASSISTANT_BUBBLE_COLOR,
    messageAssistantAccentColor: DEFAULT_MESSAGE_ASSISTANT_ACCENT_COLOR,
    messageAssistantTextColor: DEFAULT_MESSAGE_ASSISTANT_TEXT_COLOR,
    messageFontFamily: "",
    chatHistoryScrollbackItems: CHAT_SCROLLBACK_DEFAULT,
    threadTitleAutogenerationEnabled: true,
    autoArchiveThreadsEnabled: false,
    autoArchiveThreadsDays: 7,
    autoDeleteArchivedThreadsEnabled: false,
    autoDeleteArchivedThreadsDays: 30,
    automaticAppUpdateChecksEnabled: true,
    uiFontFamily: DEFAULT_UI_FONT_FAMILY,
    uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
    uiCjkFontFamily: DEFAULT_UI_CJK_FONT_FAMILY,
    uiFontSize: UI_FONT_SIZE_DEFAULT,
    uiFontWeight: UI_FONT_WEIGHT_DEFAULT,
    codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
    messageFontSize: MESSAGE_FONT_SIZE_DEFAULT,
    processFontSize: PROCESS_FONT_SIZE_DEFAULT,
    messageFontWeight: MESSAGE_FONT_WEIGHT_DEFAULT,
    codeFontSize: CODE_FONT_SIZE_DEFAULT,
    notificationSoundsEnabled: true,
    systemNotificationsEnabled: true,
    subagentSystemNotificationsEnabled: true,
    nativeAgentMarkdownImportEnabled: true,
    splitChatDiffView: false,
    preloadGitDiffs: true,
    gitDiffIgnoreWhitespaceChanges: false,
    commitMessagePrompt: DEFAULT_COMMIT_MESSAGE_PROMPT,
    commitMessageModelId: null,
    collaborationModesEnabled: true,
    steerEnabled: true,
    followUpMessageBehavior: "queue",
    subagentCheckpointSyncMode: "checkpoints",
    composerSendShortcut: "enter",
    composerTriggerMode: "default",
    composerFollowUpHintEnabled: true,
    pauseQueuedMessagesWhenResponseRequired: true,
    unifiedExecEnabled: true,
    experimentalAppsEnabled: false,
    personality: "friendly",
    dictationEnabled: false,
    dictationModelId: "base",
    dictationPreferredLanguage: null,
    dictationHoldKey: "alt",
    composerEditorPreset: "default",
    composerFenceExpandOnSpace: false,
    composerFenceExpandOnEnter: false,
    composerFenceLanguageTags: false,
    composerFenceWrapSelection: false,
    composerFenceAutoWrapPasteMultiline: false,
    composerFenceAutoWrapPasteCodeLike: false,
    composerLargePasteBehavior: "smart",
    composerListContinuation: false,
    composerCodeBlockCopyUseModifier: false,
    workspaceGroups: [],
    openAppTargets: DEFAULT_OPEN_APP_TARGETS,
    selectedOpenAppId: DEFAULT_OPEN_APP_ID,
    globalWorktreesFolder: null,
  };
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const remoteBackendSettings = normalizeRemoteBackends(settings);
  const normalizedTargets =
    settings.openAppTargets && settings.openAppTargets.length
      ? normalizeOpenAppTargets(settings.openAppTargets)
      : DEFAULT_OPEN_APP_TARGETS;
  const storedOpenAppId =
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(OPEN_APP_STORAGE_KEY);
  const hasPersistedSelection = normalizedTargets.some(
    (target) => target.id === settings.selectedOpenAppId,
  );
  const hasStoredSelection =
    !hasPersistedSelection &&
    storedOpenAppId !== null &&
    normalizedTargets.some((target) => target.id === storedOpenAppId);
  const selectedOpenAppId = hasPersistedSelection
    ? settings.selectedOpenAppId
    : hasStoredSelection
      ? storedOpenAppId
      : normalizedTargets[0]?.id ?? DEFAULT_OPEN_APP_ID;
  const commitMessagePrompt =
    settings.commitMessagePrompt && settings.commitMessagePrompt.trim().length > 0
      ? settings.commitMessagePrompt
      : DEFAULT_COMMIT_MESSAGE_PROMPT;
  const chatHistoryScrollbackItems = normalizeChatHistoryScrollbackItems(
    settings.chatHistoryScrollbackItems,
  );
  const codexKeyProfiles = normalizeCodexKeyProfiles(settings.codexKeyProfiles);
  const activeCodexKeyProfileId = codexKeyProfiles.some(
    (profile) => profile.id === settings.activeCodexKeyProfileId,
  )
    ? settings.activeCodexKeyProfileId
    : null;
  return {
    ...settings,
    ...remoteBackendSettings,
      codexBin: settings.codexBin?.trim() ? settings.codexBin.trim() : null,
      codexArgs: settings.codexArgs?.trim() ? settings.codexArgs.trim() : null,
      codexHome: settings.codexHome?.trim() ? settings.codexHome.trim() : null,
      sessionSources: Array.isArray(settings.sessionSources)
        ? settings.sessionSources
        : [],
      codexKeyProfiles,
    activeCodexKeyProfileId,
    preserveSessionLibraryOnProviderSwitch:
      typeof settings.preserveSessionLibraryOnProviderSwitch === "boolean"
        ? settings.preserveSessionLibraryOnProviderSwitch
        : true,
    syncProviderProfileToLocalConfig:
      typeof settings.syncProviderProfileToLocalConfig === "boolean"
        ? settings.syncProviderProfileToLocalConfig
        : false,
    tokenEfficiencyMode: allowedTokenEfficiencyModes.has(
      settings.tokenEfficiencyMode ?? "",
    )
      ? settings.tokenEfficiencyMode
      : "quality",
    toolOutputTokenLimit:
      typeof settings.toolOutputTokenLimit === "number" &&
      Number.isFinite(settings.toolOutputTokenLimit) &&
      settings.toolOutputTokenLimit > 0
        ? Math.floor(settings.toolOutputTokenLimit)
        : null,
    workflowRuntimeMode: allowedWorkflowRuntimeModes.has(
      settings.workflowRuntimeMode ?? "",
    )
      ? settings.workflowRuntimeMode
      : "shadow",
    uiScale: clampUiScale(settings.uiScale),
    appLanguage: allowedAppLanguages.has(settings.appLanguage)
      ? settings.appLanguage
      : "system",
    theme: allowedThemes.has(settings.theme) ? settings.theme : "system",
    themeAccent: allowedThemeAccents.has(settings.themeAccent)
      ? settings.themeAccent
      : "codex",
    showCodexUsage:
      typeof settings.showCodexUsage === "boolean" ? settings.showCodexUsage : true,
    composerLargePasteBehavior:
      settings.composerLargePasteBehavior === "keepText" ? "keepText" : "smart",
    messageToolGroupsCollapsedByDefault:
      typeof settings.messageToolGroupsCollapsedByDefault === "boolean"
        ? settings.messageToolGroupsCollapsedByDefault
        : false,
    messageReadingStyle: normalizeMessageReadingStyle(settings.messageReadingStyle),
    messageCanvasColor: normalizeCssColor(
      settings.messageCanvasColor,
      DEFAULT_MESSAGE_CANVAS_COLOR,
    ),
    messageUserBubbleColor: normalizeCssColor(
      settings.messageUserBubbleColor,
      DEFAULT_MESSAGE_USER_BUBBLE_COLOR,
    ),
    messageUserTextColor: normalizeCssColor(
      settings.messageUserTextColor,
      DEFAULT_MESSAGE_USER_TEXT_COLOR,
    ),
    messageAssistantBubbleColor: normalizeCssColor(
      settings.messageAssistantBubbleColor,
      DEFAULT_MESSAGE_ASSISTANT_BUBBLE_COLOR,
    ),
    messageAssistantAccentColor: normalizeCssColor(
      settings.messageAssistantAccentColor,
      DEFAULT_MESSAGE_ASSISTANT_ACCENT_COLOR,
    ),
    messageAssistantTextColor: normalizeCssColor(
      settings.messageAssistantTextColor,
      DEFAULT_MESSAGE_ASSISTANT_TEXT_COLOR,
    ),
    uiFontFamily: normalizeFontFamily(
      settings.uiFontFamily,
      DEFAULT_UI_FONT_FAMILY,
    ),
    uiLatinFontFamily: normalizeFontFamily(
      settings.uiLatinFontFamily,
      DEFAULT_UI_LATIN_FONT_FAMILY,
    ),
    uiCjkFontFamily: normalizeUiCjkFontFamily(settings.uiCjkFontFamily),
    uiFontSize: clampUiFontSize(settings.uiFontSize),
    uiFontWeight: clampUiFontWeight(settings.uiFontWeight),
    codeFontFamily: normalizeFontFamily(
      settings.codeFontFamily,
      DEFAULT_CODE_FONT_FAMILY,
    ),
    messageFontSize: clampMessageFontSize(settings.messageFontSize),
    processFontSize: clampProcessFontSize(settings.processFontSize),
    messageFontWeight: clampMessageFontWeight(settings.messageFontWeight),
    messageFontFamily: normalizeFontFamily(
      settings.messageFontFamily,
      `${settings.uiLatinFontFamily}, ${settings.uiCjkFontFamily}, ${settings.uiFontFamily}`,
    ),
    codeFontSize: clampCodeFontSize(settings.codeFontSize),
    autoArchiveThreadsEnabled:
      typeof settings.autoArchiveThreadsEnabled === "boolean"
        ? settings.autoArchiveThreadsEnabled
        : false,
    autoArchiveThreadsDays: [3, 5, 7, 15, 30].includes(settings.autoArchiveThreadsDays)
      ? settings.autoArchiveThreadsDays
      : 7,
    autoDeleteArchivedThreadsEnabled:
      typeof settings.autoDeleteArchivedThreadsEnabled === "boolean"
        ? settings.autoDeleteArchivedThreadsEnabled
        : false,
    autoDeleteArchivedThreadsDays: [30, 60, 90, 180].includes(
      settings.autoDeleteArchivedThreadsDays,
    )
      ? settings.autoDeleteArchivedThreadsDays
      : 30,
    personality: allowedPersonality.has(settings.personality)
      ? settings.personality
      : "friendly",
    followUpMessageBehavior: allowedFollowUpMessageBehavior.has(
      settings.followUpMessageBehavior,
    )
      ? settings.followUpMessageBehavior
      : settings.steerEnabled
        ? "steer"
        : "queue",
    subagentCheckpointSyncMode: allowedSubagentCheckpointSyncMode.has(
      settings.subagentCheckpointSyncMode,
    )
      ? settings.subagentCheckpointSyncMode
      : "checkpoints",
    composerFollowUpHintEnabled:
      typeof settings.composerFollowUpHintEnabled === "boolean"
        ? settings.composerFollowUpHintEnabled
        : true,
    composerSendShortcut: allowedComposerSendShortcut.has(settings.composerSendShortcut)
      ? settings.composerSendShortcut
      : "enter",
    composerTriggerMode: allowedComposerTriggerMode.has(settings.composerTriggerMode ?? "")
      ? settings.composerTriggerMode
      : "default",
    nativeAgentMarkdownImportEnabled:
      typeof settings.nativeAgentMarkdownImportEnabled === "boolean"
        ? settings.nativeAgentMarkdownImportEnabled
        : true,
    threadTitleAutogenerationEnabled:
      typeof settings.threadTitleAutogenerationEnabled === "boolean"
        ? settings.threadTitleAutogenerationEnabled
        : true,
    reviewDeliveryMode:
      settings.reviewDeliveryMode === "detached" ? "detached" : "inline",
    chatHistoryScrollbackItems,
    commitMessagePrompt,
    openAppTargets: normalizedTargets,
    selectedOpenAppId,
  };
}

export function useAppSettings() {
  const defaultSettings = useMemo(() => buildDefaultSettings(), []);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await getAppSettings();
        if (active) {
          setSettings(
            normalizeAppSettings({
              ...defaultSettings,
              ...response,
            }),
          );
        }
      } catch {
        // Defaults stay in place if loading settings fails.
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [defaultSettings]);

  const saveSettings = useCallback(async (next: AppSettings) => {
    const normalized = normalizeAppSettings(next);
    const saved = await updateAppSettings(normalized);
    setSettings(
      normalizeAppSettings({
        ...defaultSettings,
        ...saved,
      }),
    );
    return saved;
  }, [defaultSettings]);

  const doctor = useCallback(
    async (codexBin: string | null, codexArgs: string | null) => {
      return runCodexDoctor(codexBin, codexArgs);
    },
    [],
  );

  return {
    settings,
    setSettings,
    saveSettings,
    doctor,
    isLoading,
  };
}
