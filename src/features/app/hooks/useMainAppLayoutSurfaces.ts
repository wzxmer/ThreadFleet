import { useMemo, type RefObject } from "react";
import type {
  AppSettings,
  CodexProviderStatus,
  ComposerEditorSettings,
  ComposerSendShortcut,
  ComposerTriggerMode,
  ConversationItem,
  SendMessageResult,
  WorkspaceInfo,
} from "@/types";
import type { ThreadState } from "@/features/threads/hooks/useThreadsReducer";
import type { ThreadHistoryPageState } from "@/features/threads/hooks/useThreadActions";
import { useSidebarProviderUsage } from "@app/hooks/useSidebarProviderUsage";
import type { ConversationAppearance } from "@app/utils/runtimeThemeAppearance";
import type { WorkspaceLaunchScriptsState } from "@app/hooks/useWorkspaceLaunchScripts";
import { REMOTE_THREAD_POLL_INTERVAL_MS } from "@app/hooks/useRemoteThreadRefreshOnFocus";
import type { useMainAppComposerWorkspaceState } from "@app/hooks/useMainAppComposerWorkspaceState";
import type { useMainAppDisplayNodes } from "@app/hooks/useMainAppDisplayNodes";
import type { useMainAppGitState } from "@app/hooks/useMainAppGitState";
import type { useMainAppPromptActions } from "@app/hooks/useMainAppPromptActions";
import type { useMainAppSidebarMenuOrchestration } from "@app/hooks/useMainAppSidebarMenuOrchestration";
import type { useMainAppWorktreeState } from "@app/hooks/useMainAppWorktreeState";
import type { StartingDraftMessagePreview } from "@app/hooks/useNewAgentDraft";
import type { LayoutNodesOptions } from "@/features/layout/hooks/layoutNodes/types";
import { LOCAL_CODEX_WORKSPACE_ID } from "@/features/workspaces/domain/localCodexWorkspace";
import { resolveSidebarRateLimits } from "@app/utils/sidebarUsageRateLimits";
import type { MessageReferenceAction } from "@/features/messages/utils/messageReferences";
import {
  buildSubagentResultSummaries,
  type SubagentResultSummary,
} from "@/features/messages/utils/subagentResults";
import { useI18n } from "@/features/i18n/I18nProvider";
import { isContextCompactionInProgress } from "@/features/threads/utils/contextUsage";

type SidebarProps = LayoutNodesOptions["primary"]["sidebarProps"];
type ComposerProps = NonNullable<LayoutNodesOptions["primary"]["composerProps"]>;
type MainHeaderProps = NonNullable<LayoutNodesOptions["primary"]["mainHeaderProps"]>;
type GitDiffPanelProps = LayoutNodesOptions["git"]["gitDiffPanelProps"];

