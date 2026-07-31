import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import successSoundUrl from "@/assets/success-notification.mp3";
import errorSoundUrl from "@/assets/error-notification.mp3";
import { MainAppShell } from "@app/components/MainAppShell";
import { useThreads } from "@threads/hooks/useThreads";
import { usePullRequestComposer } from "@/features/git/hooks/usePullRequestComposer";
import { useAutoExitEmptyDiff } from "@/features/git/hooks/useAutoExitEmptyDiff";
import { isMissingRepo } from "@/features/git/utils/repoErrors";
import { useModels } from "@/features/models/hooks/useModels";
import { useCollaborationModes } from "@/features/collaboration/hooks/useCollaborationModes";
import { useCollaborationModeSelection } from "@/features/collaboration/hooks/useCollaborationModeSelection";
import { useSkills } from "@/features/skills/hooks/useSkills";
import { buildWorkflowRuntimeDiagnostics } from "@/features/workflow/utils/workflowDiagnostics";
import { useApps } from "@/features/apps/hooks/useApps";
import { useCustomPrompts } from "@/features/prompts/hooks/useCustomPrompts";
import { useBranchSwitcherShortcut } from "@/features/git/hooks/useBranchSwitcherShortcut";
import { useRenameWorktreePrompt } from "@/features/workspaces/hooks/useRenameWorktreePrompt";
import { SESSION_MANAGER_MIN_MAIN_CONTENT_WIDTH, useLayoutController } from "@app/hooks/useLayoutController";
import { useUpdaterController } from "@app/hooks/useUpdaterController";
import { useResponseRequiredNotificationsController } from "@app/hooks/useResponseRequiredNotificationsController";
import { useErrorToasts } from "@/features/notifications/hooks/useErrorToasts";
import { useComposerShortcuts } from "@/features/composer/hooks/useComposerShortcuts";
import { useComposerMenuActions } from "@/features/composer/hooks/useComposerMenuActions";
import { useComposerEditorState } from "@/features/composer/hooks/useComposerEditorState";
import { useMainAppComposerWorkspaceState } from "@app/hooks/useMainAppComposerWorkspaceState";
import { useMainAppGitState } from "@app/hooks/useMainAppGitState";
import { useMainAppLayoutSurfaces } from "@app/hooks/useMainAppLayoutSurfaces";
import { useMainAppLayoutNodes } from "@app/hooks/useMainAppLayoutNodes";
import { useWorkspaceFromUrlPrompt } from "@/features/workspaces/hooks/useWorkspaceFromUrlPrompt";
import {
  isLocalCodexWorkspaceId,
  LOCAL_CODEX_GROUP_ID,
  LOCAL_CODEX_WORKSPACE_NAME,
  LOCAL_CODEX_WORKSPACE_ID,
} from "@/features/workspaces/domain/localCodexWorkspace";
import { useWorkspaceController } from "@app/hooks/useWorkspaceController";
import { useWorkspaceSelection } from "@/features/workspaces/hooks/useWorkspaceSelection";
import { normalizeRootPath } from "@/features/threads/utils/threadNormalize";
import { usePlanReadyActions } from "@app/hooks/usePlanReadyActions";
import { getActivePlanStream } from "@/features/plan/planStream";
import { useThreadRows } from "@app/hooks/useThreadRows";
import { useInterruptShortcut } from "@app/hooks/useInterruptShortcut";
import { useArchiveShortcut } from "@app/hooks/useArchiveShortcut";
import { useTerminalController } from "@/features/terminal/hooks/useTerminalController";
import { useWorkspaceLaunchScript } from "@app/hooks/useWorkspaceLaunchScript";
import { useWorkspaceLaunchScripts } from "@app/hooks/useWorkspaceLaunchScripts";
import { useWorktreeSetupScript } from "@app/hooks/useWorktreeSetupScript";
import { effectiveCommitMessageModelId } from "@/features/git/utils/commitMessageModelSelection";
import { useMobileServerSetup } from "@/features/mobile/hooks/useMobileServerSetup";
import { useMainAppModals } from "@app/hooks/useMainAppModals";
import { useMainAppDisplayNodes } from "@app/hooks/useMainAppDisplayNodes";
import { useMainAppPromptActions } from "@app/hooks/useMainAppPromptActions";
import { useMainAppShellProps } from "@app/hooks/useMainAppShellProps";
import { useMainAppSidebarMenuOrchestration } from "@app/hooks/useMainAppSidebarMenuOrchestration";
import { buildNativeMenuLabels } from "@/features/i18n/nativeMenuLabels";
import { useMainAppSettingsActions } from "@app/hooks/useMainAppSettingsActions";
import { useMainAppThreadCodexState } from "@app/hooks/useMainAppThreadCodexState";
import {
  restoreProviderRuntimeSettings,
  useProviderProfileRuntimeSync,
  type ProviderRuntimeSettingsSnapshot,
} from "@app/hooks/useProviderProfileRuntimeSync";
import { useMainAppWorktreeState } from "@app/hooks/useMainAppWorktreeState";
import { useMainAppWorkspaceActions } from "@app/hooks/useMainAppWorkspaceActions";
import { useMainAppWorkspaceLifecycle } from "@app/hooks/useMainAppWorkspaceLifecycle";
import { useMainAppMobileThreadRefresh } from "@app/hooks/useMainAppMobileThreadRefresh";
import { useHomeAccount } from "@app/hooks/useHomeAccount";
import type {
  ComposerEditorSettings,
  ModelOption,
  ServiceTier,
  WorkspaceRuntimeCodexArgsResult,
  WorkspaceInfo,
} from "@/types";
import type { ThreadListRuntimeContext } from "@threads/types";
import { useOpenAppIcons } from "@app/hooks/useOpenAppIcons";
import { useAccountSwitching } from "@app/hooks/useAccountSwitching";
import { useNewAgentDraft } from "@app/hooks/useNewAgentDraft";
import { useSystemNotificationThreadLinks } from "@app/hooks/useSystemNotificationThreadLinks";
import { useThreadListSortKey } from "@app/hooks/useThreadListSortKey";
import { useThreadListActions } from "@app/hooks/useThreadListActions";
import { useRemoteThreadLiveConnection } from "@app/hooks/useRemoteThreadLiveConnection";
import { useTrayLabels } from "@app/hooks/useTrayLabels";
import { useSessionCleanupScheduler } from "@app/hooks/useSessionCleanupScheduler";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import { resolveAppLanguage } from "@/features/i18n/appLanguage";
import { I18N_STRINGS, type I18nKey } from "@/features/i18n/strings";
import { useAppBootstrapOrchestration } from "@app/bootstrap/useAppBootstrapOrchestration";
import {
  useThreadCodexBootstrapOrchestration,
  useThreadCodexSyncOrchestration,
  useThreadSelectionHandlersOrchestration,
  useThreadUiOrchestration,
} from "@app/orchestration/useThreadOrchestration";
import {
  useWorkspaceInsightsOrchestration,
  useWorkspaceOrderingOrchestration,
} from "@app/orchestration/useWorkspaceOrchestration";
import { useAppShellOrchestration } from "@app/orchestration/useLayoutOrchestration";
import { normalizeCodexArgsInput } from "@/utils/codexArgsInput";
import {
  applyRefreshedCodexProviderModels,
  resolveCodexProviderModel,
  resolveCodexProviderBaseUrl,
  resolveCodexProviderModelOptions,
} from "@/utils/providerProfiles";
import {
  getProviderModels,
  getManagedCodexPlatform,
  installManagedCodex,
  prepareManagedSessionDerivation,
  createMessageReference,
  resumeManagedSession,
  workflowGateStatus,
} from "@services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "@services/events";
import { fetchManagedCodexPackage } from "@/features/codex/utils/managedCodex";
import { CodexInstallPrompt } from "@/features/codex/components/CodexInstallPrompt";
import type { ManagedSession, ManagedSessionDerivationPreview } from "@/types";
import { SessionDerivationPrompt } from "@/features/sessions/components/SessionDerivationPrompt";
import { loadThreadDerivations, saveThreadDerivation } from "@threads/utils/threadStorage";
import { deriveManagedSessionIntoWorkspace } from "@/features/sessions/orchestration/deriveManagedSession";
import { SessionManagerProvider } from "@/features/sessions/context/SessionManagerContext";
import { SessionManagerWorkspace } from "@/features/sessions/components/SessionManagerWorkspace";
import { SessionResumeChoicePrompt } from "@/features/sessions/components/SessionResumeChoicePrompt";
import { applyMessageReference } from "@/features/messages/orchestration/deriveMessageReference";
import type { MessageReferenceAction } from "@/features/messages/utils/messageReferences";
import { buildProviderSessionDiagnostics } from "@settings/utils/providerSessionDiagnostics";