type UseMainAppLayoutSurfacesArgs = {
  appSettings: AppSettings;
  conversationAppearance: ConversationAppearance;
  onUpdateAppSettings: (next: AppSettings) => Promise<unknown>;
  workspaces: WorkspaceInfo[];
  groupedWorkspaces: Array<{ id: string | null; name: string; workspaces: WorkspaceInfo[] }>;
  workspaceGroupsCount: number;
  deletingWorktreeIds: Set<string>;
  newAgentDraftWorkspaceId: string | null;
  startingDraftThreadWorkspaceId: string | null;
  startingDraftMessageByWorkspace: Record<string, StartingDraftMessagePreview>;
  threadsByWorkspace: SidebarProps["threadsByWorkspace"];
  threadParentById: SidebarProps["threadParentById"];
  threadStatusById: ThreadState["threadStatusById"];
  pendingTurnStartByThread: Record<
    string,
    { requestId: string; startedAt: number }
  >;
  turnDiffByThread: ThreadState["turnDiffByThread"];
  turnExecutionSummaryByThread: ThreadState["turnExecutionSummaryByThread"];
  turnExecutionSummariesByThread: ThreadState["turnExecutionSummariesByThread"];
  interruptedThreadById: ThreadState["interruptedThreadById"];
  autoContinueStatusByThread: Record<
    string,
    {
      enabled: boolean;
      phase: "idle" | "waiting" | "sending" | "running";
      attempt: number;
      nextRetryAt: number | null;
    }
  >;
  setThreadAutoContinueEnabled: (threadId: string, enabled: boolean) => void;
  threadResumeLoadingById: Record<string, boolean>;
  threadListLoadingByWorkspace: SidebarProps["threadListLoadingByWorkspace"];
  threadListPagingByWorkspace: SidebarProps["threadListPagingByWorkspace"];
  threadListCursorByWorkspace: SidebarProps["threadListCursorByWorkspace"];
  pinnedThreadsVersion: number;
  threadListSortKey: SidebarProps["threadListSortKey"];
  onSetThreadListSortKey: SidebarProps["onSetThreadListSortKey"];
  threadListOrganizeMode: SidebarProps["threadListOrganizeMode"];
  onSetThreadListOrganizeMode: SidebarProps["onSetThreadListOrganizeMode"];
  onRefreshAllThreads: SidebarProps["onRefreshAllThreads"];
  activeWorkspace: WorkspaceInfo | null;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  activeItems: LayoutNodesOptions["primary"]["messagesProps"]["items"];
  threadHistoryPageByThread: Record<string, ThreadHistoryPageState>;
  onLoadOlderThreadHistory: (workspaceId: string, threadId: string) => Promise<boolean>;
  itemsByThread: Record<string, ConversationItem[]>;
  userInputRequests: SidebarProps["userInputRequests"];
  approvals: LayoutNodesOptions["primary"]["approvalToastsProps"]["approvals"];
  activeRateLimits: SidebarProps["accountRateLimits"];
  activeAccount: SidebarProps["accountInfo"];
  homeRateLimits: LayoutNodesOptions["primary"]["homeProps"]["accountRateLimits"];
  homeAccount: LayoutNodesOptions["primary"]["homeProps"]["accountInfo"];
  homeAccountWorkspaceId: string | null;
  accountSwitching: SidebarProps["accountSwitching"];
  onSwitchAccount: SidebarProps["onSwitchAccount"];
  onCancelSwitchAccount: SidebarProps["onCancelSwitchAccount"];
  onDecision: LayoutNodesOptions["primary"]["approvalToastsProps"]["onDecision"];
  onRemember: LayoutNodesOptions["primary"]["approvalToastsProps"]["onRemember"];
  onUserInputSubmit: LayoutNodesOptions["primary"]["messagesProps"]["onUserInputSubmit"];
  onPlanAccept: LayoutNodesOptions["primary"]["messagesProps"]["onPlanAccept"];
  onPlanSubmitChanges: LayoutNodesOptions["primary"]["messagesProps"]["onPlanSubmitChanges"];
  onReferenceMessage: (action: MessageReferenceAction) => void;
  activePlan: LayoutNodesOptions["secondary"]["planPanelProps"]["plan"];
  activePlanStream: string | null;
  activeTurnId: string | null;
  activeTokenUsage: ComposerProps["contextUsage"];
  activeContextCompactionCount: number;
  latestAgentRuns: LayoutNodesOptions["primary"]["homeProps"]["latestAgentRuns"];
  isLoadingLatestAgents: LayoutNodesOptions["primary"]["homeProps"]["isLoadingLatestAgents"];
  localUsageSnapshot: LayoutNodesOptions["primary"]["homeProps"]["localUsageSnapshot"];
  isLoadingLocalUsage: LayoutNodesOptions["primary"]["homeProps"]["isLoadingLocalUsage"];
  localUsageError: LayoutNodesOptions["primary"]["homeProps"]["localUsageError"];
  onRefreshLocalUsage: LayoutNodesOptions["primary"]["homeProps"]["onRefreshLocalUsage"];
  usageMetric: LayoutNodesOptions["primary"]["homeProps"]["usageMetric"];
  onUsageMetricChange: LayoutNodesOptions["primary"]["homeProps"]["onUsageMetricChange"];
  usageWorkspaceId: LayoutNodesOptions["primary"]["homeProps"]["usageWorkspaceId"];
  usageWorkspaceOptions: LayoutNodesOptions["primary"]["homeProps"]["usageWorkspaceOptions"];
  onUsageWorkspaceChange: LayoutNodesOptions["primary"]["homeProps"]["onUsageWorkspaceChange"];
  gitState: ReturnType<typeof useMainAppGitState>;
  composerWorkspaceState: ReturnType<typeof useMainAppComposerWorkspaceState>;
  promptActions: ReturnType<typeof useMainAppPromptActions>;
  worktreeState: ReturnType<typeof useMainAppWorktreeState>;
  sidebarHandlers: ReturnType<typeof useMainAppSidebarMenuOrchestration>;
  displayNodes: ReturnType<typeof useMainAppDisplayNodes>;
  threadPinning: Pick<
    SidebarProps,
    "pinThread" | "unpinThread" | "isThreadPinned" | "getPinTimestamp" | "getThreadArgsBadge"
  >;
  workspaceDrop: {
    workspaceDropTargetRef: SidebarProps["workspaceDropTargetRef"];
    isWorkspaceDropActive: SidebarProps["isWorkspaceDropActive"];
    workspaceDropText: SidebarProps["workspaceDropText"];
    onWorkspaceDragOver: SidebarProps["onWorkspaceDragOver"];
    onWorkspaceDragEnter: SidebarProps["onWorkspaceDragEnter"];
    onWorkspaceDragLeave: SidebarProps["onWorkspaceDragLeave"];
    onWorkspaceDrop: SidebarProps["onWorkspaceDrop"];
  };
  threadNavigation: {
    exitDiffView: () => void;
    clearDraftState: () => void;
    selectWorkspace: (workspaceId: string) => void;
    setActiveThreadId: (threadId: string | null, workspaceId: string) => void;
    resetPullRequestSelection: () => void;
    selectHome: () => void;
  };
  pullRequestComposer: {
    composerSendLabel: string | null | undefined;
    handleSelectPullRequest: NonNullable<GitDiffPanelProps["onSelectPullRequest"]>;
  };
  dictationUi: {
    onOpenDictationSettings: ComposerProps["onOpenDictationSettings"];
    dictationTranscript: ComposerProps["dictationTranscript"];
    dictationError: ComposerProps["dictationError"];
    dictationHint: ComposerProps["dictationHint"];
  };
  openAppIconById: MainHeaderProps["openAppIconById"];
  openInitGitRepoPrompt: GitDiffPanelProps["onInitGitRepo"];
  startUncommittedReview: (workspaceId: string | null) => void;
  handleAddWorkspace: () => void;
  openWorkspaceFromUrlPrompt: () => void;
  handleAddAgent: SidebarProps["onAddAgent"];
  handleAddWorktreeAgent: SidebarProps["onAddWorktreeAgent"];
  handleAddCloneAgent: SidebarProps["onAddCloneAgent"];
  handleResumeThreadById: SidebarProps["onResumeThreadById"];
  activeManagedSessionSourceName: string | null;
  handleSelectLocalCodexThread: SidebarProps["onSelectLocalCodexThread"];
  handleOpenThreadLink: LayoutNodesOptions["primary"]["messagesProps"]["onOpenThreadLink"];
  handleSelectOpenAppId: MainHeaderProps["onSelectOpenAppId"];
  handleCopyThread: MainHeaderProps["onCopyThread"];
  handleToggleTerminalWithFocus: MainHeaderProps["onToggleTerminal"];
  launchScriptState: {
    launchScript: string | null;
    editorOpen: boolean;
    draftScript: string;
    isSaving: boolean;
    error: string | null;
    onRunLaunchScript: () => void;
    onOpenEditor: () => void;
    onCloseEditor: () => void;
    onDraftScriptChange: (value: string) => void;
    onSaveLaunchScript: () => void;
  };
  launchScriptsState: WorkspaceLaunchScriptsState | undefined;
  models: ComposerProps["models"];
  selectedModelId: ComposerProps["selectedModelId"];
  onSelectModel: ComposerProps["onSelectModel"];
  onRefreshModels: ComposerProps["onRefreshModels"];
  isRefreshingModels: ComposerProps["isRefreshingModels"];
  collaborationModes: ComposerProps["collaborationModes"];
  selectedCollaborationModeId: ComposerProps["selectedCollaborationModeId"];
  onSelectCollaborationMode: ComposerProps["onSelectCollaborationMode"];
  reasoningOptions: ComposerProps["reasoningOptions"];
  selectedEffort: ComposerProps["selectedEffort"];
  onSelectEffort: ComposerProps["onSelectEffort"];
  selectedServiceTier: ComposerProps["selectedServiceTier"];
  reasoningSupported: boolean;
  codexArgsOptions: ComposerProps["codexArgsOptions"];
  selectedCodexArgsOverride: ComposerProps["selectedCodexArgsOverride"];
  onSelectCodexArgsOverride: ComposerProps["onSelectCodexArgsOverride"];
  selectedWorkflowGateId: ComposerProps["selectedWorkflowGateId"];
  onSelectWorkflowGateId: ComposerProps["onSelectWorkflowGateId"];
  onVerifyWorkflowGate: ComposerProps["onVerifyWorkflowGate"];
  accessMode: ComposerProps["accessMode"];
  onSelectAccessMode: ComposerProps["onSelectAccessMode"];
  skills: ComposerProps["skills"];
  apps: ComposerProps["apps"];
  prompts: ComposerProps["prompts"];
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  composerEditorSettings: ComposerEditorSettings;
  composerEditorExpanded: boolean;
  onToggleComposerEditorExpanded: () => void;
  dictationReady: boolean;
  dictationState: ComposerProps["dictationState"];
  dictationLevel: number;
  onToggleDictation: () => void;
  onCancelDictation: (() => void) | undefined;
  clearDictationTranscript: NonNullable<ComposerProps["onDictationTranscriptHandled"]>;
  clearDictationError: () => void;
  clearDictationHint: () => void;
  composerContextActions: ComposerProps["contextActions"];
  reviewPrompt: ComposerProps["reviewPrompt"];
  closeReviewPrompt: () => void;
  showPresetStep: () => void;
  choosePreset: ComposerProps["onReviewPromptChoosePreset"];
  highlightedPresetIndex: number;
  setHighlightedPresetIndex: (index: number) => void;
  highlightedBranchIndex: number;
  setHighlightedBranchIndex: (index: number) => void;
  highlightedCommitIndex: number;
  setHighlightedCommitIndex: (index: number) => void;
  handleReviewPromptKeyDown: ComposerProps["onReviewPromptKeyDown"];
  selectBranch: ComposerProps["onReviewPromptSelectBranch"];
  selectBranchAtIndex: ComposerProps["onReviewPromptSelectBranchAtIndex"];
  confirmBranch: ComposerProps["onReviewPromptConfirmBranch"];
  selectCommit: ComposerProps["onReviewPromptSelectCommit"];
  selectCommitAtIndex: ComposerProps["onReviewPromptSelectCommitAtIndex"];
  confirmCommit: ComposerProps["onReviewPromptConfirmCommit"];
  updateCustomInstructions: ComposerProps["onReviewPromptUpdateCustomInstructions"];
  confirmCustom: ComposerProps["onReviewPromptConfirmCustom"];
  handleComposerSendWithDraftStart: ComposerProps["onSend"];
  interruptTurn: () => void;
  retryEditedUserMessage: (
    text: string,
    images?: string[],
    options?: { replaceMessageId?: string },
  ) => Promise<SendMessageResult>;
  terminalOpen: boolean;
  debugOpen: boolean;
  debugEntries: LayoutNodesOptions["secondary"]["debugPanelProps"]["entries"];
  terminalTabs: LayoutNodesOptions["secondary"]["terminalDockProps"]["terminals"];
  activeTerminalId: LayoutNodesOptions["secondary"]["terminalDockProps"]["activeTerminalId"];
  onSelectTerminal: LayoutNodesOptions["secondary"]["terminalDockProps"]["onSelectTerminal"];
  onNewTerminal: LayoutNodesOptions["secondary"]["terminalDockProps"]["onNewTerminal"];
  onCloseTerminal: LayoutNodesOptions["secondary"]["terminalDockProps"]["onCloseTerminal"];
  onOpenExternalTerminal: LayoutNodesOptions["secondary"]["terminalDockProps"]["onOpenExternalTerminal"];
  terminalState: LayoutNodesOptions["secondary"]["terminalState"];
  onClearDebug: () => void;
  onCopyDebug: () => void;
  onResizeDebug: LayoutNodesOptions["secondary"]["debugPanelProps"]["onResizeStart"];
  onResizeTerminal: LayoutNodesOptions["secondary"]["terminalDockProps"]["onResizeStart"];
  isCompact: boolean;
  isPhone: boolean;
  activeTab: LayoutNodesOptions["primary"]["tabBarProps"]["activeTab"];
  setActiveTab: (tab: "home" | "projects" | "codex" | "git" | "log") => void;
  tabletTab: LayoutNodesOptions["primary"]["tabletNavProps"]["activeTab"];
  showMobilePollingFetchStatus: boolean;
  appModalsAboutOpen: boolean;
  updaterState: LayoutNodesOptions["primary"]["updateToastProps"]["state"];
  startUpdate: LayoutNodesOptions["primary"]["updateToastProps"]["onUpdate"];
  dismissUpdate: LayoutNodesOptions["primary"]["updateToastProps"]["onDismiss"];
  postUpdateNotice: LayoutNodesOptions["primary"]["updateToastProps"]["postUpdateNotice"];
  dismissPostUpdateNotice: LayoutNodesOptions["primary"]["updateToastProps"]["onDismissPostUpdateNotice"];
  errorToasts: LayoutNodesOptions["primary"]["errorToastsProps"]["toasts"];
  dismissErrorToast: LayoutNodesOptions["primary"]["errorToastsProps"]["onDismiss"];
  showDebugButton: boolean;
  handleDebugClick: () => void;
};

type MainAppLayoutSurfacesContext = UseMainAppLayoutSurfacesArgs & {
  sidebarRateLimits: SidebarProps["accountRateLimits"];
  sidebarAccount: SidebarProps["accountInfo"];
  codexProviderStatus: CodexProviderStatus | null;
  thirdPartyProviderUsage: SidebarProps["thirdPartyProviderUsage"];
  subagentResults: SubagentResultSummary[];
};

function buildPrimarySurface({
  appSettings,
  conversationAppearance,
  onUpdateAppSettings,
  workspaces,
  groupedWorkspaces,
  workspaceGroupsCount,
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
  onSetThreadListSortKey,
  threadListOrganizeMode,
  onSetThreadListOrganizeMode,
  onRefreshAllThreads,
  activeWorkspace,
  activeWorkspaceId,
  activeThreadId,
  activeItems,
  threadHistoryPageByThread,
  onLoadOlderThreadHistory,
  subagentResults,
  userInputRequests,
  approvals,
  sidebarRateLimits,
  sidebarAccount,
  codexProviderStatus,
  thirdPartyProviderUsage,
  homeRateLimits,
  homeAccount,
  accountSwitching,
  onSwitchAccount,
  onCancelSwitchAccount,
  onDecision,
  onRemember,
  onUserInputSubmit,
  onPlanAccept,
  onPlanSubmitChanges,
  onReferenceMessage,
  activeTokenUsage,
  activeContextCompactionCount,
  latestAgentRuns,
  isLoadingLatestAgents,
  localUsageSnapshot,
  isLoadingLocalUsage,
  localUsageError,
  onRefreshLocalUsage,
  usageMetric,
  onUsageMetricChange,
  usageWorkspaceId,
  usageWorkspaceOptions,
  onUsageWorkspaceChange,
  gitState,
  composerWorkspaceState,
  worktreeState,
  sidebarHandlers,
  displayNodes,
  threadPinning,
  workspaceDrop,
  threadNavigation,
  pullRequestComposer,
  dictationUi,
  openAppIconById,
  handleAddWorkspace,
  openWorkspaceFromUrlPrompt,
  handleAddAgent,
  handleAddWorktreeAgent,
  handleAddCloneAgent,
  handleResumeThreadById,
  activeManagedSessionSourceName,
  handleSelectLocalCodexThread,
  handleOpenThreadLink,
  handleSelectOpenAppId,
  handleCopyThread,
  handleToggleTerminalWithFocus,
  launchScriptState,
  launchScriptsState,
  models,
  selectedModelId,
  onSelectModel,
  onRefreshModels,
  isRefreshingModels,
  collaborationModes,
  selectedCollaborationModeId,
  onSelectCollaborationMode,
  reasoningOptions,
  selectedEffort,
  onSelectEffort,
  selectedServiceTier,
  reasoningSupported,
  codexArgsOptions,
  selectedCodexArgsOverride,
  onSelectCodexArgsOverride,
  selectedWorkflowGateId,
  onSelectWorkflowGateId,
  onVerifyWorkflowGate,
  accessMode,
  onSelectAccessMode,
  skills,
  apps,
  prompts,
  composerInputRef,
  composerEditorSettings,
  composerEditorExpanded,
  onToggleComposerEditorExpanded,
  dictationReady,
  dictationState,
  dictationLevel,
  onToggleDictation,
  onCancelDictation,
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
  isCompact,
  activeTab,
  setActiveTab,
  tabletTab,
  showMobilePollingFetchStatus,
  appModalsAboutOpen,
  updaterState,
  startUpdate,
  dismissUpdate,
  postUpdateNotice,
  dismissPostUpdateNotice,
  errorToasts,
  dismissErrorToast,
  showDebugButton,
  handleDebugClick,
}: MainAppLayoutSurfacesContext): LayoutNodesOptions["primary"] {
  const startingDraftMessage =
    !activeThreadId &&
    activeWorkspaceId &&
    startingDraftThreadWorkspaceId === activeWorkspaceId
      ? startingDraftMessageByWorkspace[activeWorkspaceId]
      : null;
  const messagesItems: ConversationItem[] = startingDraftMessage
    ? [
        {
          id: `draft-user-${startingDraftMessage.createdAt}`,
          kind: "message",
          role: "user",
          text: startingDraftMessage.text,
          createdAt: startingDraftMessage.createdAt,
          images: startingDraftMessage.images,
          attachments: [],
        },
      ]
    : activeItems;
  const activeThreadTitle =
    activeWorkspaceId && activeThreadId
      ? (threadsByWorkspace[activeWorkspaceId] ?? []).find(
          (thread) => thread.id === activeThreadId,
        )?.name.trim() || null
      : null;
  const activeThreadTitleWithSource = activeThreadTitle && activeManagedSessionSourceName
    ? `${activeThreadTitle} · ${activeManagedSessionSourceName}`
    : activeThreadTitle;
  return {
    sidebarProps: {
      workspaces: workspaces.filter((workspace) => workspace.id !== LOCAL_CODEX_WORKSPACE_ID),
      groupedWorkspaces,
      hasWorkspaceGroups: workspaceGroupsCount > 0,
      deletingWorktreeIds,
      newAgentDraftWorkspaceId,
      startingDraftThreadWorkspaceId,
      threadsByWorkspace,
      threadParentById,
      threadStatusById,
      threadListLoadingByWorkspace,
      threadListPagingByWorkspace,
      threadListCursorByWorkspace,
      pinnedThreadsVersion,
      threadListSortKey,
      onSetThreadListSortKey,
      threadListOrganizeMode,
      onSetThreadListOrganizeMode,
      onRefreshAllThreads,
      activeWorkspaceId,
      activeThreadId,
      userInputRequests,
      accountRateLimits: sidebarRateLimits,
      activeTokenUsage: activeTokenUsage ?? null,
      showCodexUsage: appSettings.showCodexUsage,
      usageShowRemaining: appSettings.usageShowRemaining,
      useTokenUsageStats:
        codexProviderStatus?.isConfigured === true &&
        codexProviderStatus.isThirdParty,
      thirdPartyProviderUsage,
      codexKeyProfiles: appSettings.codexKeyProfiles,
      activeCodexKeyProfileId: appSettings.activeCodexKeyProfileId,
      onSelectCodexKeyProfile: (profileId) => {
        void onUpdateAppSettings({
          ...appSettings,
          activeCodexKeyProfileId: profileId || null,
        });
      },
      usageConfigurationWarning:
        activeWorkspaceId &&
        (!codexProviderStatus || !codexProviderStatus.isConfigured)
          ? (codexProviderStatus?.error ?? "Codex provider status is not ready")
          : null,
      accountInfo: sidebarAccount,
      onSwitchAccount,
      onCancelSwitchAccount,
      accountSwitching,
      onOpenSettings: sidebarHandlers.onOpenSettings,
      onOpenDebug: handleDebugClick,
      showDebugButton,
      onAddWorkspace: handleAddWorkspace,
      onSelectHome: sidebarHandlers.onSelectHome,
      onSelectWorkspace: sidebarHandlers.onSelectWorkspace,
      onConnectWorkspace: sidebarHandlers.onConnectWorkspace,
      onAddAgent: handleAddAgent,
      onAddWorktreeAgent: handleAddWorktreeAgent,
      onAddCloneAgent: handleAddCloneAgent,
      onResumeThreadById: handleResumeThreadById,
      onToggleWorkspaceCollapse: sidebarHandlers.onToggleWorkspaceCollapse,
      onSelectThread: sidebarHandlers.onSelectThread,
      onSelectLocalCodexThread: handleSelectLocalCodexThread,
      onDeleteThread: sidebarHandlers.onDeleteThread,
      onSyncThread: sidebarHandlers.onSyncThread,
      pinThread: threadPinning.pinThread,
      unpinThread: threadPinning.unpinThread,
      isThreadPinned: threadPinning.isThreadPinned,
      getPinTimestamp: threadPinning.getPinTimestamp,
      getThreadArgsBadge: threadPinning.getThreadArgsBadge,
      onRenameThread: sidebarHandlers.onRenameThread,
      onDeleteWorkspace: sidebarHandlers.onDeleteWorkspace,
      onDeleteWorktree: sidebarHandlers.onDeleteWorktree,
      onLoadOlderThreads: sidebarHandlers.onLoadOlderThreads,
      onReloadWorkspaceThreads: sidebarHandlers.onReloadWorkspaceThreads,
      workspaceDropTargetRef: workspaceDrop.workspaceDropTargetRef,
      isWorkspaceDropActive: workspaceDrop.isWorkspaceDropActive,
      workspaceDropText: workspaceDrop.workspaceDropText,
      onWorkspaceDragOver: workspaceDrop.onWorkspaceDragOver,
      onWorkspaceDragEnter: workspaceDrop.onWorkspaceDragEnter,
      onWorkspaceDragLeave: workspaceDrop.onWorkspaceDragLeave,
      onWorkspaceDrop: workspaceDrop.onWorkspaceDrop,
    },
    messagesProps: {
      items: messagesItems,
      subagentResults,
      threadId: activeThreadId ?? null,
      workspaceId: activeWorkspace?.id ?? null,
      workspacePath: activeWorkspace?.path ?? null,
      openTargets: appSettings.openAppTargets,
      selectedOpenAppId: appSettings.selectedOpenAppId,
      codeBlockCopyUseModifier: appSettings.composerCodeBlockCopyUseModifier,
      showMessageFilePath: appSettings.showMessageFilePath,
      defaultToolGroupsCollapsed:
        appSettings.messageToolGroupsCollapsedByDefault,
      messageReadingStyle: appSettings.messageReadingStyle,
      messageCanvasColor: conversationAppearance.messageCanvasColor,
      messageUserBubbleColor: conversationAppearance.messageUserBubbleColor,
      messageUserTextColor: conversationAppearance.messageUserTextColor,
      messageAssistantBubbleColor: conversationAppearance.messageAssistantBubbleColor,
      messageAssistantAccentColor: conversationAppearance.messageAssistantAccentColor,
      messageAssistantTextColor: conversationAppearance.messageAssistantTextColor,
      chatHistoryScrollbackItems: appSettings.chatHistoryScrollbackItems,
      interruptedStatus: activeThreadId
        ? interruptedThreadById[activeThreadId] ?? null
        : null,
      activeTurnDiff: activeThreadId ? turnDiffByThread[activeThreadId] ?? null : null,
      turnExecutionSummary: activeThreadId
        ? turnExecutionSummaryByThread[activeThreadId] ?? null
        : null,
      turnExecutionSummaries: activeThreadId
        ? turnExecutionSummariesByThread[activeThreadId] ?? []
        : [],
      onUpdateConversationStyle: (next) => {
        void onUpdateAppSettings({
          ...appSettings,
          ...next,
        });
      },
      userInputRequests,
      onUserInputSubmit,
      onPlanAccept,
      onPlanSubmitChanges,
      onOpenThreadLink: handleOpenThreadLink,
      onQuoteMessage: composerWorkspaceState.canInsertComposerText
        ? composerWorkspaceState.handleInsertComposerText
        : undefined,
      onReferenceMessage,
      onResendUserMessage: (text, images, options) => {
        return retryEditedUserMessage(text, images, options);
      },
      isThinking:
        composerWorkspaceState.isProcessing ||
        Boolean(
          activeThreadId && pendingTurnStartByThread[activeThreadId],
        ),
      isLoadingMessages: activeThreadId
        ? threadResumeLoadingById[activeThreadId] ?? false
        : false,
      hasOlderHistory: activeThreadId
        ? threadHistoryPageByThread[activeThreadId]?.hasMore ?? false
        : false,
      isLoadingOlderHistory: activeThreadId
        ? threadHistoryPageByThread[activeThreadId]?.isLoading ?? false
        : false,
      onLoadOlderHistory:
        activeWorkspaceId && activeThreadId
          ? () => onLoadOlderThreadHistory(activeWorkspaceId, activeThreadId)
          : undefined,
      processingStartedAt: activeThreadId
        ? threadStatusById[activeThreadId]?.processingStartedAt ??
          pendingTurnStartByThread[activeThreadId]?.startedAt ??
          null
        : null,
      lastDurationMs: activeThreadId
        ? turnExecutionSummaryByThread[activeThreadId]?.workingDurationMs ??
          threadStatusById[activeThreadId]?.lastDurationMs ??
          null
        : null,
      showPollingFetchStatus: showMobilePollingFetchStatus,
      pollingIntervalMs: REMOTE_THREAD_POLL_INTERVAL_MS,
    },
    composerProps: composerWorkspaceState.showComposer
      ? {
          inputBackgroundColor: conversationAppearance.composerInputBackgroundColor,
          onSend: handleComposerSendWithDraftStart,
          onStop: () => {
            composerWorkspaceState.clearQueuedMessages(activeThreadId);
            interruptTurn();
          },
          canStop: composerWorkspaceState.canInterrupt,
          disabled: composerWorkspaceState.isReviewing,
          onFileAutocompleteActiveChange: composerWorkspaceState.setFileAutocompleteActive,
          contextUsage: activeTokenUsage,
          contextCompactionCount: activeContextCompactionCount,
          contextCompactionInProgress: isContextCompactionInProgress(activeItems),
          references: composerWorkspaceState.composerReferences,
          onToggleReference: composerWorkspaceState.toggleComposerReference,
          onRemoveReference: composerWorkspaceState.removeComposerReference,
          onMoveReference: composerWorkspaceState.reorderComposerReferences,
          onUndoReference: composerWorkspaceState.undoComposerReference,
          onRedoReference: composerWorkspaceState.redoComposerReference,
          queuedMessages: composerWorkspaceState.activeQueue,
          queuePausedReason: composerWorkspaceState.queuePausedReason,
          canSteerQueued: composerWorkspaceState.steerAvailable,
          onSteerQueued: (id) => {
            void composerWorkspaceState.steerQueuedMessage(id);
          },
          sendLabel: pullRequestComposer.composerSendLabel ?? "Send",
          steerAvailable: composerWorkspaceState.steerAvailable,
          followUpMessageBehavior: appSettings.followUpMessageBehavior,
          composerSendShortcut: appSettings.composerSendShortcut,
          onSelectComposerSendShortcut: (shortcut: ComposerSendShortcut) => {
            void onUpdateAppSettings({
              ...appSettings,
              composerSendShortcut: shortcut,
            });
          },
          composerTriggerMode: appSettings.composerTriggerMode ?? "default",
          onSelectComposerTriggerMode: (mode: ComposerTriggerMode) => {
            void onUpdateAppSettings({
              ...appSettings,
              composerTriggerMode: mode,
            });
          },
          isProcessing: composerWorkspaceState.isProcessing,
          autoReconnectEnabled: activeThreadId
            ? autoContinueStatusByThread[activeThreadId]?.enabled ?? false
            : false,
          autoReconnectPhase: activeThreadId
            ? autoContinueStatusByThread[activeThreadId]?.phase ?? "idle"
            : "idle",
          autoReconnectAttempt: activeThreadId
            ? autoContinueStatusByThread[activeThreadId]?.attempt ?? 0
            : 0,
          onAutoReconnectChange: activeThreadId
            ? (enabled) => setThreadAutoContinueEnabled(activeThreadId, enabled)
            : undefined,
          draftText: composerWorkspaceState.activeDraft,
          onDraftChange: composerWorkspaceState.handleDraftChange,
          pasteUndoKey: composerWorkspaceState.activeImageDraftKey,
          attachedImages: composerWorkspaceState.activeImages,
          onPickImages: composerWorkspaceState.pickImages,
          onAttachImages: composerWorkspaceState.attachImages,
          onRemoveImage: composerWorkspaceState.removeImage,
          onReplaceImages: composerWorkspaceState.replaceActiveImages,
          prefillDraft: composerWorkspaceState.prefillDraft,
          onPrefillHandled: (id) => {
            if (composerWorkspaceState.prefillDraft?.id === id) {
              composerWorkspaceState.setPrefillDraft(null);
            }
          },
          insertText: composerWorkspaceState.composerInsert,
          onInsertHandled: (id) => {
            if (composerWorkspaceState.composerInsert?.id === id) {
              composerWorkspaceState.setComposerInsert(null);
            }
          },
          onEditQueued: composerWorkspaceState.handleEditQueued,
          onDeleteQueued: composerWorkspaceState.handleDeleteQueued,
          collaborationModes,
          selectedCollaborationModeId,
          onSelectCollaborationMode,
          models,
          selectedModelId,
          onSelectModel,
          onRefreshModels,
          isRefreshingModels,
          reasoningOptions,
          selectedEffort,
          onSelectEffort,
          selectedServiceTier,
          reasoningSupported,
          codexArgsOptions,
          selectedCodexArgsOverride,
          onSelectCodexArgsOverride,
          selectedWorkflowGateId,
          onSelectWorkflowGateId,
          onVerifyWorkflowGate,
          accessMode,
          onSelectAccessMode,
          skills,
          appsEnabled: appSettings.experimentalAppsEnabled,
          apps,
          prompts,
          files: composerWorkspaceState.files,
          textareaRef: composerInputRef,
          historyKey: activeWorkspace?.id ?? null,
          editorSettings: composerEditorSettings,
          editorExpanded: composerEditorExpanded,
          onToggleEditorExpanded: onToggleComposerEditorExpanded,
          dictationEnabled: appSettings.dictationEnabled && dictationReady,
          dictationState,
          dictationLevel,
          onToggleDictation,
          onCancelDictation,
          onOpenDictationSettings: dictationUi.onOpenDictationSettings,
          dictationTranscript: dictationUi.dictationTranscript,
          onDictationTranscriptHandled: (id) => {
            clearDictationTranscript?.(id);
          },
          dictationError: dictationUi.dictationError,
          onDismissDictationError: clearDictationError,
          dictationHint: dictationUi.dictationHint,
          onDismissDictationHint: clearDictationHint,
          contextActions: composerContextActions,
          reviewPrompt,
          onReviewPromptClose: closeReviewPrompt,
          onReviewPromptShowPreset: showPresetStep,
          onReviewPromptChoosePreset: choosePreset,
          highlightedPresetIndex,
          onReviewPromptHighlightPreset: setHighlightedPresetIndex,
          highlightedBranchIndex,
          onReviewPromptHighlightBranch: setHighlightedBranchIndex,
          highlightedCommitIndex,
          onReviewPromptHighlightCommit: setHighlightedCommitIndex,
          onReviewPromptKeyDown: handleReviewPromptKeyDown,
          onReviewPromptSelectBranch: selectBranch,
          onReviewPromptSelectBranchAtIndex: selectBranchAtIndex,
          onReviewPromptConfirmBranch: confirmBranch,
          onReviewPromptSelectCommit: selectCommit,
          onReviewPromptSelectCommitAtIndex: selectCommitAtIndex,
          onReviewPromptConfirmCommit: confirmCommit,
          onReviewPromptUpdateCustomInstructions: updateCustomInstructions,
          onReviewPromptConfirmCustom: confirmCustom,
        }
      : null,
    approvalToastsProps: {
      approvals,
      workspaces,
      onDecision,
      onRemember,
    },
    updateToastProps: {
      state: appModalsAboutOpen ? { stage: "idle" as const } : updaterState,
      onUpdate: startUpdate,
      onDismiss: dismissUpdate,
      postUpdateNotice,
      onDismissPostUpdateNotice: dismissPostUpdateNotice,
    },
    errorToastsProps: {
      toasts: errorToasts,
      onDismiss: dismissErrorToast,
    },
    homeProps: {
      onStartNoProjectChat: () => {
        threadNavigation.exitDiffView();
        threadNavigation.clearDraftState();
        threadNavigation.selectWorkspace(LOCAL_CODEX_WORKSPACE_ID);
        if (isCompact) {
          setActiveTab("codex");
        }
      },
      onAddWorkspace: handleAddWorkspace,
      onAddWorkspaceFromUrl: openWorkspaceFromUrlPrompt,
      latestAgentRuns,
      isLoadingLatestAgents,
      localUsageSnapshot,
      isLoadingLocalUsage,
      localUsageError,
      onRefreshLocalUsage,
      usageMetric,
      onUsageMetricChange,
      usageWorkspaceId,
      usageWorkspaceOptions,
      onUsageWorkspaceChange,
      accountRateLimits: homeRateLimits,
      usageShowRemaining: appSettings.usageShowRemaining,
      accountInfo: homeAccount,
      onSelectThread: (workspaceId, threadId) => {
        threadNavigation.exitDiffView();
        threadNavigation.clearDraftState();
        threadNavigation.selectWorkspace(workspaceId);
        threadNavigation.setActiveThreadId(threadId, workspaceId);
        if (isCompact) {
          setActiveTab("codex");
        }
      },
    },
    mainHeaderProps: activeWorkspace
      ? {
          workspace: activeWorkspace,
          titleOverride: activeThreadTitleWithSource,
          parentName: worktreeState.activeParentWorkspace?.name ?? null,
          worktreeLabel: worktreeState.worktreeLabel,
          worktreeRename: worktreeState.worktreeRename ?? undefined,
          disableBranchMenu: worktreeState.isWorktreeWorkspace,
          parentPath: worktreeState.activeParentWorkspace?.path ?? null,
          worktreePath: worktreeState.isWorktreeWorkspace ? activeWorkspace.path : null,
          openTargets: appSettings.openAppTargets,
          openAppIconById,
          selectedOpenAppId: appSettings.selectedOpenAppId,
          onSelectOpenAppId: handleSelectOpenAppId,
          branchName: gitState.gitStatus.branchName || "unknown",
          branches: gitState.branches,
          onCheckoutBranch: gitState.handleCheckoutBranch,
          onCreateBranch: gitState.handleCreateBranch,
          canCopyThread: activeItems.length > 0,
          onCopyThread: handleCopyThread,
          onToggleTerminal: handleToggleTerminalWithFocus,
          isTerminalOpen: terminalOpen,
          showTerminalButton: !isCompact,
          showWorkspaceTools: !isCompact,
          launchScript: launchScriptState.launchScript,
          launchScriptEditorOpen: launchScriptState.editorOpen,
          launchScriptDraft: launchScriptState.draftScript,
          launchScriptSaving: launchScriptState.isSaving,
          launchScriptError: launchScriptState.error,
          onRunLaunchScript: launchScriptState.onRunLaunchScript,
          onOpenLaunchScriptEditor: launchScriptState.onOpenEditor,
          onCloseLaunchScriptEditor: launchScriptState.onCloseEditor,
          onLaunchScriptDraftChange: launchScriptState.onDraftScriptChange,
          onSaveLaunchScript: launchScriptState.onSaveLaunchScript,
          launchScriptsState,
          extraActionsNode: displayNodes.mainHeaderActionsNode,
        }
      : null,
    desktopTopbarProps: {
      showBackToChat: gitState.centerMode === "diff",
      onExitDiff: () => {
        gitState.setCenterMode("chat");
        gitState.setSelectedDiffPath(null);
      },
    },
    tabletNavProps: {
      activeTab: tabletTab,
      onSelect: setActiveTab,
    },
    tabBarProps: {
      activeTab,
      onSelect: (tab) => {
        if (tab === "home") {
          threadNavigation.resetPullRequestSelection();
          threadNavigation.clearDraftState();
          threadNavigation.selectHome();
          return;
        }
        setActiveTab(tab);
      },
    },
  };
}