const SettingsView = lazy(() =>
  import("@settings/components/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);

function resolveWorkspaceIdForLocalCodexPath(
  path: string,
  workspaces: WorkspaceInfo[],
) {
  const normalizedPath = normalizeRootPath(path);
  if (!normalizedPath) {
    return null;
  }

  const candidates = workspaces
    .filter((workspace) => !isLocalCodexWorkspaceId(workspace.id))
    .map((workspace) => ({
      id: workspace.id,
      path: normalizeRootPath(workspace.path),
    }))
    .filter((workspace) => workspace.path.length > 0)
    .sort((a, b) => b.path.length - a.path.length);

  return (
    candidates.find(
      (workspace) =>
        normalizedPath === workspace.path ||
        normalizedPath.startsWith(`${workspace.path}/`),
    )?.id ?? null
  );
}

export default function MainApp() {
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  const [managedSessionSourceByThread, setManagedSessionSourceByThread] = useState<Record<string, string>>({});
  const [threadDerivations, setThreadDerivations] = useState(loadThreadDerivations);
  const [managedSessionDerivation, setManagedSessionDerivation] = useState<{
    previews: ManagedSessionDerivationPreview[];
    destination: WorkspaceInfo;
    error: string | null;
    isBusy: boolean;
  } | null>(null);
  const [codexInstallPromptOpen, setCodexInstallPromptOpen] = useState(false);
  const [codexInstallStage, setCodexInstallStage] = useState<"ready" | "downloading" | "error">("ready");
  const [codexInstallProgress, setCodexInstallProgress] = useState(0);
  const [codexInstallError, setCodexInstallError] = useState<string | null>(null);
  const codexInstallCheckStartedRef = useRef(false);
  const codexInstallRequestIdRef = useRef<string | null>(null);
  const [threadListRuntimeContext, setThreadListRuntimeContext] =
    useState<ThreadListRuntimeContext>({
      sourceId: null,
      runtimeGeneration: 0,
    });
  const threadListRuntimeContextRef = useRef(threadListRuntimeContext);
  threadListRuntimeContextRef.current = threadListRuntimeContext;
  const {
    appSettings,
    setAppSettings,
    doctor,
    codexUpdate,
    appSettingsLoading,
    reduceTransparency,
    setReduceTransparency,
    scaleShortcutTitle,
    scaleShortcutText,
    queueSaveSettings,
    waitForPendingSettingsSaves,
    dictationModel,
    dictationState,
    dictationLevel,
    dictationTranscript,
    dictationError,
    dictationHint,
    dictationReady,
    handleToggleDictation,
    cancelDictation,
    clearDictationTranscript,
    clearDictationError,
    clearDictationHint,
    debugOpen,
    setDebugOpen,
    debugEntries,
    addDebugEntry,
    handleCopyDebug,
    clearDebugEntries,
    shouldReduceTransparency,
    runtimeThemeAppearance,
  } = useAppBootstrapOrchestration();
  const appLanguage = resolveAppLanguage(appSettings.appLanguage);
  const t = useCallback(
    (key: I18nKey) => I18N_STRINGS[appLanguage][key] ?? I18N_STRINGS.zh[key],
    [appLanguage],
  );
  const nativeMenuLabels = useMemo(() => buildNativeMenuLabels(t), [t]);
  const trayLabels = useMemo(
    () => ({
      open: t("tray.open"),
      hide: t("tray.hide"),
      checkUpdates: t("tray.checkUpdates"),
      launchAtStartup: t("tray.launchAtStartup"),
      restart: t("tray.restart"),
      quit: t("tray.quit"),
    }),
    [t],
  );
  const {
    threadListSortKey,
    setThreadListSortKey,
    threadListOrganizeMode,
  } = useThreadListSortKey();
  const [activeTab, setActiveTab] = useState<
    "home" | "projects" | "codex" | "git" | "log"
  >("codex");
  const tabletTab =
    activeTab === "projects" || activeTab === "home" ? "codex" : activeTab;
  const {
    workspaces: storedWorkspaces,
    workspaceGroups,
    groupedWorkspaces: storedGroupedWorkspaces,
    getWorkspaceGroupName: getStoredWorkspaceGroupName,
    ungroupedLabel,
    activeWorkspace: storedActiveWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
    addWorkspace,
    addWorkspaceFromPath,
    addWorkspaceFromGitUrl,
    addWorkspacesFromPaths,
    mobileRemoteWorkspacePathPrompt,
    updateMobileRemoteWorkspacePathInput,
    appendMobileRemoteWorkspacePathFromRecent,
    cancelMobileRemoteWorkspacePathPrompt,
    submitMobileRemoteWorkspacePathPrompt,
    addCloneAgent,
    addWorktreeAgent,
    connectWorkspace,
    markWorkspaceConnected,
    updateWorkspaceSettings,
    createWorkspaceGroup,
    renameWorkspaceGroup,
    moveWorkspaceGroup,
    deleteWorkspaceGroup,
    assignWorkspaceGroup,
    removeWorkspace,
    removeWorktree,
    renameWorktree,
    renameWorktreeUpstream,
    deletingWorktreeIds,
    hasLoaded,
    refreshWorkspaces,
  } = useWorkspaceController({
    appSettings,
    addDebugEntry,
    queueSaveSettings,
  });
  const {
    isMobileRuntime,
    showMobileSetupWizard,
    mobileSetupWizardProps,
    handleMobileConnectSuccess,
  } = useMobileServerSetup({
    appSettings,
    appSettingsLoading,
    queueSaveSettings,
    refreshWorkspaces,
  });
  const updaterEnabled = !isMobileRuntime;

  useEffect(() => {
    if (appSettingsLoading || isMobileRuntime || codexInstallCheckStartedRef.current) return;
    codexInstallCheckStartedRef.current = true;
    void doctor(appSettings.codexBin, appSettings.codexArgs).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("codex cli not found")) {
        setCodexInstallPromptOpen(true);
      }
    });
  }, [appSettings.codexArgs, appSettings.codexBin, appSettingsLoading, doctor, isMobileRuntime]);

  useEffect(() => subscribeReleaseAssetDownloadProgress((progress) => {
    if (progress.id !== codexInstallRequestIdRef.current) return;
    if (progress.totalBytes && progress.totalBytes > 0) {
      setCodexInstallProgress((progress.downloadedBytes / progress.totalBytes) * 100);
    }
  }), []);

  const localCodexWorkspace = useMemo<WorkspaceInfo>(
    () => ({
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        groupId: null,
        sortOrder: Number.MAX_SAFE_INTEGER,
      },
    }),
    [],
  );
  const workspaces = useMemo(
    () => [...storedWorkspaces, localCodexWorkspace],
    [localCodexWorkspace, storedWorkspaces],
  );
  const groupedWorkspaces = storedGroupedWorkspaces;
  const activeWorkspace = isLocalCodexWorkspaceId(activeWorkspaceId)
    ? localCodexWorkspace
    : storedActiveWorkspace;
  const projectActiveWorkspace = isLocalCodexWorkspaceId(activeWorkspaceId)
    ? null
    : activeWorkspace;
  const getWorkspaceGroupName = getStoredWorkspaceGroupName;
  const workspacesById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const {
    threadCodexParamsVersion,
    getThreadCodexParams,
    patchThreadCodexParams,
    accessMode,
    setAccessMode,
    preferredModelId,
    setPreferredModelId,
    preferredEffort,
    setPreferredEffort,
    preferredServiceTier,
    setPreferredServiceTier,
    preferredCollabModeId,
    setPreferredCollabModeId,
    preferredCodexArgsOverride,
    setPreferredCodexArgsOverride,
    threadCodexSelectionKey,
    setThreadCodexSelectionKey,
    activeThreadIdRef,
    pendingNewThreadSeedRef,
    persistThreadCodexParams,
  } = useThreadCodexBootstrapOrchestration({
    activeWorkspaceId,
  });
  const getWorkflowGateId = useCallback(
    (workspaceId: string, threadId: string) =>
      getThreadCodexParams(workspaceId, threadId)?.workflowGateId ?? null,
    [getThreadCodexParams],
  );
  const {
    appRef,
    isResizing,
    sidebarWidth,
    chatDiffSplitPositionPercent,
    rightPanelWidth,
    onSidebarResizeStart,
    onChatDiffSplitPositionResizeStart,
    onRightPanelResizeStart,
    planPanelHeight,
    onPlanPanelResizeStart,
    terminalPanelHeight,
    onTerminalPanelResizeStart,
    debugPanelHeight,
    onDebugPanelResizeStart,
    isCompact,
    isTablet,
    isPhone,
    sidebarCollapsed,
    rightPanelCollapsed,
    autoSidebarCollapsed,
    autoRightPanelCollapsed,
    sidebarOverlayOpen,
    tabletProjectsOpen,
    revealSidebar,
    hideSidebar,
    collapseSidebar,
    expandSidebar,
    collapseRightPanel,
    expandRightPanel,
    terminalOpen,
    handleDebugClick,
    handleToggleTerminal,
    openTerminal,
    closeTerminal: closeTerminalPanel,
  } = useLayoutController({
    activeWorkspaceId,
    setActiveTab,
    setDebugOpen,
    toggleDebugPanelShortcut: appSettings.toggleDebugPanelShortcut,
    toggleTerminalShortcut: appSettings.toggleTerminalShortcut,
    minMainContentWidth: sessionManagerOpen ? SESSION_MANAGER_MIN_MAIN_CONTENT_WIDTH : undefined,
  });
  const handleSessionManagerActiveChange = useCallback(
    (active: boolean) => {
      setSessionManagerOpen(active);
      if (active) {
        revealSidebar();
      } else {
        hideSidebar();
      }
    },
    [hideSidebar, revealSidebar],
  );
  const sidebarToggleProps = {
    isCompact,
    sidebarCollapsed,
    rightPanelCollapsed,
    autoSidebarCollapsed,
    autoRightPanelCollapsed,
    onCollapseSidebar: collapseSidebar,
    onExpandSidebar: expandSidebar,
    onCollapseRightPanel: collapseRightPanel,
    onExpandRightPanel: expandRightPanel,
  };
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const workspaceHomeTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const getWorkspaceName = useCallback(
    (workspaceId: string) => workspacesById.get(workspaceId)?.name,
    [workspacesById],
  );

  const { errorToasts, dismissErrorToast } = useErrorToasts();
  const queueGitStatusRefreshRef = useRef<() => void>(() => {});
  const handleThreadMessageActivity = useCallback(() => {
    queueGitStatusRefreshRef.current();
  }, []);

  // Access mode is thread-scoped (best-effort persisted) and falls back to the app default.
  const activeCodexKeyProfile = useMemo(
    () =>
      appSettings.codexKeyProfiles.find(
        (profile) => profile.id === appSettings.activeCodexKeyProfileId,
      ) ?? null,
    [appSettings.activeCodexKeyProfileId, appSettings.codexKeyProfiles],
  );
  const effectivePreferredModelId = resolveCodexProviderModel(
    activeCodexKeyProfile?.model,
    preferredModelId,
  );
  const activeProviderModels = useMemo<ModelOption[]>(
    () => resolveCodexProviderModelOptions(activeCodexKeyProfile),
    [activeCodexKeyProfile],
  );
  const [isRefreshingProviderModels, setIsRefreshingProviderModels] = useState(false);

  const {
    models,
    selectedModel,
    selectedModelId,
    setSelectedModelId,
    reasoningSupported,
    reasoningOptions,
    selectedEffort,
    setSelectedEffort,
    refreshModels,
    isRefreshingModels,
  } = useModels({
    activeWorkspace,
    onDebug: addDebugEntry,
    preferredModelId: effectivePreferredModelId,
    providerModels: activeProviderModels,
    preferredEffort,
    selectionKey: threadCodexSelectionKey,
  });
  const handleRefreshModels = useCallback(async () => {
    if (!activeCodexKeyProfile) {
      await refreshModels();
      return;
    }
    const baseUrl = resolveCodexProviderBaseUrl(
      activeCodexKeyProfile.providerKind,
      activeCodexKeyProfile.baseUrl,
    );
    if (!baseUrl || !activeCodexKeyProfile.key.trim()) {
      return;
    }
    setIsRefreshingProviderModels(true);
    try {
      const refreshedModels = await getProviderModels(
        baseUrl,
        activeCodexKeyProfile.key.trim(),
      );
      setAppSettings((current) => {
        const next = applyRefreshedCodexProviderModels(
          current,
          activeCodexKeyProfile.id,
          refreshedModels,
          Date.now(),
        );
        if (next !== current) {
          void queueSaveSettings(next).catch((error) => {
            addDebugEntry({
              id: `${Date.now()}-provider-model-cache-error`,
              timestamp: Date.now(),
              source: "error",
              label: "provider model cache error",
              payload: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return next;
      });
    } catch (error) {
      addDebugEntry({
        id: `${Date.now()}-provider-model-list-error`,
        timestamp: Date.now(),
        source: "error",
        label: "provider model/list error",
        payload: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsRefreshingProviderModels(false);
    }
  }, [
    activeCodexKeyProfile,
    addDebugEntry,
    queueSaveSettings,
    refreshModels,
    setAppSettings,
  ]);

  const {
    collaborationModes,
    selectedCollaborationMode,
    selectedCollaborationModeId,
    setSelectedCollaborationModeId,
  } = useCollaborationModes({
    activeWorkspace,
    enabled: appSettings.collaborationModesEnabled,
    preferredModeId: preferredCollabModeId,
    selectionKey: threadCodexSelectionKey,
    onDebug: addDebugEntry,
  });

  const [selectedCodexArgsOverride, setSelectedCodexArgsOverride] = useState<string | null>(
    null,
  );
  const [selectedServiceTier, setSelectedServiceTier] = useState<
    ServiceTier | null | undefined
  >(undefined);
  useEffect(() => {
    setSelectedCodexArgsOverride(normalizeCodexArgsInput(preferredCodexArgsOverride));
  }, [preferredCodexArgsOverride, threadCodexSelectionKey]);
  useEffect(() => {
    setSelectedServiceTier(preferredServiceTier);
  }, [preferredServiceTier, threadCodexSelectionKey]);

  const {
    handleSelectModel,
    handleSelectEffort,
    handleSelectServiceTier,
    handleSelectCollaborationMode,
    handleSelectAccessMode,
    handleSelectCodexArgsOverride,
  } = useThreadSelectionHandlersOrchestration({
    appSettingsLoading,
    setAppSettings,
    queueSaveSettings,
    activeThreadIdRef,
    setSelectedModelId,
    setSelectedEffort,
    setSelectedServiceTier,
    setSelectedCollaborationModeId,
    setAccessMode,
    setSelectedCodexArgsOverride,
    persistThreadCodexParams,
  });
  const commitMessageModelId = useMemo(
    () => effectiveCommitMessageModelId(models, appSettings.commitMessageModelId),
    [models, appSettings.commitMessageModelId],
  );

  const composerShortcuts = {
    modelShortcut: appSettings.composerModelShortcut,
    accessShortcut: appSettings.composerAccessShortcut,
    reasoningShortcut: appSettings.composerReasoningShortcut,
    collaborationShortcut: appSettings.collaborationModesEnabled
      ? appSettings.composerCollaborationShortcut
      : null,
    models,
    collaborationModes,
    selectedModelId,
    onSelectModel: handleSelectModel,
    selectedCollaborationModeId,
    onSelectCollaborationMode: handleSelectCollaborationMode,
    accessMode,
    onSelectAccessMode: handleSelectAccessMode,
    reasoningOptions,
    selectedEffort,
    onSelectEffort: handleSelectEffort,
    selectedServiceTier: selectedServiceTier ?? null,
    reasoningSupported,
  };

  useComposerShortcuts({
    textareaRef: composerInputRef,
    ...composerShortcuts,
  });

  useComposerShortcuts({
    textareaRef: workspaceHomeTextareaRef,
    ...composerShortcuts,
  });

  useComposerMenuActions({
    models,
    selectedModelId,
    onSelectModel: handleSelectModel,
    collaborationModes,
    selectedCollaborationModeId,
    onSelectCollaborationMode: handleSelectCollaborationMode,
    accessMode,
    onSelectAccessMode: handleSelectAccessMode,
    reasoningOptions,
    selectedEffort,
    onSelectEffort: handleSelectEffort,
    reasoningSupported,
    onFocusComposer: () => composerInputRef.current?.focus(),
  });
  const {
    skills,
    agents,
    registryFingerprint,
    registryErrors,
    registryCacheHit,
    registryRefreshing,
    registryRefreshError,
    registryLastRefreshAtMs,
    refreshSkills,
  } = useSkills({
    activeWorkspace: projectActiveWorkspace,
    onDebug: addDebugEntry,
  });
  const workflowDiagnostics = useMemo(
    () => buildWorkflowRuntimeDiagnostics(debugEntries),
    [debugEntries],
  );
  const {
    prompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
    movePrompt,
    getWorkspacePromptsDir,
    getGlobalPromptsDir,
  } = useCustomPrompts({ activeWorkspace: projectActiveWorkspace, onDebug: addDebugEntry });
  const resolvedModel = selectedModel?.model ?? null;
  const resolvedEffort = reasoningSupported ? selectedEffort : null;

  const {
    handleThreadCodexMetadataDetected,
    codexArgsOptions,
    ensureWorkspaceRuntimeCodexArgs,
    getThreadArgsBadge,
  } = useMainAppThreadCodexState({
    appCodexArgs: appSettings.codexArgs,
    selectedCodexArgsOverride,
    getThreadCodexParams,
    patchThreadCodexParams,
  });
  const applyThreadListRuntimeResult = useCallback(
    (runtimeResult: WorkspaceRuntimeCodexArgsResult) => {
      const previous = threadListRuntimeContextRef.current;
      const sourceId = runtimeResult.sessionSourceId || previous.sourceId;
      const shouldAdvanceGeneration =
        runtimeResult.respawned || previous.sourceId !== sourceId;
      const next = {
        sourceId,
        runtimeGeneration:
          previous.runtimeGeneration + (shouldAdvanceGeneration ? 1 : 0),
      };
      if (
        next.sourceId === previous.sourceId &&
        next.runtimeGeneration === previous.runtimeGeneration
      ) {
        return;
      }
      threadListRuntimeContextRef.current = next;
      setThreadListRuntimeContext(next);
    },
    [],
  );
  const ensureWorkspaceRuntimeCodexArgsWithContinuity = useCallback(
    async (workspaceId: string, threadId: string | null) => {
      await waitForPendingSettingsSaves();
      const runtimeResult = await ensureWorkspaceRuntimeCodexArgs(
        workspaceId,
        threadId,
      );
      applyThreadListRuntimeResult(runtimeResult);
    },
    [
      applyThreadListRuntimeResult,
      ensureWorkspaceRuntimeCodexArgs,
      waitForPendingSettingsSaves,
    ],
  );
  const getThreadListRuntimeContext = useCallback(
    () => threadListRuntimeContextRef.current,
    [],
  );

  const { collaborationModePayload } = useCollaborationModeSelection({
    selectedCollaborationMode,
    selectedCollaborationModeId,
    selectedEffort: resolvedEffort,
    resolvedModel,
  });

  const {
    setActiveThreadId,
    hasLocalThreadSnapshot,
    activeThreadId,
    activeItems,
    threadHistoryPageByThread,
    loadOlderThreadHistory,
    itemsByThread,
    approvals,
    userInputRequests,
    threadsByWorkspace,
    threadParentById,
    isSubagentThread,
    threadStatusById,
    pendingTurnStartByThread,
    threadResumeLoadingById,
    threadListLoadingByWorkspace,
    threadListPagingByWorkspace,
    threadListCursorByWorkspace,
    threadListContinuityByWorkspace,
    activeTurnIdByThread,
    turnDiffByThread,
    turnExecutionSummaryByThread,
    turnExecutionSummariesByThread,
    tokenUsageByThread,
    completedContextCompactionIdsByThread,
    rateLimitsByWorkspace,
    accountByWorkspace,
    planByThread,
    interruptedThreadById,
    autoContinueStatusByThread,
    lastAgentMessageByThread,
    pinnedThreadsVersion,
    interruptTurn,
    setThreadAutoContinueEnabled,
    retryEditedUserMessage,
    removeThread,
    pinThread,
    unpinThread,
    isThreadPinned,
    getPinTimestamp,
    renameThread,
    startThreadForWorkspace,
    listThreadsForWorkspaces,
    listThreadsForWorkspace,
    resumeThreadById,
    loadOlderThreadsForWorkspace,
    resetWorkspaceThreads,
    refreshThread,
    sendUserMessage,
    sendUserMessageToThread,
    startFork,
    startReview,
    startUncommittedReview,
    startResume,
    startCompact,
    startApps,
    startMcp,
    startFast,
    startStatus,
    reviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
    handleApprovalDecision,
    handleApprovalRemember,
    handleUserInputSubmit,
    refreshAccountInfo,
    refreshAccountRateLimits,
  } = useThreads({
    activeWorkspace,
    workspaces,
    onWorkspaceConnected: markWorkspaceConnected,
    onDebug: addDebugEntry,
    model: resolvedModel,
    workflowProviderKind: activeCodexKeyProfile?.providerKind ?? "openai",
    workflowRuntimeMode: appSettings.workflowRuntimeMode ?? "shadow",
    computerControlRoutingEnabled: appSettings.computerControlRoutingEnabled !== false,
    workflowSkills: skills,
    workflowAgents: agents,
    getWorkflowGateId,
    tokenEfficiencyMode: appSettings.tokenEfficiencyMode ?? "quality",
    effort: resolvedEffort,
    serviceTier: selectedServiceTier,
    collaborationMode: collaborationModePayload,
    onSelectServiceTier: handleSelectServiceTier,
    accessMode,
    ensureWorkspaceRuntimeCodexArgs: ensureWorkspaceRuntimeCodexArgsWithContinuity,
    preserveSessionLibraryOnProviderSwitch:
      appSettings.preserveSessionLibraryOnProviderSwitch,
    getThreadListRuntimeContext,
    reviewDeliveryMode: appSettings.reviewDeliveryMode,
    steerEnabled: appSettings.steerEnabled,
    subagentCheckpointSyncMode: appSettings.subagentCheckpointSyncMode,
    threadTitleAutogenerationEnabled: appSettings.threadTitleAutogenerationEnabled,
    chatHistoryScrollbackItems: appSettingsLoading
      ? null
      : appSettings.chatHistoryScrollbackItems,
    autoArchiveThreadsEnabled: appSettings.autoArchiveThreadsEnabled,
    autoArchiveThreadsDays: appSettings.autoArchiveThreadsDays,
    customPrompts: prompts,
    onMessageActivity: handleThreadMessageActivity,
    threadSortKey: threadListSortKey,
    onThreadCodexMetadataDetected: handleThreadCodexMetadataDetected,
  });
  const selectedWorkflowGateId = projectActiveWorkspace && activeThreadId
    ? getWorkflowGateId(projectActiveWorkspace.id, activeThreadId)
    : null;
  const handleSelectWorkflowGateId = useCallback(
    (workflowId: string | null) => {
      if (!projectActiveWorkspace || !activeThreadId) {
        return;
      }
      patchThreadCodexParams(projectActiveWorkspace.id, activeThreadId, {
        workflowGateId: workflowId,
      });
    },
    [activeThreadId, patchThreadCodexParams, projectActiveWorkspace],
  );
  const handleVerifyWorkflowGate = useCallback(
    (workflowId: string) => {
      if (!projectActiveWorkspace) {
        return Promise.reject(new Error("workspace not found"));
      }
      return workflowGateStatus(projectActiveWorkspace.id, workflowId);
    },
    [projectActiveWorkspace],
  );
  const providerSessionDiagnostics = useMemo(
    () =>
      buildProviderSessionDiagnostics({
        workspaceName: activeWorkspace?.name ?? null,
        provider: activeCodexKeyProfile
          ? {
              name: activeCodexKeyProfile.name,
              providerKind: activeCodexKeyProfile.providerKind,
            }
          : null,
        runtimeContext: threadListRuntimeContext,
        continuity: activeWorkspaceId
          ? threadListContinuityByWorkspace[activeWorkspaceId]
          : undefined,
        continuityEnabled:
          appSettings.preserveSessionLibraryOnProviderSwitch,
      }),
    [
      activeCodexKeyProfile,
      activeWorkspace?.name,
      activeWorkspaceId,
      appSettings.preserveSessionLibraryOnProviderSwitch,
      threadListContinuityByWorkspace,
      threadListRuntimeContext,
    ],
  );
  const activeThreadIsProcessing = Boolean(
    activeThreadId && threadStatusById[activeThreadId]?.isProcessing,
  );
  const activeThreadHasPendingApproval = Boolean(
    activeThreadId &&
      activeWorkspaceId &&
      approvals.some((approval) => {
        if (approval.workspace_id !== activeWorkspaceId) {
          return false;
        }
        const params = approval.params;
        const threadId = String(params.threadId ?? params.thread_id ?? "").trim();
        return threadId === activeThreadId;
      }),
  );
  const activeThreadHasPendingUserInput = Boolean(
    activeThreadId &&
      activeWorkspaceId &&
      userInputRequests.some(
        (request) =>
          request.workspace_id === activeWorkspaceId &&
          request.params.thread_id === activeThreadId,
      ),
  );
  const activeThreadCurrentTurnId = activeThreadId
    ? activeTurnIdByThread[activeThreadId] ?? null
    : null;
  const activeThreadExecutionSummary = activeThreadId
    ? turnExecutionSummaryByThread[activeThreadId] ?? null
    : null;
  const activeThreadNeedsBackgroundRefresh = Boolean(
    activeThreadId &&
      (activeThreadIsProcessing ||
        threadStatusById[activeThreadId]?.isReviewing ||
        activeThreadCurrentTurnId ||
        activeThreadHasPendingApproval ||
        activeThreadHasPendingUserInput ||
        !activeThreadExecutionSummary ||
        activeThreadExecutionSummary.status === "active"),
  );
  const hasAnyProcessingThread = Object.values(threadStatusById).some(
    (status) => status?.isProcessing,
  );
  const handleProviderRuntimeSyncError = useCallback(
    (error: unknown) => {
      addDebugEntry({
        id: `${Date.now()}-provider-runtime-sync-error`,
        timestamp: Date.now(),
        source: "error",
        label: "provider runtime sync error",
        payload: error instanceof Error ? error.message : String(error),
      });
    },
    [addDebugEntry],
  );
  const appSettingsRef = useRef(appSettings);
  appSettingsRef.current = appSettings;
  const rollbackProviderRuntimeSettings = useCallback(
    (snapshot: ProviderRuntimeSettingsSnapshot) =>
      queueSaveSettings(
        restoreProviderRuntimeSettings(appSettingsRef.current, snapshot),
      ),
    [queueSaveSettings],
  );
  useProviderProfileRuntimeSync({
    activeProfile: activeCodexKeyProfile,
    activeWorkspace,
    activeThreadId,
    settingsLoading: appSettingsLoading,
    defer: hasAnyProcessingThread,
    syncLocalConfig: appSettings.syncProviderProfileToLocalConfig,
    settingsSnapshot: {
      activeCodexKeyProfileId: appSettings.activeCodexKeyProfileId,
      activeProfile: activeCodexKeyProfile,
      syncProviderProfileToLocalConfig:
        appSettings.syncProviderProfileToLocalConfig,
    },
    syncWorkspaceRuntime: ensureWorkspaceRuntimeCodexArgsWithContinuity,
    rollbackSettings: rollbackProviderRuntimeSettings,
    onError: handleProviderRuntimeSyncError,
  });
  const refreshedThreadListRuntimeGenerationRef = useRef(0);
  useEffect(() => {
    if (
      threadListRuntimeContext.runtimeGeneration <= 0 ||
      refreshedThreadListRuntimeGenerationRef.current ===
        threadListRuntimeContext.runtimeGeneration
    ) {
      return;
    }
    const connectedWorkspaces = workspaces.filter(
      (workspace) => workspace.connected,
    );
    if (connectedWorkspaces.length === 0) {
      return;
    }
    refreshedThreadListRuntimeGenerationRef.current =
      threadListRuntimeContext.runtimeGeneration;
    void listThreadsForWorkspaces(connectedWorkspaces, {
      preserveState: true,
      refreshReason: "app_server_runtime_refresh",
    });
  }, [
    listThreadsForWorkspaces,
    threadListRuntimeContext.runtimeGeneration,
    workspaces,
  ]);
  const { connectionState: remoteThreadConnectionState, reconnectLive } =
    useRemoteThreadLiveConnection({
      backendMode: appSettings.backendMode,
      activeWorkspace,
      activeThreadId,
      activeThreadHasLocalSnapshot: hasLocalThreadSnapshot(activeThreadId),
      activeThreadIsProcessing,
      activeThreadNeedsLiveConnection: activeThreadNeedsBackgroundRefresh,
      refreshThread,
      reconnectWorkspace: connectWorkspace,
    });

  const { mobileThreadRefreshLoading, handleMobileThreadRefresh } =
    useMainAppMobileThreadRefresh({
      activeWorkspace,
      activeThreadId,
      startThreadForWorkspace,
      refreshThread,
      reconnectLive,
    });
  const {
    updaterState,
    startUpdate,
    checkForUpdates,
    dismissUpdate,
    postUpdateNotice,
    dismissPostUpdateNotice,
    handleTestNotificationSound,
    handleTestSystemNotification,
  } = useUpdaterController({
    enabled: updaterEnabled,
    autoCheckOnMount:
      !appSettingsLoading && appSettings.automaticAppUpdateChecksEnabled,
    experimentalWindowsInstallerMigrationEnabled:
      appSettings.experimentalWindowsInstallerMigrationEnabled,
    notificationSoundsEnabled: appSettings.notificationSoundsEnabled,
    systemNotificationsEnabled: appSettings.systemNotificationsEnabled,
    subagentSystemNotificationsEnabled:
      appSettings.subagentSystemNotificationsEnabled,
    isSubagentThread,
    getWorkspaceName,
    updateNotificationTitle: t("update.title"),
    upToDateNotificationBody: t("update.latest"),
    updateAvailableNotificationBody: t("update.available"),
    onDebug: addDebugEntry,
    successSoundUrl,
    errorSoundUrl,
  });
  const gitState = useMainAppGitState({
    activeWorkspace: projectActiveWorkspace,
    activeWorkspaceId,
    activeItems,
    activeThreadId,
    activeTab,
    tabletTab,
    isCompact,
    isTablet,
    setActiveTab,
    appSettings: {
      preloadGitDiffs: appSettings.preloadGitDiffs,
      gitDiffIgnoreWhitespaceChanges: appSettings.gitDiffIgnoreWhitespaceChanges,
      splitChatDiffView: appSettings.splitChatDiffView,
      reviewDeliveryMode: appSettings.reviewDeliveryMode,
    },
    addDebugEntry,
    updateWorkspaceSettings,
    commitMessageModelId,
    connectWorkspace,
    startThreadForWorkspace,
    sendUserMessageToThread,
  });
  const {
    activeWorkspaceRef,
    activeWorkspaceIdRef,
    queueGitStatusRefresh,
    alertError,
    centerMode,
    setCenterMode,
    selectedDiffPath,
    setSelectedDiffPath,
    gitPanelMode,
    setGitPanelMode,
    gitDiffViewStyle,
    setGitDiffViewStyle,
    filePanelMode,
    selectedPullRequest,
    setSelectedPullRequest,
    selectedCommitSha,
    diffSource,
    setDiffSource,
    gitStatus,
    gitLogEntries,
    gitLogAheadEntries,
    gitLogBehindEntries,
    shouldLoadDiffs,
    activeDiffs,
    activeDiffLoading,
    activeDiffError,
    shouldLoadGitHubPanelData,
    handleGitIssuesChange,
    handleGitPullRequestsChange,
    handleGitPullRequestDiffsChange,
    handleGitPullRequestCommentsChange,
    refreshGitRemote,
    branches,
    currentBranch,
    isBranchSwitcherEnabled,
    handleCheckoutBranch,
    handleCreateGitHubRepo,
    createGitHubRepoLoading,
    handleInitGitRepo,
    initGitRepoLoading,
    isLaunchingPullRequestReview,
    pullRequestReviewActions,
    runPullRequestReview,
  } = gitState;
  queueGitStatusRefreshRef.current = queueGitStatusRefresh;
  const { isExpanded: composerEditorExpanded, toggleExpanded: toggleComposerEditorExpanded } =
    useComposerEditorState();

  const composerEditorSettings = useMemo<ComposerEditorSettings>(
    () => ({
      preset: appSettings.composerEditorPreset,
      expandFenceOnSpace: appSettings.composerFenceExpandOnSpace,
      expandFenceOnEnter: appSettings.composerFenceExpandOnEnter,
      fenceLanguageTags: appSettings.composerFenceLanguageTags,
      fenceWrapSelection: appSettings.composerFenceWrapSelection,
      autoWrapPasteMultiline: appSettings.composerFenceAutoWrapPasteMultiline,
      autoWrapPasteCodeLike: appSettings.composerFenceAutoWrapPasteCodeLike,
      largePasteBehavior: appSettings.composerLargePasteBehavior ?? "smart",
      continueListOnShiftEnter: appSettings.composerListContinuation,
    }),
    [
      appSettings.composerEditorPreset,
      appSettings.composerFenceExpandOnSpace,
      appSettings.composerFenceExpandOnEnter,
      appSettings.composerFenceLanguageTags,
      appSettings.composerFenceWrapSelection,
      appSettings.composerFenceAutoWrapPasteMultiline,
      appSettings.composerFenceAutoWrapPasteCodeLike,
      appSettings.composerLargePasteBehavior,
      appSettings.composerListContinuation,
    ],
  );

  const { apps } = useApps({
    activeWorkspace: projectActiveWorkspace,
    activeThreadId,
    enabled: appSettings.experimentalAppsEnabled,
    onDebug: addDebugEntry,
  });

  useThreadCodexSyncOrchestration({
    activeWorkspaceId,
    activeThreadId,
    appSettings: {
      defaultAccessMode: appSettings.defaultAccessMode,
      lastComposerModelId: activeCodexKeyProfile?.model ?? appSettings.lastComposerModelId,
      lastComposerReasoningEffort: appSettings.lastComposerReasoningEffort,
    },
    threadCodexParamsVersion,
    getThreadCodexParams,
    patchThreadCodexParams,
    setThreadCodexSelectionKey,
    setAccessMode,
    setPreferredModelId,
    setPreferredEffort,
    setPreferredServiceTier,
    setPreferredCollabModeId,
    setPreferredCodexArgsOverride,
    activeThreadIdRef,
    pendingNewThreadSeedRef,
    selectedServiceTier,
    accessMode,
    selectedCollaborationModeId,
    selectedCodexArgsOverride,
  });

  const { handleRefreshAllWorkspaceThreads } = useThreadListActions({
    threadListSortKey,
    setThreadListSortKey,
    workspaces,
    refreshWorkspaces,
    connectWorkspace,
    listThreadsForWorkspaces,
    resetWorkspaceThreads,
  });
  useResponseRequiredNotificationsController({
    systemNotificationsEnabled: appSettings.systemNotificationsEnabled,
    subagentSystemNotificationsEnabled:
      appSettings.subagentSystemNotificationsEnabled,
    isSubagentThread,
    approvals,
    userInputRequests,
    getWorkspaceName,
    onDebug: addDebugEntry,
  });

  const {
    activeAccount,
    accountSwitching,
    handleSwitchAccount,
  } = useAccountSwitching({
    activeWorkspaceId,
    accountByWorkspace,
    refreshAccountInfo,
    refreshAccountRateLimits,
    alertError,
  });
  const {
    newAgentDraftWorkspaceId,
    startingDraftThreadWorkspaceId,
    startingDraftMessageByWorkspace,
    isDraftModeForActiveWorkspace: isNewAgentDraftMode,
    startNewAgentDraft,
    clearDraftState,
    clearDraftStateIfDifferentWorkspace,
    runWithDraftStart,
  } = useNewAgentDraft({
    activeWorkspace,
    activeWorkspaceId,
    activeThreadId,
  });
  const { getThreadRows } = useThreadRows(threadParentById);

  useTrayLabels({ labels: trayLabels });

  useAutoExitEmptyDiff({
    centerMode,
    autoExitEnabled: diffSource === "local",
    activeDiffCount: activeDiffs.length,
    activeDiffLoading,
    activeDiffError,
    activeThreadId,
    isCompact,
    setCenterMode,
    setSelectedDiffPath,
    setActiveTab,
  });

  const {
    renamePrompt: renameWorktreePrompt,
    notice: renameWorktreeNotice,
    upstreamPrompt: renameWorktreeUpstreamPrompt,
    confirmUpstream: confirmRenameWorktreeUpstream,
    openRenamePrompt: openRenameWorktreePrompt,
    handleRenameChange: handleRenameWorktreeChange,
    handleRenameCancel: handleRenameWorktreeCancel,
    handleRenameConfirm: handleRenameWorktreeConfirm,
  } = useRenameWorktreePrompt({
    workspaces,
    activeWorkspaceId,
    renameWorktree,
    renameWorktreeUpstream,
    onRenameSuccess: (workspace) => {
      resetWorkspaceThreads(workspace.id);
      void listThreadsForWorkspace(workspace);
      if (activeThreadId && activeWorkspaceId === workspace.id) {
        void refreshThread(workspace.id, activeThreadId);
      }
    },
  });

  const handleOpenRenameWorktree = useCallback(() => {
    if (activeWorkspace) {
      openRenameWorktreePrompt(activeWorkspace.id);
    }
  }, [activeWorkspace, openRenameWorktreePrompt]);

  const {
    terminalTabs,
    activeTerminalId,
    onSelectTerminal,
    onNewTerminal,
    onCloseTerminal,
    terminalState,
    ensureTerminalWithTitle,
    restartTerminalSession,
    requestTerminalFocus,
    onOpenExternalTerminal,
  } = useTerminalController({
    activeWorkspaceId,
    activeWorkspace,
    terminalOpen,
    onCloseTerminalPanel: closeTerminalPanel,
    onDebug: addDebugEntry,
  });

  const ensureLaunchTerminal = useCallback(
    (workspaceId: string) => ensureTerminalWithTitle(workspaceId, "launch", "Launch"),
    [ensureTerminalWithTitle],
  );

  const openTerminalWithFocus = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    requestTerminalFocus();
    openTerminal();
  }, [activeWorkspaceId, openTerminal, requestTerminalFocus]);

  const handleToggleTerminalWithFocus = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    if (!terminalOpen) {
      requestTerminalFocus();
    }
    handleToggleTerminal();
  }, [
    activeWorkspaceId,
    handleToggleTerminal,
    requestTerminalFocus,
    terminalOpen,
  ]);

  const launchScriptState = useWorkspaceLaunchScript({
    activeWorkspace,
    updateWorkspaceSettings,
    openTerminal: openTerminalWithFocus,
    ensureLaunchTerminal,
    restartLaunchSession: restartTerminalSession,
    terminalState,
    activeTerminalId,
  });

  const launchScriptsState = useWorkspaceLaunchScripts({
    activeWorkspace,
    updateWorkspaceSettings,
    openTerminal: openTerminalWithFocus,
    ensureLaunchTerminal: (workspaceId, entry, title) => {
      const label = entry.label?.trim() || entry.icon;
      return ensureTerminalWithTitle(
        workspaceId,
        `launch:${entry.id}`,
        title || `Launch ${label}`,
      );
    },
    restartLaunchSession: restartTerminalSession,
    terminalState,
    activeTerminalId,
  });

  const worktreeSetupScriptState = useWorktreeSetupScript({
    ensureTerminalWithTitle,
    restartTerminalSession,
    openTerminal,
    onDebug: addDebugEntry,
  });

  const handleWorktreeCreated = useCallback(
    async (worktree: WorkspaceInfo, _parentWorkspace?: WorkspaceInfo) => {
      await worktreeSetupScriptState.maybeRunWorktreeSetupScript(worktree);
    },
    [worktreeSetupScriptState],
  );

  const { exitDiffView, selectWorkspace, selectHome } = useWorkspaceSelection({
    workspaces,
    isCompact,
    activeWorkspaceId,
    setActiveTab,
    setActiveWorkspaceId,
    updateWorkspaceSettings,
    setCenterMode,
    setSelectedDiffPath,
  });

  const [resumeThreadPrompt, setResumeThreadPrompt] = useState<{
    workspace: WorkspaceInfo;
    threadId: string;
    error: string | null;
    isBusy: boolean;
  } | null>(null);
  const openResumeThreadPrompt = useCallback((workspace: WorkspaceInfo) => {
    setResumeThreadPrompt({ workspace, threadId: "", error: null, isBusy: false });
  }, []);
  const closeResumeThreadPrompt = useCallback(() => {
    setResumeThreadPrompt((current) => (current?.isBusy ? current : null));
  }, []);
  const updateResumeThreadPrompt = useCallback((threadId: string) => {
    setResumeThreadPrompt((current) =>
      current ? { ...current, threadId, error: null } : current,
    );
  }, []);
  const confirmResumeThreadPrompt = useCallback(async () => {
    if (!resumeThreadPrompt || resumeThreadPrompt.isBusy) {
      return;
    }
    const threadId = resumeThreadPrompt.threadId.trim();
    if (!threadId) {
      return;
    }
    const workspace = resumeThreadPrompt.workspace;
    setResumeThreadPrompt((current) =>
      current ? { ...current, isBusy: true, error: null } : current,
    );
    try {
      if (!workspace.connected) {
        await connectWorkspace(workspace);
      }
      const restoredThreadId = await resumeThreadById(workspace.id, threadId);
      if (!restoredThreadId) {
        throw new Error("thread/resume returned no thread");
      }
      setResumeThreadPrompt(null);
    } catch (error) {
      setResumeThreadPrompt((current) =>
        current
          ? {
              ...current,
              isBusy: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }, [connectWorkspace, resumeThreadById, resumeThreadPrompt]);
  const handleResumeManagedSession = useCallback(async (session: ManagedSession) => {
    try {
      const result = await resumeManagedSession({
        sourceId: session.sourceId,
        threadId: session.threadId,
      });
      await refreshWorkspaces();
      markWorkspaceConnected(result.workspace.id);
      const restoredThreadId = await resumeThreadById(
        result.workspace.id,
        result.threadId,
      );
      if (!restoredThreadId) {
        throw new Error("thread/resume returned no thread");
      }
      renameThread(result.workspace.id, restoredThreadId, session.title);
      setManagedSessionSourceByThread((current) => ({
        ...current,
        [`${result.workspace.id}:${restoredThreadId}`]: result.sourceName,
      }));
      exitDiffView();
      selectWorkspace(result.workspace.id);
      setActiveThreadId(restoredThreadId, result.workspace.id);
      if (isCompact) setActiveTab("codex");
      return true;
    } catch (error) {
      alertError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [alertError, exitDiffView, isCompact, markWorkspaceConnected, refreshWorkspaces, renameThread, resumeThreadById, selectWorkspace, setActiveTab, setActiveThreadId]);
  const handleDeriveManagedSessions = useCallback(async (sessions: ManagedSession[]) => {
    if (sessions.length === 0) return;
    if (!activeWorkspace) {
      alertError(t("sessionManager.deriveNeedsWorkspace"));
      return;
    }
    try {
      const previews = await Promise.all(sessions.map((session) => prepareManagedSessionDerivation({
        sourceId: session.sourceId,
        threadId: session.threadId,
      })));
      setManagedSessionDerivation({
        previews,
        destination: activeWorkspace,
        error: null,
        isBusy: false,
      });
    } catch (error) {
      alertError(error instanceof Error ? error.message : String(error));
    }
  }, [activeWorkspace, alertError, t]);
  const handleDeriveManagedSession = useCallback((session: ManagedSession) => {
    void handleDeriveManagedSessions([session]);
  }, [handleDeriveManagedSessions]);
  const confirmManagedSessionDerivation = useCallback(async () => {
    if (!managedSessionDerivation || managedSessionDerivation.isBusy) return;
    const { destination, previews } = managedSessionDerivation;
    setManagedSessionDerivation((current) => current ? { ...current, error: null, isBusy: true } : current);
    let remainingPreviews = previews;
    let latestThreadId: string | null = null;
    let nextDerivations = threadDerivations;
    try {
      for (const preview of previews) {
        latestThreadId = await deriveManagedSessionIntoWorkspace({
          destination,
          preview,
          connectWorkspace,
          startThreadForWorkspace,
          sendUserMessageToThread,
          persistDerivation: (workspaceId, derivedThreadId, metadata) => {
            nextDerivations = saveThreadDerivation(workspaceId, derivedThreadId, metadata);
          },
          startError: t("sessionManager.deriveStartFailed"),
          sendError: t("sessionManager.deriveSendFailed"),
        });
        remainingPreviews = remainingPreviews.slice(1);
      }
      setThreadDerivations(nextDerivations);
      exitDiffView();
      selectWorkspace(destination.id);
      if (latestThreadId) setActiveThreadId(latestThreadId, destination.id);
      if (isCompact) setActiveTab("codex");
      setManagedSessionDerivation(null);
    } catch (error) {
      setThreadDerivations(nextDerivations);
      setManagedSessionDerivation((current) => current ? {
        ...current,
        previews: remainingPreviews,
        error: error instanceof Error ? error.message : String(error),
        isBusy: false,
      } : current);
    }
  }, [connectWorkspace, exitDiffView, isCompact, managedSessionDerivation, selectWorkspace, sendUserMessageToThread, setActiveTab, setActiveThreadId, startThreadForWorkspace, t, threadDerivations]);
  const resolveCloneProjectContext = useCallback(
    (workspace: WorkspaceInfo) => {
      const groupId = workspace.settings.groupId ?? null;
      const group = groupId
        ? appSettings.workspaceGroups.find((entry) => entry.id === groupId)
        : null;
      return {
        groupId,
        copiesFolder: group?.copiesFolder ?? null,
      };
    },
    [appSettings.workspaceGroups],
  );

  const { handleMoveWorkspace } = useWorkspaceOrderingOrchestration({
    workspaces,
    workspacesById,
    updateWorkspaceSettings,
  });

  const {
    handleSelectOpenAppId,
    handleToggleAutomaticAppUpdateChecks,
    persistProjectCopiesFolder,
  } = useMainAppSettingsActions({
    appSettings,
    setAppSettings,
    queueSaveSettings,
  });

  const openAppIconById = useOpenAppIcons(appSettings.openAppTargets);

  const {
    workspaceFromUrlPrompt,
    openWorkspaceFromUrlPrompt,
    closeWorkspaceFromUrlPrompt,
    chooseWorkspaceFromUrlDestinationPath,
    submitWorkspaceFromUrlPrompt,
    updateWorkspaceFromUrlUrl,
    updateWorkspaceFromUrlTargetFolderName,
    clearWorkspaceFromUrlDestinationPath,
    canSubmitWorkspaceFromUrlPrompt,
  } = useWorkspaceFromUrlPrompt({
    onSubmit: async (url, destinationPath, targetFolderName) => {
      await handleAddWorkspaceFromGitUrl(url, destinationPath, targetFolderName);
    },
  });

  const { appModalsProps: baseAppModalsProps, modalActions } = useMainAppModals({
    settingsViewComponent: SettingsView,
    workspaces: storedWorkspaces,
    workspaceGroups,
    groupedWorkspaces: storedGroupedWorkspaces,
    ungroupedLabel,
    activeWorkspace: storedActiveWorkspace,
    setActiveWorkspaceId,
    branches,
    currentBranch,
    threadRename: {
      threadsByWorkspace,
      renameThread,
    },
    git: {
      checkoutBranch: handleCheckoutBranch,
      initGitRepo: handleInitGitRepo,
      createGitHubRepo: handleCreateGitHubRepo,
      refreshGitRemote,
      initGitRepoLoading,
      createGitHubRepoLoading,
    },
    workspacePrompts: {
      addWorktreeAgent,
      addCloneAgent,
      connectWorkspace,
      updateWorkspaceSettings,
      selectWorkspace,
      handleWorktreeCreated,
      resolveCloneProjectContext,
      persistProjectCopiesFolder,
      onCompactActivate: isCompact ? () => setActiveTab("codex") : undefined,
      onWorkspacePromptError: (message, kind) => {
        addDebugEntry({
          id: `${Date.now()}-client-add-${kind}-error`,
          timestamp: Date.now(),
          source: "error",
          label: `${kind}/add error`,
          payload: message,
        });
      },
      mobileRemoteWorkspacePathPrompt,
      updateMobileRemoteWorkspacePathInput,
      appendMobileRemoteWorkspacePathFromRecent,
      cancelMobileRemoteWorkspacePathPrompt,
      submitMobileRemoteWorkspacePathPrompt,
      openWorkspaceFromUrlPrompt,
      workspaceFromUrl: {
        workspaceFromUrlPrompt,
        workspaceFromUrlCanSubmit: canSubmitWorkspaceFromUrlPrompt,
        onWorkspaceFromUrlPromptUrlChange: updateWorkspaceFromUrlUrl,
        onWorkspaceFromUrlPromptTargetFolderNameChange:
          updateWorkspaceFromUrlTargetFolderName,
        onWorkspaceFromUrlPromptChooseDestinationPath:
          chooseWorkspaceFromUrlDestinationPath,
        onWorkspaceFromUrlPromptClearDestinationPath:
          clearWorkspaceFromUrlDestinationPath,
        onWorkspaceFromUrlPromptCancel: closeWorkspaceFromUrlPrompt,
        onWorkspaceFromUrlPromptConfirm: submitWorkspaceFromUrlPrompt,
      },
    },
    settings: {
      handleMoveWorkspace,
      removeWorkspace,
      createWorkspaceGroup,
      renameWorkspaceGroup,
      moveWorkspaceGroup,
      deleteWorkspaceGroup,
      assignWorkspaceGroup,
      reduceTransparency,
      setReduceTransparency,
      appSettings,
      openAppIconById,
      queueSaveSettings,
      handleToggleAutomaticAppUpdateChecks,
      updater: {
        enabled: updaterEnabled,
        state: updaterState,
        checkForUpdates,
        startUpdate,
        dismiss: dismissUpdate,
      },
      doctor,
      codexUpdate,
      updateWorkspaceSettings,
      scaleShortcutTitle,
      scaleShortcutText,
      handleTestNotificationSound,
      handleTestSystemNotification,
      handleMobileConnectSuccess,
      dictationModel,
      providerSessionDiagnostics,
      workflowSectionProps: {
        workspaceName: projectActiveWorkspace?.name ?? null,
        providerKind: activeCodexKeyProfile?.providerKind ?? "openai",
        model: resolvedModel,
        skills,
        agents,
        registryFingerprint,
        registryErrors,
        registryCacheHit,
        registryRefreshing,
        registryRefreshError,
        registryLastRefreshAtMs,
        diagnostics: workflowDiagnostics,
        onRefreshRegistry: refreshSkills,
      },
    },
  });

  useBranchSwitcherShortcut({
    shortcut: appSettings.branchSwitcherShortcut,
    isEnabled: isBranchSwitcherEnabled,
    onTrigger: modalActions.openBranchSwitcher,
  });

  const handleRenameThread = useCallback(
    (workspaceId: string, threadId: string) => {
      modalActions.openRenamePrompt(workspaceId, threadId);
    },
    [modalActions],
  );

  const showHome = !activeWorkspace;
  const {
    latestAgentRuns,
    isLoadingLatestAgents,
    usageMetric,
    setUsageMetric,
    usageWorkspaceId,
    setUsageWorkspaceId,
    usageWorkspaceOptions,
    localUsageSnapshot,
    isLoadingLocalUsage,
    localUsageError,
    refreshLocalUsage,
  } = useWorkspaceInsightsOrchestration({
    workspaces,
    workspacesById,
    hasLoaded,
    showHome,
    threadsByWorkspace,
    lastAgentMessageByThread,
    threadStatusById,
    threadListLoadingByWorkspace,
    getWorkspaceGroupName,
  });

  const activeRateLimits = activeWorkspaceId
    ? rateLimitsByWorkspace[activeWorkspaceId] ?? null
    : null;
  const {
    homeAccount,
    homeAccountWorkspaceId,
    homeRateLimits,
  } = useHomeAccount({
    showHome,
    usageWorkspaceId,
    workspaces,
    threadsByWorkspace,
    threadListLoadingByWorkspace,
    rateLimitsByWorkspace,
    accountByWorkspace,
    refreshAccountInfo,
    refreshAccountRateLimits,
    refreshDelayMs: showHome ? 800 : 0,
  });
  const activeTokenUsage = activeThreadId
    ? tokenUsageByThread[activeThreadId] ?? null
    : null;
  const activeContextCompactionCount = activeThreadId
    ? Object.keys(
        completedContextCompactionIdsByThread[activeThreadId] ?? {},
      ).length
    : 0;
  const activePlan = activeThreadId
    ? planByThread[activeThreadId] ?? null
    : null;
  const activeTurnId = activeThreadId
    ? activeTurnIdByThread[activeThreadId] ?? null
    : null;
  const activePlanStream = getActivePlanStream(activeItems);
  const hasActivePlan = Boolean(
    (activePlan && (activePlan.steps.length > 0 || activePlan.explanation)) || activePlanStream
  );
  const composerWorkspaceState = useMainAppComposerWorkspaceState({
    view: {
      activeTab,
      tabletTab,
      centerMode,
      isCompact,
      isTablet,
      rightPanelCollapsed,
      filePanelMode,
    },
    workspace: {
      activeWorkspace,
      activeWorkspaceId,
      isNewAgentDraftMode,
      startingDraftThreadWorkspaceId,
      threadsByWorkspace,
    },
    thread: {
      activeThreadId,
      activeItems,
      threadStatusById,
      activeTurnIdByThread,
      userInputRequests,
    },
    settings: {
      steerEnabled: appSettings.steerEnabled,
      followUpMessageBehavior: appSettings.followUpMessageBehavior,
      composerTriggerMode: appSettings.composerTriggerMode,
      experimentalAppsEnabled: appSettings.experimentalAppsEnabled,
      pauseQueuedMessagesWhenResponseRequired:
        appSettings.pauseQueuedMessagesWhenResponseRequired,
    },
    models: {
      models,
      selectedModelId,
      resolvedEffort,
      selectedServiceTier,
      collaborationModePayload,
    },
    refs: {
      composerInputRef,
      workspaceHomeTextareaRef,
    },
    actions: {
      connectWorkspace,
      startThreadForWorkspace,
      sendUserMessage,
      sendUserMessageToThread,
      seedThreadCodexParams: patchThreadCodexParams,
      startFork,
      startReview,
      startResume,
      startCompact,
      startApps,
      startMcp,
      startFast,
      startStatus,
      addWorktreeAgent,
      handleWorktreeCreated,
      addDebugEntry,
    },
  });
  const {
    files,
    setFileAutocompleteActive,
    showWorkspaceHome,
    showComposer,
    canInterrupt,
    recentThreadInstances,
    recentThreadsUpdatedAt,
    clearActiveImages,
    removeImagesForThread,
    handleSend,
    setPrefillDraft,
    clearDraftForThread,
    workspaceHomeState,
    agentMdState,
  } = composerWorkspaceState;
  const {
    runs: workspaceRuns,
    draft: workspacePrompt,
    runMode: workspaceRunMode,
    modelSelections: workspaceModelSelections,
    error: workspaceRunError,
    isSubmitting: workspaceRunSubmitting,
    setDraft: setWorkspacePrompt,
    setRunMode: setWorkspaceRunMode,
    toggleModelSelection: toggleWorkspaceModelSelection,
    setModelCount: setWorkspaceModelCount,
    startRun: startWorkspaceRun,
  } = workspaceHomeState;
  const {
    content: agentMdContent,
    exists: agentMdExists,
    truncated: agentMdTruncated,
    isLoading: agentMdLoading,
    isSaving: agentMdSaving,
    error: agentMdError,
    isDirty: agentMdDirty,
    setContent: setAgentMdContent,
    refresh: refreshAgentMd,
    save: saveAgentMd,
  } = agentMdState;
  const promptActions = useMainAppPromptActions({
    activeWorkspace,
    connectWorkspace,
    startThreadForWorkspace,
    sendUserMessageToThread,
    alertError,
    createPrompt,
    updatePrompt,
    deletePrompt,
    movePrompt,
    getWorkspacePromptsDir,
    getGlobalPromptsDir,
  });
  const worktreeState = useMainAppWorktreeState({
    activeWorkspace,
    workspacesById,
    renameWorktreePrompt,
    renameWorktreeNotice,
    renameWorktreeUpstreamPrompt,
    confirmRenameWorktreeUpstream,
    handleOpenRenameWorktree,
    handleRenameWorktreeChange,
    handleRenameWorktreeCancel,
    handleRenameWorktreeConfirm,
  });
  const { baseWorkspaceRef } = worktreeState;

  const { initialWorkspaceRestoreComplete } = useMainAppWorkspaceLifecycle({
    activeTab,
    isTablet,
    setActiveTab,
    workspaces,
    hasLoaded,
    connectWorkspace,
    listThreadsForWorkspaces,
    refreshWorkspaces,
    backendMode: appSettings.backendMode,
    activeWorkspace,
    activeThreadId,
    threadStatusById,
    activeThreadNeedsBackgroundRefresh,
    remoteThreadConnectionState,
    refreshThread,
  });
  const handleMessageReference = useCallback(async (action: MessageReferenceAction) => {
    if (!activeWorkspace || !activeThreadId) return;
    const sourceThreadId = activeThreadId;
    try {
      let nextDerivations = threadDerivations;
      const threadId = await applyMessageReference({
        action,
        workspace: activeWorkspace,
        sourceThreadId,
        createSnapshot: (content, sourceTitle) => createMessageReference({
          workspaceId: activeWorkspace.id,
          sourceThreadId,
          sourceMessageId: action.messageId,
          sourceRole: action.sourceRole,
          sourceTitle,
          content,
        }),
        insertCurrent: () => undefined,
        onReferenceCreated: (reference) => composerWorkspaceState.addComposerReferenceForDraft(sourceThreadId, reference),
        insertNew: () => undefined,
        onNewReferenceCreated: composerWorkspaceState.addComposerReferenceForDraft,
        startThreadForWorkspace,
        persistDerivation: (workspaceId, derivedThreadId, metadata) => {
          nextDerivations = saveThreadDerivation(workspaceId, derivedThreadId, metadata);
        },
        startError: t("messages.referenceStartFailed"),
      });
      if (!threadId) return;
      setThreadDerivations(nextDerivations);
      exitDiffView();
      selectWorkspace(activeWorkspace.id);
      setActiveThreadId(threadId, activeWorkspace.id);
      if (isCompact) setActiveTab("codex");
    } catch (error) {
      alertError(error instanceof Error ? error.message : String(error));
    }
  }, [activeThreadId, activeWorkspace, alertError, composerWorkspaceState, exitDiffView, isCompact, selectWorkspace, setActiveTab, setActiveThreadId, startThreadForWorkspace, t, threadDerivations]);

  const handleInstallManagedCodex = useCallback(async () => {
    setCodexInstallStage("downloading");
    setCodexInstallError(null);
    setCodexInstallProgress(0);
    const requestId = `${Date.now()}-managed-codex`;
    codexInstallRequestIdRef.current = requestId;
    try {
      const platform = await getManagedCodexPlatform();
      const packageInfo = await fetchManagedCodexPackage(platform);
      const installed = await installManagedCodex(
        packageInfo.urls,
        packageInfo.fileName,
        requestId,
        packageInfo.version,
        packageInfo.size,
        packageInfo.sha256,
      );
      await queueSaveSettings({ ...appSettings, codexBin: installed.path });
      setAppSettings((current) => ({ ...current, codexBin: installed.path }));
      setCodexInstallPromptOpen(false);
      setCodexInstallStage("ready");
    } catch (error) {
      setCodexInstallStage("error");
      setCodexInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      codexInstallRequestIdRef.current = null;
    }
  }, [appSettings, queueSaveSettings, setAppSettings]);
  useSessionCleanupScheduler({
    settingsLoading: appSettingsLoading,
    startupReady: initialWorkspaceRestoreComplete,
    enabled: appSettings.autoDeleteArchivedThreadsEnabled,
    activeThreadId,
    threadStatusById,
    pinnedThreadsVersion,
  });

  const {
    handleAddWorkspace,
    handleAddWorkspaceFromGitUrl,
    handleAddAgent,
    handleAddWorktreeAgent,
    handleAddCloneAgent,
    dropTargetRef: workspaceDropTargetRef,
    isDragOver: isWorkspaceDropActive,
    handleDragOver: handleWorkspaceDragOver,
    handleDragEnter: handleWorkspaceDragEnter,
    handleDragLeave: handleWorkspaceDragLeave,
    handleDrop: handleWorkspaceDrop,
  } = useMainAppWorkspaceActions({
    workspaceActions: {
      isCompact,
      addWorkspace,
      addWorkspaceFromPath,
      addWorkspaceFromGitUrl,
      addWorkspacesFromPaths,
      setActiveThreadId,
      setActiveTab,
      exitDiffView,
      selectWorkspace,
      onStartNewAgentDraft: startNewAgentDraft,
      openWorktreePrompt: modalActions.openWorktreePrompt,
      openClonePrompt: modalActions.openClonePrompt,
      composerInputRef,
      onDebug: addDebugEntry,
    },
  });

  useInterruptShortcut({
    isEnabled: canInterrupt,
    shortcut: appSettings.interruptShortcut,
    onTrigger: () => {
      void interruptTurn();
    },
  });

  const selectedCommitEntry = useMemo(() => {
    if (!selectedCommitSha) {
      return null;
    }
    return (
      [...gitLogAheadEntries, ...gitLogBehindEntries, ...gitLogEntries].find(
        (entry) => entry.sha === selectedCommitSha,
      ) ?? null
    );
  }, [gitLogAheadEntries, gitLogBehindEntries, gitLogEntries, selectedCommitSha]);

  const {
    handleSelectPullRequest,
    resetPullRequestSelection,
    composerContextActions,
    composerSendLabel,
    handleComposerSend,
  } = usePullRequestComposer({
    activeWorkspace,
    selectedPullRequest,
    selectedCommit: selectedCommitEntry,
    filePanelMode,
    gitPanelMode,
    centerMode,
    isCompact,
    setSelectedPullRequest,
    setDiffSource,
    setSelectedDiffPath,
    setCenterMode,
    setGitPanelMode,
    setPrefillDraft,
    setActiveTab,
    pullRequestReviewActions,
    pullRequestReviewLaunching: isLaunchingPullRequestReview,
    runPullRequestReview,
    startReview,
    clearActiveImages,
    handleSend,
  });

  const {
    handleComposerSendWithDraftStart,
    handleSelectWorkspaceInstance,
    handleOpenThreadLink,
    handleArchiveActiveThread,
  } = useThreadUiOrchestration({
    activeWorkspaceId,
    activeThreadId,
    accessMode,
    selectedServiceTier,
    selectedCollaborationModeId,
    selectedCodexArgsOverride,
    pendingNewThreadSeedRef,
    runWithDraftStart,
    handleComposerSend,
    clearDraftState,
    exitDiffView,
    resetPullRequestSelection,
    selectWorkspace,
    setActiveThreadId,
    setActiveTab,
    isCompact,
    removeThread,
    clearDraftForThread,
    removeImagesForThread,
  });
  const appModalsProps = useMemo(
    () => ({
      ...baseAppModalsProps,
      resumeThreadPrompt: resumeThreadPrompt
        ? {
            workspaceName: resumeThreadPrompt.workspace.name,
            threadId: resumeThreadPrompt.threadId,
            error: resumeThreadPrompt.error,
            isBusy: resumeThreadPrompt.isBusy,
          }
        : null,
      onResumeThreadPromptChange: updateResumeThreadPrompt,
      onResumeThreadPromptCancel: closeResumeThreadPrompt,
      onResumeThreadPromptConfirm: () => {
        void confirmResumeThreadPrompt();
      },
    }),
    [
      baseAppModalsProps,
      closeResumeThreadPrompt,
      confirmResumeThreadPrompt,
      resumeThreadPrompt,
      updateResumeThreadPrompt,
    ],
  );

  const handleRefreshAllWorkspaceThreadsFromSidebar = useCallback(() => {
    void handleRefreshAllWorkspaceThreads();
  }, [handleRefreshAllWorkspaceThreads]);

  const handleSelectLocalCodexThread = useCallback(
    async (cwd: string, threadId: string) => {
      const path = cwd.trim();
      if (!path || !threadId) {
        return;
      }

      let workspaceId = resolveWorkspaceIdForLocalCodexPath(path, storedWorkspaces);
      if (!workspaceId) {
        try {
          const workspace = await addWorkspaceFromPath(path, { activate: false });
          workspaceId = workspace?.id ?? null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addDebugEntry({
            id: `${Date.now()}-client-local-codex-workspace-add-error`,
            timestamp: Date.now(),
            source: "error",
            label: "local-codex/workspace-add error",
            payload: { cwd: path, message },
          });
          alert(`${t("localCodex.resumeFailed")}\n\n${message}`);
          return;
        }
      }

      if (!workspaceId) {
        alert(
          `${t("localCodex.resumeFailed")}\n\n${t(
            "localCodex.projectNotFound",
          )}: ${path}`,
        );
        return;
      }

      const matchedWorkspace =
        storedWorkspaces.find((workspace) => workspace.id === workspaceId) ?? null;
      if (matchedWorkspace && !matchedWorkspace.connected) {
        try {
          await connectWorkspace(matchedWorkspace);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addDebugEntry({
            id: `${Date.now()}-client-local-codex-workspace-connect-error`,
            timestamp: Date.now(),
            source: "error",
            label: "local-codex/workspace-connect error",
            payload: { cwd: path, workspaceId, message },
          });
          alert(`${t("localCodex.resumeFailed")}\n\n${message}`);
          return;
        }
      }

      exitDiffView();
      resetPullRequestSelection();
      clearDraftState();
      selectWorkspace(workspaceId);
      setActiveThreadId(threadId, workspaceId);
      if (isCompact) {
        setActiveTab("codex");
      }
      setTimeout(() => composerInputRef.current?.focus(), 0);
    },
    [
      addDebugEntry,
      addWorkspaceFromPath,
      clearDraftState,
      connectWorkspace,
      composerInputRef,
      exitDiffView,
      isCompact,
      resetPullRequestSelection,
      selectWorkspace,
      setActiveTab,
      setActiveThreadId,
      storedWorkspaces,
      t,
    ],
  );

  const handleOpenThreadLinkFromExternal = useCallback(
    (workspaceId: string, threadId: string) => {
      setActiveTab("codex");
      handleOpenThreadLink(threadId, workspaceId);
    },
    [handleOpenThreadLink, setActiveTab],
  );

  useSystemNotificationThreadLinks({
    hasLoadedWorkspaces: hasLoaded,
    workspacesById,
    refreshWorkspaces,
    connectWorkspace,
    openThreadLink: handleOpenThreadLinkFromExternal,
  });

  const { handlePlanAccept, handlePlanSubmitChanges } = usePlanReadyActions({
    activeWorkspace,
    activeThreadId,
    collaborationModes,
    resolvedModel,
    resolvedEffort,
    connectWorkspace,
    sendUserMessageToThread,
    setSelectedCollaborationModeId,
    persistThreadCodexParams,
  });

  const {
    showGitDetail,
    isThreadOpen,
    dropOverlayActive,
    dropOverlayText,
    appClassName,
    appStyle,
  } = useAppShellOrchestration({
    isCompact,
    isPhone,
    isTablet,
    tabletProjectsOpen,
    sidebarOverlayOpen,
    sidebarCollapsed,
    rightPanelCollapsed: sessionManagerOpen || rightPanelCollapsed,
    shouldReduceTransparency,
    isWorkspaceDropActive,
    centerMode,
    selectedDiffPath,
    showComposer,
    activeThreadId,
    sidebarWidth: sessionManagerOpen ? Math.min(380, Math.max(320, sidebarWidth)) : sidebarWidth,
    chatDiffSplitPositionPercent,
    rightPanelWidth,
    planPanelHeight,
    terminalPanelHeight,
    debugPanelHeight,
    appSettings,
  });

  const sidebarMenuOrchestration = useMainAppSidebarMenuOrchestration({
    sidebarActions: {
      openSettings: modalActions.openSettings,
      resetPullRequestSelection,
      clearDraftState,
      clearDraftStateIfDifferentWorkspace,
      selectHome,
      exitDiffView,
      selectWorkspace,
      setActiveThreadId,
      activeWorkspaceId,
      activeThreadId,
      connectWorkspace,
      isCompact,
      setActiveTab,
      workspacesById,
      updateWorkspaceSettings,
      removeThread,
      clearDraftForThread,
      removeImagesForThread,
      refreshThread,
      handleRenameThread,
      removeWorkspace,
      removeWorktree,
      loadOlderThreadsForWorkspace,
      listThreadsForWorkspace,
    },
    workspaceCycling: {
      workspaces,
      groupedWorkspaces,
      threadsByWorkspace,
      getThreadRows,
      getPinTimestamp,
      pinnedThreadsVersion,
      activeWorkspaceIdRef,
      activeThreadIdRef,
      exitDiffView,
      resetPullRequestSelection,
      selectWorkspace,
      setActiveThreadId,
    },
    appMenu: {
      activeWorkspaceRef,
      baseWorkspaceRef,
      onAddWorkspace: handleAddWorkspace,
      onAddWorkspaceFromUrl: openWorkspaceFromUrlPrompt,
      onAddAgent: handleAddAgent,
      onAddWorktreeAgent: handleAddWorktreeAgent,
      onAddCloneAgent: handleAddCloneAgent,
      onToggleDebug: handleDebugClick,
      onToggleTerminal: handleToggleTerminalWithFocus,
      sidebarCollapsed,
      rightPanelCollapsed,
      onExpandSidebar: expandSidebar,
      onCollapseSidebar: collapseSidebar,
      onExpandRightPanel: expandRightPanel,
      onCollapseRightPanel: collapseRightPanel,
    },
    appSettings,
    nativeMenuLabels,
    onDebug: addDebugEntry,
  });
  useArchiveShortcut({
    isEnabled: isThreadOpen,
    shortcut: appSettings.archiveThreadShortcut,
    onTrigger: handleArchiveActiveThread,
  });
  const showCompactCodexThreadActions =
    Boolean(activeWorkspace) &&
    isCompact &&
    ((isPhone && activeTab === "codex") || (isTablet && tabletTab === "codex"));
  const showMobilePollingFetchStatus =
    showCompactCodexThreadActions &&
    Boolean(activeWorkspace?.connected) &&
    appSettings.backendMode === "remote" &&
    remoteThreadConnectionState === "polling";
  const gitRootOverride = activeWorkspace?.settings.gitRoot;
  const hasGitRootOverride =
    typeof gitRootOverride === "string" && gitRootOverride.trim().length > 0;
  const showGitInitBanner =
    Boolean(activeWorkspace) && !hasGitRootOverride && isMissingRepo(gitStatus.error);
  const displayNodes = useMainAppDisplayNodes({
    showCompactCodexThreadActions,
    handleMobileThreadRefresh,
    mobileThreadRefreshLoading,
    centerMode,
    gitDiffViewStyle,
    setGitDiffViewStyle,
    isCompact,
    rightPanelCollapsed,
    sidebarToggleProps,
    workspaceHomeProps: activeWorkspace
      ? {
          workspace: activeWorkspace,
          showGitInitBanner,
          initGitRepoLoading,
          onInitGitRepo: modalActions.openInitGitRepoPrompt,
          runs: workspaceRuns,
          recentThreadInstances,
          recentThreadsUpdatedAt,
          prompt: workspacePrompt,
          onPromptChange: setWorkspacePrompt,
          onStartRun: startWorkspaceRun,
          runMode: workspaceRunMode,
          onRunModeChange: setWorkspaceRunMode,
          models,
          selectedModelId,
          onSelectModel: setSelectedModelId,
          modelSelections: workspaceModelSelections,
          onToggleModel: toggleWorkspaceModelSelection,
          onModelCountChange: setWorkspaceModelCount,
          collaborationModes,
          selectedCollaborationModeId,
          onSelectCollaborationMode: setSelectedCollaborationModeId,
          reasoningOptions,
          selectedEffort,
          onSelectEffort: setSelectedEffort,
          reasoningSupported,
          error: workspaceRunError,
          isSubmitting: workspaceRunSubmitting,
          activeWorkspaceId,
          activeThreadId,
          threadStatusById,
          onSelectInstance: handleSelectWorkspaceInstance,
          skills,
          appsEnabled: appSettings.experimentalAppsEnabled,
          apps,
          prompts,
          files,
          onFileAutocompleteActiveChange: setFileAutocompleteActive,
          dictationEnabled: appSettings.dictationEnabled && dictationReady,
          dictationState,
          dictationLevel,
          onToggleDictation: handleToggleDictation,
          onCancelDictation: cancelDictation,
          onOpenDictationSettings: () => modalActions.openSettings("dictation"),
          dictationError,
          onDismissDictationError: clearDictationError,
          dictationHint,
          onDismissDictationHint: clearDictationHint,
          dictationTranscript,
          onDictationTranscriptHandled: clearDictationTranscript,
          textareaRef: workspaceHomeTextareaRef,
          agentMdContent,
          agentMdExists,
          agentMdTruncated,
          agentMdLoading,
          agentMdSaving,
          agentMdError,
          agentMdDirty,
          onAgentMdChange: setAgentMdContent,
          onAgentMdRefresh: () => {
            void refreshAgentMd();
          },
          onAgentMdSave: () => {
            void saveAgentMd();
          },
        }
      : null,
  });
  const { workspaceHomeNode } = displayNodes;
  const layoutSurfaces = useMainAppLayoutSurfaces({
    appSettings,
    conversationAppearance: runtimeThemeAppearance.conversationAppearance,
    onUpdateAppSettings: queueSaveSettings,
    workspaces,
    groupedWorkspaces,
    workspaceGroupsCount: workspaceGroups.filter((group) => group.id !== LOCAL_CODEX_GROUP_ID).length,
    deletingWorktreeIds,
    newAgentDraftWorkspaceId,
    startingDraftThreadWorkspaceId,
    startingDraftMessageByWorkspace,
    threadsByWorkspace,
    threadParentById,
    threadStatusById,
    pendingTurnStartByThread,
    turnDiffByThread,
    turnExecutionSummaryByThread,
    turnExecutionSummariesByThread,
    interruptedThreadById,
    autoContinueStatusByThread,
    setThreadAutoContinueEnabled,
    threadResumeLoadingById,
    threadListLoadingByWorkspace,
    threadListPagingByWorkspace,
    threadListCursorByWorkspace,
    pinnedThreadsVersion,
    threadListSortKey,
    threadListOrganizeMode,
    onRefreshAllThreads: handleRefreshAllWorkspaceThreadsFromSidebar,
    onCollapseSidebar: collapseSidebar,
    activeWorkspace,
    activeWorkspaceId,
    activeThreadId,
    activeItems,
    agentMdContent,
    threadHistoryPageByThread,
    onLoadOlderThreadHistory: loadOlderThreadHistory,
    itemsByThread,
    userInputRequests,
    approvals,
    activeRateLimits,
    activeAccount,
    homeRateLimits,
    homeAccount,
    homeAccountWorkspaceId,
    accountSwitching,
    onSwitchAccount: handleSwitchAccount,
    onDecision: handleApprovalDecision,
    onRemember: handleApprovalRemember,
    onUserInputSubmit: handleUserInputSubmit,
    onPlanAccept: handlePlanAccept,
    onPlanSubmitChanges: handlePlanSubmitChanges,
    onReferenceMessage: (action) => {
      void handleMessageReference(action);
    },
    activePlan,
    activePlanStream,
    activeTurnId,
    activeTokenUsage,
    activeContextCompactionCount,
    latestAgentRuns,
    isLoadingLatestAgents,
    localUsageSnapshot,
    isLoadingLocalUsage,
    localUsageError,
    onRefreshLocalUsage: () => {
      refreshLocalUsage()?.catch(() => {});
    },
    usageMetric,
    onUsageMetricChange: setUsageMetric,
    usageWorkspaceId,
    usageWorkspaceOptions,
    onUsageWorkspaceChange: setUsageWorkspaceId,
    gitState,
    selectedServiceTier: selectedServiceTier ?? null,
    composerWorkspaceState,
    promptActions,
    worktreeState,
    sidebarHandlers: sidebarMenuOrchestration,
    displayNodes,
    threadPinning: {
      pinThread,
      unpinThread,
      isThreadPinned,
      getPinTimestamp,
      getThreadArgsBadge,
    },
    workspaceDrop: {
      workspaceDropTargetRef,
      isWorkspaceDropActive: dropOverlayActive,
      workspaceDropText: dropOverlayText,
      onWorkspaceDragOver: handleWorkspaceDragOver,
      onWorkspaceDragEnter: handleWorkspaceDragEnter,
      onWorkspaceDragLeave: handleWorkspaceDragLeave,
      onWorkspaceDrop: handleWorkspaceDrop,
    },
    threadNavigation: {
      exitDiffView,
      clearDraftState,
      selectWorkspace,
      setActiveThreadId,
      resetPullRequestSelection,
      selectHome,
    },
    pullRequestComposer: {
      composerSendLabel,
      handleSelectPullRequest,
    },
    dictationUi: {
      onOpenDictationSettings: () => modalActions.openSettings('dictation'),
      dictationTranscript,
      dictationError,
      dictationHint,
    },
    openAppIconById,
    openInitGitRepoPrompt: modalActions.openInitGitRepoPrompt,
    startUncommittedReview,
    handleAddWorkspace,
    openWorkspaceFromUrlPrompt,
    handleAddAgent,
    handleAddWorktreeAgent,
    handleAddCloneAgent,
    handleResumeThreadById: openResumeThreadPrompt,
    activeManagedSessionSourceName: activeThreadId
      ? (managedSessionSourceByThread[`${activeWorkspaceId}:${activeThreadId}`]
        ?? (threadDerivations[`${activeWorkspaceId}:${activeThreadId}`]
          ? `${t("sessionManager.derivedFrom")} ${threadDerivations[`${activeWorkspaceId}:${activeThreadId}`].sourceName}`
          : null))
      : null,
    handleSelectLocalCodexThread,
    handleOpenThreadLink,
    handleSelectOpenAppId,
    handleToggleTerminalWithFocus,
    handleOpenTerminalWithFocus: openTerminalWithFocus,
    onCloseTerminalPanel: closeTerminalPanel,
    launchScriptState,
    launchScriptsState,
    models,
    selectedModelId,
    onSelectModel: handleSelectModel,
    onRefreshModels: () => {
      void handleRefreshModels();
    },
    isRefreshingModels: isRefreshingModels || isRefreshingProviderModels,
    collaborationModes,
    selectedCollaborationModeId,
    onSelectCollaborationMode: handleSelectCollaborationMode,
    reasoningOptions,
    selectedEffort,
    onSelectEffort: handleSelectEffort,
    reasoningSupported,
    codexArgsOptions,
    selectedCodexArgsOverride,
    onSelectCodexArgsOverride: handleSelectCodexArgsOverride,
    selectedWorkflowGateId,
    onSelectWorkflowGateId: handleSelectWorkflowGateId,
    onVerifyWorkflowGate: projectActiveWorkspace && activeThreadId
      ? handleVerifyWorkflowGate
      : undefined,
    accessMode,
    onSelectAccessMode: handleSelectAccessMode,
    skills,
    apps,
    prompts,
    composerInputRef,
    composerEditorSettings,
    composerEditorExpanded,
    onToggleComposerEditorExpanded: toggleComposerEditorExpanded,
    dictationReady,
    dictationState,
    dictationLevel,
    onToggleDictation: handleToggleDictation,
    onCancelDictation: cancelDictation,
    clearDictationTranscript,
    clearDictationError,
    clearDictationHint,
    composerContextActions,
    reviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    selectBranch,
    selectBranchAtIndex,
    confirmBranch,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
    handleComposerSendWithDraftStart,
    interruptTurn,
    retryEditedUserMessage,
    terminalOpen,
    debugOpen,
    debugEntries,
    terminalTabs,
    activeTerminalId,
    onSelectTerminal,
    onNewTerminal,
    onCloseTerminal,
    onOpenExternalTerminal,
    terminalState,
    onClearDebug: clearDebugEntries,
    onCopyDebug: handleCopyDebug,
    onResizeDebug: onDebugPanelResizeStart,
    onResizeTerminal: onTerminalPanelResizeStart,
    isCompact,
    isPhone,
    rightPanelCollapsed,
    onCollapseRightPanel: collapseRightPanel,
    onExpandRightPanel: expandRightPanel,
    activeTab,
    setActiveTab,
    tabletTab,
    sessionManagerOpen,
    onToggleSessionManager: () => {
      handleSessionManagerActiveChange(!sessionManagerOpen);
    },
    onRevealSidebar: revealSidebar,
    onHideSidebar: hideSidebar,
    showMobilePollingFetchStatus,
    appModalsSettingsOpen: appModalsProps.settingsOpen,
    onCloseSettings: appModalsProps.onCloseSettings,
    appModalsAboutOpen:
      appModalsProps.settingsOpen && appModalsProps.settingsSection === 'about',
    updaterState,
    startUpdate,
    dismissUpdate,
    postUpdateNotice,
    dismissPostUpdateNotice,
    errorToasts,
    dismissErrorToast,
    handleDebugClick,
    onCloseActivity: () => setDebugOpen(false),
  });

  const {
    sidebarNode,
    messagesNode,
    composerNode,
    approvalToastsNode,
    updateToastNode,
    errorToastsNode,
    homeNode,
    mainHeaderNode,
    desktopTopbarLeftNode,
    tabletNavNode,
    tabBarNode,
    gitDiffPanelNode,
    gitDiffViewerNode,
    planPanelNode,
    debugPanelNode,
    debugPanelFullNode,
    terminalDockNode,
    compactEmptyCodexNode,
    compactEmptyGitNode,
    compactGitBackNode,
  } = useMainAppLayoutNodes(layoutSurfaces);

  const mainMessagesNode = showWorkspaceHome ? workspaceHomeNode : messagesNode;
  const SettingsSurfaceComponent = appModalsProps.SettingsViewComponent;
  const settingsNode = appModalsProps.settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsSurfaceComponent
        {...appModalsProps.settingsProps}
        onClose={appModalsProps.onCloseSettings}
        initialSection={appModalsProps.settingsSection ?? undefined}
        variant="surface"
      />
    </Suspense>
  ) : null;
  const activePanel =
    appModalsProps.settingsOpen
      ? "settings"
      : sessionManagerOpen
        ? "library"
        : terminalOpen
          ? "terminal"
          : debugOpen || activeTab === "log"
            ? "activity"
            : activeTab === "home"
              ? "home"
              : activeTab === "git"
                ? "git"
                : "sessions";
  const compactThreadConnectionState: "live" | "polling" | "disconnected" =
    !activeWorkspace?.connected
      ? "disconnected"
      : remoteThreadConnectionState;
  const mainAppShellProps = useMainAppShellProps({
    shell: {
      appClassName,
      isResizing,
      appStyle,
      appRef,
      sidebarToggleProps,
      shouldLoadGitHubPanelData,
      appModalsProps,
      showMobileSetupWizard,
      mobileSetupWizardProps,
    },
    gitHubPanelDataProps: {
      activeWorkspace,
      gitPanelMode,
      shouldLoadDiffs,
      diffSource,
      selectedPullRequestNumber: selectedPullRequest?.number ?? null,
      onIssuesChange: handleGitIssuesChange,
      onPullRequestsChange: handleGitPullRequestsChange,
      onPullRequestDiffsChange: handleGitPullRequestDiffsChange,
      onPullRequestCommentsChange: handleGitPullRequestCommentsChange,
    },
    appLayout: {
      isPhone,
      isTablet,
      activePanel,
      libraryOpen: sessionManagerOpen,
      showHome: showHome || sessionManagerOpen,
      showGitDetail,
      activeTab,
      tabletTab,
      tabletProjectsOpen,
      centerMode,
      preloadGitDiffs: appSettings.preloadGitDiffs,
      splitChatDiffView: appSettings.splitChatDiffView,
      hasActivePlan: hasActivePlan,
      activeWorkspace: Boolean(activeWorkspace),
      sidebarNode,
      messagesNode: mainMessagesNode,
      composerNode,
      approvalToastsNode,
      updateToastNode,
      errorToastsNode,
      homeNode: sessionManagerOpen ? <SessionManagerWorkspace /> : homeNode,
      mainHeaderNode,
      tabletNavNode,
      tabBarNode,
      gitDiffPanelNode,
      gitDiffViewerNode,
      planPanelNode,
      debugPanelNode,
      debugPanelFullNode,
      terminalDockNode,
      settingsOpen: appModalsProps.settingsOpen,
      settingsNode,
      compactEmptyCodexNode,
      compactEmptyGitNode,
      compactGitBackNode,
      onSidebarResizeStart,
      onChatDiffSplitPositionResizeStart,
      onRightPanelResizeStart,
      onPlanPanelResizeStart,
    },
    topbar: {
      desktopTopbarLeftNode,
      hasActiveWorkspace: Boolean(activeWorkspace),
      backendMode: appSettings.backendMode,
      remoteThreadConnectionState: compactThreadConnectionState,
    },
  });

  return (
    <I18nProvider preference={appSettings.appLanguage}>
      <SessionManagerProvider active={sessionManagerOpen} onActiveChange={handleSessionManagerActiveChange} onResumeSession={handleResumeManagedSession} onDeriveSession={handleDeriveManagedSession} onDeriveSessions={handleDeriveManagedSessions} currentWorkspace={projectActiveWorkspace ? { name: projectActiveWorkspace.name, path: projectActiveWorkspace.path } : null}>
        <MainAppShell {...mainAppShellProps} />
        <CodexInstallPrompt
          open={codexInstallPromptOpen}
          stage={codexInstallStage}
          progress={codexInstallProgress}
          error={codexInstallError}
          onInstall={() => void handleInstallManagedCodex()}
          onChooseExisting={() => {
            setCodexInstallPromptOpen(false);
            modalActions.openSettings("codex");
          }}
          onLater={() => setCodexInstallPromptOpen(false)}
        />
        <SessionResumeChoicePrompt />
        {managedSessionDerivation && (
          <SessionDerivationPrompt
            previews={managedSessionDerivation.previews}
            destination={managedSessionDerivation.destination}
            error={managedSessionDerivation.error}
            isBusy={managedSessionDerivation.isBusy}
            onCancel={() => setManagedSessionDerivation(null)}
            onConfirm={() => void confirmManagedSessionDerivation()}
          />
        )}
      </SessionManagerProvider>
    </I18nProvider>
  );
}