function buildGitSurface({
  appSettings,
  activeWorkspace,
  gitState,
  composerWorkspaceState,
  promptActions,
  worktreeState,
  pullRequestComposer,
  openAppIconById,
  openInitGitRepoPrompt,
  startUncommittedReview,
  handleSelectOpenAppId,
  prompts,
  isPhone,
}: MainAppLayoutSurfacesContext): LayoutNodesOptions["git"] {
  return {
    filePanelMode: gitState.filePanelMode,
    fileTreeProps: activeWorkspace
      ? {
          workspaceId: activeWorkspace.id,
          workspacePath: activeWorkspace.path,
          files: composerWorkspaceState.files,
          modifiedFiles: [
            ...new Set([
              ...gitState.gitStatus.stagedFiles.map((file) => file.path),
              ...gitState.gitStatus.unstagedFiles.map((file) => file.path),
            ]),
          ],
          isLoading: composerWorkspaceState.isFilesLoading,
          filePanelMode: gitState.filePanelMode,
          onFilePanelModeChange: gitState.setFilePanelMode,
          onInsertText: composerWorkspaceState.handleInsertComposerText,
          canInsertText: composerWorkspaceState.canInsertComposerText,
          openTargets: appSettings.openAppTargets,
          openAppIconById,
          selectedOpenAppId: appSettings.selectedOpenAppId,
          onSelectOpenAppId: handleSelectOpenAppId,
        }
      : null,
    promptPanelProps: {
      prompts,
      workspacePath: activeWorkspace?.path ?? null,
      filePanelMode: gitState.filePanelMode,
      onFilePanelModeChange: gitState.setFilePanelMode,
      onSendPrompt: composerWorkspaceState.handleSendPrompt,
      onSendPromptToNewAgent: promptActions.handleSendPromptToNewAgent,
      onCreatePrompt: promptActions.handleCreatePrompt,
      onUpdatePrompt: promptActions.handleUpdatePrompt,
      onDeletePrompt: promptActions.handleDeletePrompt,
      onMovePrompt: promptActions.handleMovePrompt,
      onRevealWorkspacePrompts: promptActions.handleRevealWorkspacePrompts,
      onRevealGeneralPrompts: promptActions.handleRevealGeneralPrompts,
      canRevealGeneralPrompts: Boolean(activeWorkspace),
    },
    gitDiffPanelProps: {
      workspaceId: activeWorkspace?.id ?? null,
      workspacePath: activeWorkspace?.path ?? null,
      mode: gitState.gitPanelMode,
      onModeChange: gitState.handleGitPanelModeChange,
      filePanelMode: gitState.filePanelMode,
      onFilePanelModeChange: gitState.setFilePanelMode,
      worktreeApplyLabel: "apply",
      worktreeApplyTitle: worktreeState.activeParentWorkspace?.name
        ? `Apply changes to ${worktreeState.activeParentWorkspace.name}`
        : "Apply changes to parent workspace",
      worktreeApplyLoading: worktreeState.isWorktreeWorkspace
        ? gitState.worktreeApplyLoading
        : false,
      worktreeApplyError: worktreeState.isWorktreeWorkspace
        ? gitState.worktreeApplyError
        : null,
      worktreeApplySuccess: worktreeState.isWorktreeWorkspace
        ? gitState.worktreeApplySuccess
        : false,
      onApplyWorktreeChanges: worktreeState.isWorktreeWorkspace
        ? gitState.handleApplyWorktreeChanges
        : undefined,
      branchName: gitState.gitStatus.branchName || "unknown",
      totalAdditions: gitState.gitStatus.totalAdditions,
      totalDeletions: gitState.gitStatus.totalDeletions,
      fileStatus: gitState.fileStatus,
      perFileDiffGroups: gitState.perFileDiffGroups,
      error: gitState.gitStatus.error,
      logError: gitState.gitLogError,
      logLoading: gitState.gitLogLoading,
      stagedFiles: gitState.gitStatus.stagedFiles,
      unstagedFiles: gitState.gitStatus.unstagedFiles,
      onSelectFile:
        gitState.gitPanelMode === "perFile"
          ? gitState.handleSelectPerFileDiff
          : gitState.handleSelectDiff,
      logEntries: gitState.gitLogEntries,
      logTotal: gitState.gitLogTotal,
      logAhead: gitState.gitLogAhead,
      logBehind: gitState.gitLogBehind,
      logAheadEntries: gitState.gitLogAheadEntries,
      logBehindEntries: gitState.gitLogBehindEntries,
      logUpstream: gitState.gitLogUpstream,
      selectedCommitSha: gitState.selectedCommitSha,
      onSelectCommit: (entry) => {
        gitState.handleSelectCommit(entry.sha);
      },
      issues: gitState.gitIssues,
      issuesTotal: gitState.gitIssuesTotal,
      issuesLoading: gitState.gitIssuesLoading,
      issuesError: gitState.gitIssuesError,
      pullRequests: gitState.gitPullRequests,
      pullRequestsTotal: gitState.gitPullRequestsTotal,
      pullRequestsLoading: gitState.gitPullRequestsLoading,
      pullRequestsError: gitState.gitPullRequestsError,
      selectedPullRequest: gitState.selectedPullRequest?.number ?? null,
      onSelectPullRequest: (pullRequest) => {
        gitState.setSelectedCommitSha(null);
        pullRequestComposer.handleSelectPullRequest(pullRequest);
      },
      gitRemoteUrl: gitState.gitRemoteUrl,
      gitRoot: gitState.activeGitRoot,
      gitRootCandidates: gitState.gitRootCandidates,
      gitRootScanDepth: gitState.gitRootScanDepth,
      gitRootScanLoading: gitState.gitRootScanLoading,
      gitRootScanError: gitState.gitRootScanError,
      gitRootScanHasScanned: gitState.gitRootScanHasScanned,
      onGitRootScanDepthChange: gitState.setGitRootScanDepth,
      onScanGitRoots: gitState.scanGitRoots,
      onSelectGitRoot: (path) => {
        void gitState.handleSetGitRoot(path);
      },
      onClearGitRoot: () => {
        void gitState.handleSetGitRoot(null);
      },
      onPickGitRoot: gitState.handlePickGitRoot,
      onInitGitRepo: openInitGitRepoPrompt,
      initGitRepoLoading: gitState.initGitRepoLoading,
      onStageAllChanges: gitState.handleStageGitAll,
      onStageFile: gitState.handleStageGitFile,
      onUnstageFile: gitState.handleUnstageGitFile,
      onRevertFile: gitState.handleRevertGitFile,
      onRevertAllChanges: gitState.handleRevertAllGitChanges,
      onReviewUncommittedChanges: (workspaceId) =>
        startUncommittedReview(workspaceId ?? activeWorkspace?.id ?? null),
      commitMessage: gitState.commitMessage,
      commitMessageLoading: gitState.commitMessageLoading,
      commitMessageError: gitState.commitMessageError,
      onCommitMessageChange: gitState.handleCommitMessageChange,
      onGenerateCommitMessage: gitState.handleGenerateCommitMessage,
      onCommit: gitState.handleCommit,
      onCommitAndPush: gitState.handleCommitAndPush,
      onCommitAndSync: gitState.handleCommitAndSync,
      onPull: gitState.handlePull,
      onFetch: gitState.handleFetch,
      onPush: gitState.handlePush,
      onSync: gitState.handleSync,
      commitLoading: gitState.commitLoading,
      pullLoading: gitState.pullLoading,
      fetchLoading: gitState.fetchLoading,
      pushLoading: gitState.pushLoading,
      syncLoading: gitState.syncLoading,
      commitError: gitState.commitError,
      pullError: gitState.pullError,
      fetchError: gitState.fetchError,
      pushError: gitState.pushError,
      syncError: gitState.syncError,
      commitsAhead: gitState.gitLogAhead,
    },
    gitDiffViewerProps: {
      diffs: gitState.activeDiffs,
      selectedPath: gitState.selectedDiffPath,
      scrollRequestId: gitState.diffScrollRequestId,
      isLoading: gitState.activeDiffLoading,
      error: gitState.activeDiffError,
      ignoreWhitespaceChanges:
        appSettings.gitDiffIgnoreWhitespaceChanges && gitState.diffSource !== "pr",
      pullRequest: gitState.diffSource === "pr" ? gitState.selectedPullRequest : null,
      pullRequestComments:
        gitState.diffSource === "pr" ? gitState.gitPullRequestComments : [],
      pullRequestCommentsLoading: gitState.gitPullRequestCommentsLoading,
      pullRequestCommentsError: gitState.gitPullRequestCommentsError,
      pullRequestReviewActions: gitState.pullRequestReviewActions,
      onRunPullRequestReview: gitState.runPullRequestReview,
      pullRequestReviewLaunching: gitState.isLaunchingPullRequestReview,
      pullRequestReviewThreadId: gitState.lastPullRequestReviewThreadId,
      onCheckoutPullRequest: (pullRequest) =>
        gitState.handleCheckoutPullRequest(pullRequest.number),
      canRevert: gitState.diffSource === "local",
      onRevertFile: gitState.handleRevertGitFile,
      onActivePathChange: gitState.handleActiveDiffPath,
      onInsertComposerText: composerWorkspaceState.canInsertComposerText
        ? composerWorkspaceState.handleInsertComposerText
        : undefined,
    },
    diffViewProps: {
      centerMode: gitState.centerMode,
      isPhone,
      splitChatDiffView: appSettings.splitChatDiffView,
      gitDiffViewStyle: gitState.gitDiffViewStyle,
    },
  };
}

function buildSecondarySurface({
  activePlan,
  activePlanStream,
  activeTurnId,
  composerWorkspaceState,
  gitState,
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
  onClearDebug,
  onCopyDebug,
  onResizeDebug,
  onResizeTerminal,
  isPhone,
  setActiveTab,
  activeWorkspace,
  activeWorkspaceId,
  activeThreadId,
}: MainAppLayoutSurfacesContext): LayoutNodesOptions["secondary"] {
  return {
    planPanelProps: {
      plan: activePlan,
      planStream: activePlanStream,
      activeTurnId,
      isProcessing: composerWorkspaceState.isProcessing,
      activeWorkspaceId,
      activeThreadId,
      workspacePath: activeWorkspace?.path ?? null,
    },
    terminalDockProps: {
      isOpen: terminalOpen,
      terminals: terminalTabs,
      activeTerminalId,
      onSelectTerminal,
      onNewTerminal,
      onCloseTerminal,
      onOpenExternalTerminal,
      onResizeStart: onResizeTerminal,
    },
    terminalState,
    debugPanelProps: {
      entries: debugEntries,
      isOpen: debugOpen,
      onClear: onClearDebug,
      onCopy: onCopyDebug,
      onResizeStart: onResizeDebug,
    },
    compactNavProps: {
      onGoProjects: () => setActiveTab("projects"),
      centerMode: gitState.centerMode,
      selectedDiffPath: gitState.selectedDiffPath,
      onBackFromDiff: () => {
        gitState.setCenterMode("chat");
      },
      onShowSelectedDiff: () => {
        const fallbackPath = gitState.selectedDiffPath ?? gitState.activeDiffs[0]?.path;

        if (!fallbackPath) {
          return;
        }

        if (!gitState.selectedDiffPath) {
          gitState.setSelectedDiffPath(fallbackPath);
        }

        gitState.setCenterMode("diff");
        if (isPhone) {
          setActiveTab("git");
        }
      },
      hasActiveGitDiffs: gitState.activeDiffs.length > 0,
    },
  };
}

export function useMainAppLayoutSurfaces({
  appSettings,
  conversationAppearance,
  workspaces,
  groupedWorkspaces,
  workspaceGroupsCount,
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
  onSetThreadListSortKey,
  threadListOrganizeMode,
  onSetThreadListOrganizeMode,
  onRefreshAllThreads,
  activeWorkspace,
  activeWorkspaceId,
  activeThreadId,
  activeItems,
  threadHistoryPageByThread,
  onLoadOlderThreadHistory,
  itemsByThread,
  userInputRequests,
  approvals,
  activeRateLimits,
  activeAccount,
  homeRateLimits,
  homeAccount,
  homeAccountWorkspaceId,
  accountSwitching,
  onSwitchAccount,
  onCancelSwitchAccount,
  onDecision,
  onRemember,
  onUserInputSubmit,
  onPlanAccept,
  onPlanSubmitChanges,
  onReferenceMessage,
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
  onRefreshLocalUsage,
  usageMetric,
  onUsageMetricChange,
  usageWorkspaceId,
  usageWorkspaceOptions,
  onUsageWorkspaceChange,
  gitState,
  composerWorkspaceState,
  promptActions,
  worktreeState,
  sidebarHandlers,
  displayNodes,
  threadPinning,
  workspaceDrop,
  threadNavigation,
  pullRequestComposer,
  dictationUi,
  openAppIconById,
  openInitGitRepoPrompt,
  startUncommittedReview,
  handleAddWorkspace,
  openWorkspaceFromUrlPrompt,
  handleAddAgent,
  handleAddWorktreeAgent,
  handleAddCloneAgent,
  handleResumeThreadById,
  activeManagedSessionSourceName,
  handleSelectLocalCodexThread,
  handleOpenThreadLink,
  handleSelectOpenAppId,
  handleCopyThread,
  handleToggleTerminalWithFocus,
  launchScriptState,
  launchScriptsState,
  models,
  selectedModelId,
  onSelectModel,
  onRefreshModels,
  isRefreshingModels,
  collaborationModes,
  selectedCollaborationModeId,
  onSelectCollaborationMode,
  reasoningOptions,
  selectedEffort,
  onSelectEffort,
  selectedServiceTier,
  reasoningSupported,
  codexArgsOptions,
  selectedCodexArgsOverride,
  onSelectCodexArgsOverride,
  selectedWorkflowGateId,
  onSelectWorkflowGateId,
  onVerifyWorkflowGate,
  accessMode,
  onSelectAccessMode,
  skills,
  apps,
  prompts,
  composerInputRef,
  composerEditorSettings,
  composerEditorExpanded,
  onToggleComposerEditorExpanded,
  dictationReady,
  dictationState,
  dictationLevel,
  onToggleDictation,
  onCancelDictation,
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
  onClearDebug,
  onCopyDebug,
  onResizeDebug,
  onResizeTerminal,
  isCompact,
  isPhone,
  activeTab,
  setActiveTab,
  tabletTab,
  showMobilePollingFetchStatus,
  appModalsAboutOpen,
  updaterState,
  startUpdate,
  dismissUpdate,
  postUpdateNotice,
  dismissPostUpdateNotice,
  errorToasts,
  dismissErrorToast,
  showDebugButton,
  handleDebugClick,
  onUpdateAppSettings,
}: UseMainAppLayoutSurfacesArgs): LayoutNodesOptions {
  const { t } = useI18n();
  const sidebarAccount = activeWorkspace ? activeAccount : homeAccount;
  const { codexProviderStatus, thirdPartyProviderUsage } = useSidebarProviderUsage({
    appSettings,
    activeWorkspaceId,
    homeAccountWorkspaceId,
  });
  const sidebarRateLimits = resolveSidebarRateLimits(
    activeRateLimits,
    homeRateLimits,
    codexProviderStatus?.isConfigured === true &&
      !codexProviderStatus.isThirdParty,
  );
  const subagentResults = useMemo(
    () =>
      activeWorkspaceId && activeThreadId
        ? buildSubagentResultSummaries({
            parentItems: activeItems,
            threads: threadsByWorkspace[activeWorkspaceId] ?? [],
            itemsByThread,
            threadStatusById,
            fallbackTitle: t("messages.subagentFallbackTitle"),
          })
        : [],
    [
      activeItems,
      activeThreadId,
      activeWorkspaceId,
      itemsByThread,
      t,
      threadStatusById,
      threadsByWorkspace,
    ],
  );

  const context: MainAppLayoutSurfacesContext = {
    appSettings,
    conversationAppearance,
    onUpdateAppSettings,
    workspaces,
    groupedWorkspaces,
    workspaceGroupsCount,
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
    onSetThreadListSortKey,
    threadListOrganizeMode,
    onSetThreadListOrganizeMode,
    onRefreshAllThreads,
    activeWorkspace,
    activeWorkspaceId,
    activeThreadId,
    activeItems,
    threadHistoryPageByThread,
    onLoadOlderThreadHistory,
    itemsByThread,
    userInputRequests,
    approvals,
    activeRateLimits,
    activeAccount,
    homeRateLimits,
    homeAccount,
    homeAccountWorkspaceId,
    accountSwitching,
    onSwitchAccount,
    onCancelSwitchAccount,
    onDecision,
    onRemember,
    onUserInputSubmit,
    onPlanAccept,
    onPlanSubmitChanges,
    onReferenceMessage,
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
    onRefreshLocalUsage,
    usageMetric,
    onUsageMetricChange,
    usageWorkspaceId,
    usageWorkspaceOptions,
    onUsageWorkspaceChange,
    gitState,
    composerWorkspaceState,
    promptActions,
    worktreeState,
    sidebarHandlers,
    displayNodes,
    threadPinning,
    workspaceDrop,
    threadNavigation,
    pullRequestComposer,
    dictationUi,
    openAppIconById,
    openInitGitRepoPrompt,
    startUncommittedReview,
    handleAddWorkspace,
    openWorkspaceFromUrlPrompt,
    handleAddAgent,
    handleAddWorktreeAgent,
    handleAddCloneAgent,
    handleResumeThreadById,
    activeManagedSessionSourceName,
    handleSelectLocalCodexThread,
    handleOpenThreadLink,
    handleSelectOpenAppId,
    handleCopyThread,
    handleToggleTerminalWithFocus,
    launchScriptState,
    launchScriptsState,
    models,
    selectedModelId,
    onSelectModel,
    onRefreshModels,
    isRefreshingModels,
    collaborationModes,
    selectedCollaborationModeId,
    onSelectCollaborationMode,
    reasoningOptions,
    selectedEffort,
    onSelectEffort,
    selectedServiceTier,
    reasoningSupported,
    codexArgsOptions,
    selectedCodexArgsOverride,
    onSelectCodexArgsOverride,
    selectedWorkflowGateId,
    onSelectWorkflowGateId,
    onVerifyWorkflowGate,
    accessMode,
    onSelectAccessMode,
    skills,
    apps,
    prompts,
    composerInputRef,
    composerEditorSettings,
    composerEditorExpanded,
    onToggleComposerEditorExpanded,
    dictationReady,
    dictationState,
    dictationLevel,
    onToggleDictation,
    onCancelDictation,
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
    onClearDebug,
    onCopyDebug,
    onResizeDebug,
    onResizeTerminal,
    isCompact,
    isPhone,
    activeTab,
    setActiveTab,
    tabletTab,
    showMobilePollingFetchStatus,
    appModalsAboutOpen,
    updaterState,
    startUpdate,
    dismissUpdate,
    postUpdateNotice,
    dismissPostUpdateNotice,
    errorToasts,
    dismissErrorToast,
    showDebugButton,
    handleDebugClick,
    sidebarRateLimits,
    sidebarAccount,
    codexProviderStatus,
    thirdPartyProviderUsage,
    subagentResults,
  };

  return {
    primary: buildPrimarySurface(context),
    git: buildGitSurface(context),
    secondary: buildSecondarySurface(context),
  };
}
