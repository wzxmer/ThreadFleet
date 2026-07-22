export type WorkspaceSettings = {
  sidebarCollapsed: boolean;
  sortOrder?: number | null;
  groupId?: string | null;
  cloneSourceWorkspaceId?: string | null;
  gitRoot?: string | null;
  launchScript?: string | null;
  launchScripts?: LaunchScriptEntry[] | null;
  worktreeSetupScript?: string | null;
  worktreesFolder?: string | null;
};

export type LaunchScriptIconId =
  | "play"
  | "build"
  | "debug"
  | "wrench"
  | "terminal"
  | "code"
  | "server"
  | "database"
  | "package"
  | "test"
  | "lint"
  | "dev"
  | "git"
  | "config"
  | "logs";

export type LaunchScriptEntry = {
  id: string;
  script: string;
  icon: LaunchScriptIconId;
  label?: string | null;
};

export type WorkspaceGroup = {
  id: string;
  name: string;
  sortOrder?: number | null;
  copiesFolder?: string | null;
};

export type WorkspaceKind = "main" | "worktree";

export type WorktreeInfo = {
  branch: string;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  connected: boolean;
  kind?: WorkspaceKind;
  parentId?: string | null;
  worktree?: WorktreeInfo | null;
  settings: WorkspaceSettings;
};

export type WorkspaceRuntimeCodexArgsResult = {
  appliedCodexArgs: string | null;
  respawned: boolean;
  beforeProviderRuntimeFingerprint: string | null;
  afterProviderRuntimeFingerprint: string | null;
  sessionSourceId: string;
  configSynced: boolean;
};

export type AppServerEvent = {
  workspace_id: string;
  message: Record<string, unknown>;
};

export type TrayRecentThreadEntry = {
  workspaceId: string;
  workspaceLabel: string;
  threadId: string;
  threadLabel: string;
  updatedAt: number;
};

export type TraySessionUsage = {
  sessionLabel: string;
  weeklyLabel: string | null;
};

export type ReleaseAssetDownloadProgress = {
  id: string;
  downloadedBytes: number;
  totalBytes?: number | null;
};

export type TrayLabels = {
  open: string;
  hide: string;
  checkUpdates: string;
  launchAtStartup: string;
  restart: string;
  quit: string;
};

export type NativeMenuLabels = {
  about: string;
  checkForUpdates: string;
  settings: string;
  services: string;
  hide: string;
  hideOthers: string;
  quit: string;
  file: string;
  newAgent: string;
  newWorktreeAgent: string;
  newCloneAgent: string;
  addWorkspace: string;
  addWorkspaceFromUrl: string;
  closeWindow: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  composer: string;
  cycleModel: string;
  cycleAccess: string;
  cycleReasoning: string;
  cycleCollaboration: string;
  view: string;
  toggleProjectsSidebar: string;
  toggleGitSidebar: string;
  toggleDebugPanel: string;
  toggleTerminal: string;
  nextAgent: string;
  previousAgent: string;
  nextWorkspace: string;
  previousWorkspace: string;
  toggleFullScreen: string;
  window: string;
  minimize: string;
  maximize: string;
  help: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type CollabAgentRef = {
  threadId: string;
  nickname?: string;
  role?: string;
};

export type CollabAgentStatus = CollabAgentRef & {
  status: string;
};

export type ConversationItem = (
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      text: string;
      phase?: string;
      createdAt?: number;
      images?: string[];
      attachments?: string[];
    }
  | {
      id: string;
      kind: "subagentCheckpoint";
      createdAt?: number;
      checkpoints: {
        checkpointId: string;
        childThreadId: string;
        childName?: string;
        priority: "normal" | "final";
        sequence: number;
        text: string;
      }[];
    }
  | {
      id: string;
      kind: "userInput";
      status: "answered";
      questions: {
        id: string;
        header: string;
        question: string;
        answers: string[];
      }[];
    }
  | { id: string; kind: "reasoning"; summary: string; content: string }
  | { id: string; kind: "diff"; title: string; diff: string; status?: string }
  | { id: string; kind: "review"; state: "started" | "completed"; text: string }
  | {
      id: string;
      kind: "explore";
      status: "exploring" | "explored";
      entries: { kind: "read" | "search" | "list" | "run"; label: string; detail?: string }[];
    }
  | {
      id: string;
      kind: "process";
      processType: "skillTriggered" | "agentSelected" | "agentSpawned";
      label: string;
      detail?: string;
      status?: string;
    }
  | {
      id: string;
      kind: "tool";
      toolType: string;
      title: string;
      detail: string;
      status?: string;
      output?: string;
      durationMs?: number | null;
      lineChangeStats?: LineChangeStats;
      changes?: { path: string; kind?: string; diff?: string }[];
      collabSender?: CollabAgentRef;
      collabReceiver?: CollabAgentRef;
      collabReceivers?: CollabAgentRef[];
      collabStatuses?: CollabAgentStatus[];
      collabModel?: string;
      collabReasoningEffort?: string;
    }
) & { turnId?: string };

export type LineChangeStats = {
  additions: number;
  deletions: number;
};

export type ThreadSummary = {
  id: string;
  name: string;
  updatedAt: number;
  createdAt?: number;
  cwd?: string | null;
  modelId?: string | null;
  effort?: string | null;
  isSubagent?: boolean;
  subagentNickname?: string | null;
  subagentRole?: string | null;
  subagentCheckpointStatus?: "pending" | "delivered" | "failed" | null;
  subagentCheckpointCount?: number;
};

export type SessionSourceStatus =
  | "ready"
  | "missing"
  | "denied"
  | "invalid"
  | "scanning";

export type SessionSource = {
  id: string;
  name: string;
  codexHomePath: string;
  enabled: boolean;
  isCurrent: boolean;
  isDefault: boolean;
  discoveredAt: number;
  lastScanAt: number | null;
  status: SessionSourceStatus;
  error: string | null;
};

export type SourceScopedSessionKey = {
  sourceId: string;
  threadId: string;
};

export type SessionFileStatus = "mapped" | "unmapped" | "missing" | "invalid";
export type SessionFileConfidence = "exact" | "inferred" | "ambiguous" | "none";

export type ManagedSession = {
  key: string;
  sourceId: string;
  threadId: string;
  sourceKind: string | null;
  cwd: string | null;
  title: string;
  preview: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  archivedAt: number | null;
  isArchived: boolean;
  parentThreadId: string | null;
  isSubagent: boolean;
  subagentNickname: string | null;
  subagentRole: string | null;
  projectExists: boolean;
  fileStatus: SessionFileStatus;
  fileConfidence: SessionFileConfidence;
};

export type SessionSearchRequest = {
  requestId: string;
  query: string;
  sourceIds: string[];
  includeArchived: boolean;
  includeSubagents: boolean;
};

export type SessionSearchMatchField =
  | "title"
  | "threadId"
  | "projectName"
  | "projectPath"
  | "userMessage"
  | "agentReply";

export type SessionSearchMatch = {
  field: SessionSearchMatchField;
  snippet: string | null;
};

export type SessionSearchResult = {
  session: ManagedSession;
  matches: SessionSearchMatch[];
  incomplete: boolean;
};

export type SessionSearchProgress = {
  requestId: string;
  scannedSources: number;
  totalSources: number;
  scannedFiles: number;
  totalFiles: number | null;
  completed: boolean;
  cancelled: boolean;
  incomplete: boolean;
};
export type SessionSearchResponse = {
  results: SessionSearchResult[];
  progress: SessionSearchProgress;
};

export type SessionSourceUpdateRequest = {
  action: "add" | "rename" | "setEnabled" | "remove";
  sourceId?: string | null;
  name?: string | null;
  path?: string | null;
  enabled?: boolean | null;
};

export type SessionScanRequest = {
  requestId: string;
  sourceIds?: string[];
  includeArchived?: boolean;
};

export type SessionScanSummary = {
  requestId: string;
  totalSessions: number;
  diagnosticCount: number;
  cancelled: boolean;
  sourceSnapshots: SessionSourceSnapshot[];
};

export type SessionSourceSnapshot = {
  sourceId: string;
  generation: number;
  fingerprint: string;
  complete: boolean;
  scannedAt: number;
};

export type VerifySessionThreadsRequest = {
  sourceId: string;
  threadIds: string[];
};

export type SessionThreadPresence = "present" | "missing" | "unknown";

export type SessionThreadVerification = {
  threadId: string;
  presence: SessionThreadPresence;
};

export type VerifySessionThreadsResponse = {
  snapshot: SessionSourceSnapshot;
  threads: SessionThreadVerification[];
  diagnostics: SessionScanDiagnostic[];
};

export type ManagedSessionPageRequest = {
  requestId: string;
  offset?: number;
  limit?: number;
};

export type SessionScanDiagnostic = {
  sourceId: string;
  path: string | null;
  error: string;
};

export type ManagedSessionPage = {
  requestId: string;
  items: ManagedSession[];
  diagnostics: SessionScanDiagnostic[];
  total: number;
  nextOffset: number | null;
};

export type ManagedSessionPreviewRequest = {
  sourceId: string;
  threadId: string;
  limit?: number;
  cursor?: number | null;
  full?: boolean;
};

export type ManagedSessionPreviewItem = {
  role: "user" | "assistant";
  text: string;
};

export type ManagedSessionPreviewResponse = {
  openingMessage: string | null;
  items: ManagedSessionPreviewItem[];
  nextCursor?: number | null;
  incomplete: boolean;
};

export type ResumeManagedSessionRequest = {
  sourceId: string;
  threadId: string;
};

export type ResumeManagedSessionResponse = {
  workspace: WorkspaceInfo;
  threadId: string;
  sourceId: string;
  sourceName: string;
};

export type ArchiveManagedSessionItem = {
  sourceId: string;
  threadId: string;
};

export type ArchiveManagedSessionsRequest = {
  items: ArchiveManagedSessionItem[];
};

export type ArchiveManagedSessionResult = ArchiveManagedSessionItem & {
  success: boolean;
  archivedAt: number | null;
  error: string | null;
};

export type ArchiveManagedSessionsResponse = {
  results: ArchiveManagedSessionResult[];
  successCount: number;
  failureCount: number;
};

export type PermanentlyDeleteManagedSessionRequest = {
  sourceId: string;
  threadId: string;
  archivedAt: number;
  cascadeRequested: boolean;
};

export type PermanentlyDeleteManagedSessionResponse = {
  results: Array<{ sourceId: string; threadId: string; success: boolean; error: string | null }>;
  successCount: number;
  failureCount: number;
};

export type ManagedSessionCleanupRequest = {
  retentionDays: 30 | 60 | 90 | 180;
  protectedThreadIds: string[];
};

export type ManagedSessionCleanupPreview = {
  eligibleCount: number;
};

export type ManagedSessionCleanupResponse = PermanentlyDeleteManagedSessionResponse;

export type ManagedSessionCleanupSchedulerRequest = {
  protectedThreadIds: string[];
};

export type ManagedSessionCleanupSchedulerResponse = ManagedSessionCleanupResponse & {
  ran: boolean;
};

export type PrepareManagedSessionDerivationRequest = {
  sourceId: string;
  threadId: string;
};

export type ManagedSessionDerivationPreview = {
  sourceSession: ManagedSession;
  sourceName: string;
  sourceSessionKey: string;
  handoffContent: string;
  userMessageCount: number;
  agentReplyCount: number;
  incomplete: boolean;
};

export type ThreadListSortKey = "created_at" | "updated_at";
export type ThreadListOrganizeMode =
  | "by_project"
  | "by_project_activity"
  | "threads_only";

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export type PullRequestReviewIntent =
  | "full"
  | "risks"
  | "tests"
  | "summary"
  | "question";

export type PullRequestReviewAction = {
  id: string;
  label: string;
  intent: PullRequestReviewIntent;
};

export type PullRequestSelectionLine = {
  type: "add" | "del" | "context";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type PullRequestSelectionRange = {
  path: string;
  status: string;
  start: number;
  end: number;
  lines: PullRequestSelectionLine[];
};

export type AccessMode = "read-only" | "current" | "full-access";
export type ServiceTier = "fast" | "flex";
export type BackendMode = "local" | "remote";
export type RemoteBackendProvider = "tcp";
export type RemoteBackendTarget = {
  id: string;
  name: string;
  provider: RemoteBackendProvider;
  host: string;
  token: string | null;
  lastConnectedAtMs?: number | null;
};
export type ThemePreference = "system" | "light" | "dark" | "dim";
export type ThemeAccentPreference = "codex" | "blue" | "green" | "pink" | "orange";
export type MessageReadingStyle = "bubble" | "native" | "cli";
export type AppLanguagePreference = "system" | "zh" | "en";
export type PersonalityPreference = "friendly" | "pragmatic";
export type FollowUpMessageBehavior = "queue" | "steer";
export type SubagentCheckpointSyncMode = "finalOnly" | "checkpoints" | "continuous";
export type ComposerSendShortcut =
  | "enter"
  | "ctrl-enter"
  | "steer-priority"
  | "enter-and-ctrl-enter";
export type ComposerTriggerMode = "default" | "swap-slash-at";
export type ComposerSendIntent = "default" | "queue" | "steer";
export type SendMessageResult = {
  status: "sent" | "blocked" | "steer_failed";
};

export type ComposerEditorPreset = "default" | "helpful" | "smart";

export type ComposerLargePasteBehavior = "smart" | "keepText";

export type ComposerEditorSettings = {
  preset: ComposerEditorPreset;
  expandFenceOnSpace: boolean;
  expandFenceOnEnter: boolean;
  fenceLanguageTags: boolean;
  fenceWrapSelection: boolean;
  autoWrapPasteMultiline: boolean;
  autoWrapPasteCodeLike: boolean;
  largePasteBehavior?: ComposerLargePasteBehavior;
  continueListOnShiftEnter: boolean;
};

export type OpenAppTarget = {
  id: string;
  label: string;
  kind: "app" | "command" | "finder";
  appName?: string | null;
  command?: string | null;
  args: string[];
};

export type CodexProviderKind =
  | "openai"
  | "deepseek"
  | "openrouter"
  | "opencode"
  | "custom";

export type ReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type CodexProviderModel = {
  id: string;
  name: string | null;
  contextWindow: number | null;
  supportedReasoningEfforts?: ReasoningEffortOption[];
  defaultReasoningEffort?: string | null;
};

export type CodexKeyProfile = {
  id: string;
  name: string;
  providerKind?: CodexProviderKind;
  keyEnvVar: string;
  key: string;
  baseUrlEnvVar: string;
  baseUrl: string | null;
  model?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  useGateway?: boolean;
  supportsThinking?: boolean;
  supportsReasoningEffort?: boolean;
  lastModelRefreshAtMs?: number | null;
  cachedModels?: CodexProviderModel[];
  groupName?: string | null;
};

export type CodexProviderStatus = {
  providerName: string | null;
  baseUrl: string | null;
  source: string;
  isConfigured: boolean;
  isThirdParty: boolean;
  autoCompactTokenLimit: number | null;
  modelContextWindow: number | null;
  error: string | null;
};

export type TokenEfficiencyMode = "quality" | "balanced" | "economy";
export type WorkflowRuntimeMode = "off" | "shadow" | "active";

export type CommandExecutionPolicy = "auto" | "prefer-python" | "prefer-powershell" | "native-only";

export type CommandIntent =
  | "python-automation"
  | "powershell-windows"
  | "native-cli"
  | "existing-script"
  | "unknown";

export type CommandRoute = {
  runner: "python" | "powershell" | "native";
  executable: string;
  args: string[];
  reason: string;
  requiresConfirmation: boolean;
};

export type PythonDetectionResult = {
  available: boolean;
  interpreterPath: string | null;
  version: string | null;
  utf8SmokeTestPassed: boolean | null;
  source: string | null;
};

export type AppSettings = {
  codexBin: string | null;
  codexArgs: string | null;
  codexHome: string | null;
  sessionSources: SessionSource[];
  codexKeyProfiles: CodexKeyProfile[];
  activeCodexKeyProfileId: string | null;
  preserveSessionLibraryOnProviderSwitch: boolean;
  syncProviderProfileToLocalConfig: boolean;
  backendMode: BackendMode;
  remoteBackendProvider: RemoteBackendProvider;
  remoteBackendHost: string;
  remoteBackendToken: string | null;
  remoteBackends: RemoteBackendTarget[];
  activeRemoteBackendId: string | null;
  keepDaemonRunningAfterAppClose: boolean;
  defaultAccessMode: AccessMode;
  reviewDeliveryMode: "inline" | "detached";
  composerModelShortcut: string | null;
  composerAccessShortcut: string | null;
  composerReasoningShortcut: string | null;
  composerCollaborationShortcut: string | null;
  interruptShortcut: string | null;
  newAgentShortcut: string | null;
  newWorktreeAgentShortcut: string | null;
  newCloneAgentShortcut: string | null;
  archiveThreadShortcut: string | null;
  toggleProjectsSidebarShortcut: string | null;
  toggleGitSidebarShortcut: string | null;
  branchSwitcherShortcut: string | null;
  toggleDebugPanelShortcut: string | null;
  toggleTerminalShortcut: string | null;
  cycleAgentNextShortcut: string | null;
  cycleAgentPrevShortcut: string | null;
  cycleWorkspaceNextShortcut: string | null;
  cycleWorkspacePrevShortcut: string | null;
  lastComposerModelId: string | null;
  lastComposerReasoningEffort: string | null;
  tokenEfficiencyMode?: TokenEfficiencyMode;
  toolOutputTokenLimit?: number | null;
  workflowRuntimeMode?: WorkflowRuntimeMode;
  commandExecutionPolicy?: CommandExecutionPolicy;
  pythonInterpreterPath?: string | null;
  uiScale: number;
  appLanguage: AppLanguagePreference;
  theme: ThemePreference;
  themeAccent: ThemeAccentPreference;
  showCodexUsage: boolean;
  usageShowRemaining: boolean;
  showMessageFilePath: boolean;
  messageToolGroupsCollapsedByDefault: boolean;
  messageReadingStyle: MessageReadingStyle;
  messageCanvasColor: string;
  messageUserBubbleColor: string;
  messageUserTextColor: string;
  messageAssistantBubbleColor: string;
  messageAssistantAccentColor: string;
  messageAssistantTextColor: string;
  messageFontFamily: string;
  chatHistoryScrollbackItems: number | null;
  threadTitleAutogenerationEnabled: boolean;
  autoArchiveThreadsEnabled: boolean;
  autoArchiveThreadsDays: number;
  autoDeleteArchivedThreadsEnabled: boolean;
  autoDeleteArchivedThreadsDays: 30 | 60 | 90 | 180;
  automaticAppUpdateChecksEnabled: boolean;
  uiFontFamily: string;
  uiLatinFontFamily: string;
  uiCjkFontFamily: string;
  uiFontSize: number;
  uiFontWeight: number;
  codeFontFamily: string;
  messageFontSize: number;
  processFontSize: number;
  messageFontWeight: number;
  codeFontSize: number;
  notificationSoundsEnabled: boolean;
  systemNotificationsEnabled: boolean;
  subagentSystemNotificationsEnabled: boolean;
  nativeAgentMarkdownImportEnabled: boolean;
  splitChatDiffView: boolean;
  preloadGitDiffs: boolean;
  gitDiffIgnoreWhitespaceChanges: boolean;
  commitMessagePrompt: string;
  commitMessageModelId: string | null;
  collaborationModesEnabled: boolean;
  steerEnabled: boolean;
  followUpMessageBehavior: FollowUpMessageBehavior;
  subagentCheckpointSyncMode: SubagentCheckpointSyncMode;
  composerSendShortcut: ComposerSendShortcut;
  composerTriggerMode?: ComposerTriggerMode;
  composerFollowUpHintEnabled: boolean;
  pauseQueuedMessagesWhenResponseRequired: boolean;
  unifiedExecEnabled: boolean;
  experimentalAppsEnabled: boolean;
  personality: PersonalityPreference;
  dictationEnabled: boolean;
  dictationModelId: string;
  dictationPreferredLanguage: string | null;
  dictationHoldKey: string | null;
  composerEditorPreset: ComposerEditorPreset;
  composerFenceExpandOnSpace: boolean;
  composerFenceExpandOnEnter: boolean;
  composerFenceLanguageTags: boolean;
  composerFenceWrapSelection: boolean;
  composerFenceAutoWrapPasteMultiline: boolean;
  composerFenceAutoWrapPasteCodeLike: boolean;
  composerLargePasteBehavior?: ComposerLargePasteBehavior;
  composerListContinuation: boolean;
  composerCodeBlockCopyUseModifier: boolean;
  workspaceGroups: WorkspaceGroup[];
  globalWorktreesFolder: string | null;
  openAppTargets: OpenAppTarget[];
  selectedOpenAppId: string;
};

export type CodexFeatureStage =
  | "under_development"
  | "beta"
  | "stable"
  | "deprecated"
  | "removed";

export type CodexFeature = {
  name: string;
  stage: CodexFeatureStage;
  enabled: boolean;
  defaultEnabled: boolean;
  displayName: string | null;
  description: string | null;
  announcement: string | null;
};

export type TcpDaemonState = "stopped" | "running" | "error";

export type TcpDaemonStatus = {
  state: TcpDaemonState;
  pid: number | null;
  startedAtMs: number | null;
  lastError: string | null;
  listenAddr: string | null;
};

export type TailscaleStatus = {
  installed: boolean;
  running: boolean;
  version: string | null;
  dnsName: string | null;
  hostName: string | null;
  tailnetName: string | null;
  ipv4: string[];
  ipv6: string[];
  suggestedRemoteHost: string | null;
  message: string;
};

export type TailscaleDaemonCommandPreview = {
  command: string;
  daemonPath: string;
  args: string[];
  tokenConfigured: boolean;
};

export type CodexDoctorResult = {
  ok: boolean;
  codexBin: string | null;
  resolvedCodexBin?: string | null;
  version: string | null;
  npmGlobalCodexVersion?: string | null;
  appServerOk: boolean;
  details: string | null;
  path: string | null;
  nodeOk: boolean;
  nodeVersion: string | null;
  nodeDetails: string | null;
};

export type InstalledManagedCodex = {
  path: string;
  version: string;
};

export type CodexStatus = {
  codexHomePath: string | null;
  codexHomeSource: string;
  configPath: string | null;
  configExists: boolean;
  globalAgentsPath: string | null;
  globalAgentsExists: boolean;
  codexSkillsPath: string | null;
  codexSkillsCount: number;
  agentsSkillsPath: string | null;
  agentsSkillsCount: number;
  model: string | null;
  modelError: string | null;
};

export type CodexSyncDiagnostics = {
  username: string | null;
  userProfile: string | null;
  codexHomePath: string | null;
  codexHomeSource: string;
  sessionsPath: string | null;
  sessionsExists: boolean;
  sessionFileCount: number;
  latestSessionPath: string | null;
  latestSessionModifiedMs: number | null;
};

export type CodexUpdateMethod = "brew_formula" | "brew_cask" | "npm" | "unknown";

export type CodexUpdateResult = {
  ok: boolean;
  method: CodexUpdateMethod;
  package: string | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  upgraded: boolean;
  output: string | null;
  details: string | null;
};

export type ApprovalRequest = {
  workspace_id: string;
  request_id: number | string;
  method: string;
  params: Record<string, unknown>;
};

export type RequestUserInputOption = {
  label: string;
  description: string;
};

export type RequestUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  options?: RequestUserInputOption[];
};

export type RequestUserInputParams = {
  thread_id: string;
  turn_id: string;
  item_id: string;
  questions: RequestUserInputQuestion[];
};

export type RequestUserInputRequest = {
  workspace_id: string;
  request_id: number | string;
  params: RequestUserInputParams;
};

export type RequestUserInputAnswer = {
  answers: string[];
};

export type RequestUserInputResponse = {
  answers: Record<string, RequestUserInputAnswer>;
};

export type GitFileStatus = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type GitFileDiff = {
  path: string;
  diff: string;
  oldLines?: string[];
  newLines?: string[];
  isBinary?: boolean;
  isImage?: boolean;
  oldImageData?: string | null;
  newImageData?: string | null;
  oldImageMime?: string | null;
  newImageMime?: string | null;
};

export type GitCommitDiff = {
  path: string;
  status: string;
  diff: string;
  oldLines?: string[];
  newLines?: string[];
  isBinary?: boolean;
  isImage?: boolean;
  oldImageData?: string | null;
  newImageData?: string | null;
  oldImageMime?: string | null;
  newImageMime?: string | null;
};

export type GitLogEntry = {
  sha: string;
  summary: string;
  author: string;
  timestamp: number;
};

export type GitLogResponse = {
  total: number;
  entries: GitLogEntry[];
  ahead: number;
  behind: number;
  aheadEntries: GitLogEntry[];
  behindEntries: GitLogEntry[];
  upstream: string | null;
};

export type GitHubIssue = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
};

export type GitHubIssuesResponse = {
  total: number;
  issues: GitHubIssue[];
};

export type GitHubUser = {
  login: string;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  author: GitHubUser | null;
};

export type GitHubPullRequestsResponse = {
  total: number;
  pullRequests: GitHubPullRequest[];
};

export type GitHubPullRequestDiff = {
  path: string;
  status: string;
  diff: string;
};

export type GitHubPullRequestComment = {
  id: number;
  body: string;
  createdAt: string;
  url: string;
  author: GitHubUser | null;
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costUsd?: number | null;
};

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type LocalUsageDay = {
  day: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  agentTimeMs: number;
  agentRuns: number;
};

export type LocalUsageTotals = {
  lastHourTokens: number;
  last7DaysTokens: number;
  last30DaysTokens: number;
  monthTokens?: number;
  averageDailyTokens: number;
  cacheHitRatePercent: number;
  peakDay: string | null;
  peakDayTokens: number;
};

export type LocalUsageModel = {
  model: string;
  tokens: number;
  sharePercent: number;
};

export type LocalUsageSnapshot = {
  updatedAt: number;
  days: LocalUsageDay[];
  totals: LocalUsageTotals;
  topModels: LocalUsageModel[];
  topSources?: LocalUsageSource[];
};

export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";

export type TurnPlanStep = {
  step: string;
  status: TurnPlanStepStatus;
};

export type TurnPlan = {
  turnId: string;
  explanation: string | null;
  steps: TurnPlanStep[];
};

export type TurnExecutionStatus =
  | "active"
  | "completed"
  | "interrupted"
  | "failed";

export type TurnExecutionSummary = {
  schemaVersion: 1;
  executionId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  turnChain: string[];
  status: TurnExecutionStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  workingDurationMs: number | null;
  addedLines: number | null;
  deletedLines: number | null;
  diffRevision: number;
  recordRevision: number;
  updatedAtMs: number;
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CreditsSnapshot = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type RateLimitSnapshot = {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: string | null;
};

export type AccountSnapshot = {
  type: "chatgpt" | "apikey" | "unknown";
  email: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean | null;
};

export type QueuedMessage = {
  id: string;
  text: string;
  createdAt: number;
  images?: string[];
  appMentions?: AppMention[];
  references?: ComposerReference[];
};

export type LocalUsageSource = {
  source: string;
  tokens: number;
  sharePercent: number;
};

export type ComposerReference = {
  id: string;
  sourceTitle: string;
  sourceRole: "user" | "assistant";
  content: string;
  prompt: string;
  mode: "smart" | "full";
  referenceId?: string;
  path?: string;
  collapsed: boolean;
};

export type AppMention = {
  name: string;
  path: string;
};

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: string | null;
  isDefault: boolean;
};

export type CollaborationModeOption = {
  id: string;
  label: string;
  mode: string;
  model: string;
  reasoningEffort: string | null;
  developerInstructions: string | null;
  value: Record<string, unknown>;
};

export type SkillOption = {
  name: string;
  path: string;
  description?: string;
  scope?: WorkflowCapabilityScope;
  providerKinds?: CodexProviderKind[];
  modelPatterns?: string[];
  triggerKeywords?: string[];
  capabilityRequirements?: WorkflowCapabilityName[];
  providerOverrides?: Partial<
    Record<
      CodexProviderKind,
      {
        capabilityRequirements?: WorkflowCapabilityName[];
        fallback?: string;
      }
    >
  >;
  modelOverrides?: Record<
    string,
    {
      capabilityRequirements?: WorkflowCapabilityName[];
      fallback?: string;
    }
  >;
  fallback?: string;
  priority?: number;
  trustLevel?: "trusted" | "prompt" | "untrusted";
  source?: "global" | "user" | "project" | "native";
  instructions?: string;
};

export type WorkflowCapabilityScope = "public" | "provider" | "model";

export type WorkflowAgentOption = {
  name: string;
  path: string;
  description?: string;
  scope?: WorkflowCapabilityScope;
  providerKinds?: CodexProviderKind[];
  modelPatterns?: string[];
  capabilityRequirements?: WorkflowCapabilityName[];
  triggerKeywords?: string[];
  fallback?: string;
  priority?: number;
  trustLevel?: "trusted" | "prompt" | "untrusted";
  source?: "global" | "user" | "project" | "native";
  developerInstructions?: string;
};

export type WorkflowCapabilityName =
  | "tool_calling"
  | "structured_output"
  | "parallel_tools"
  | "streaming"
  | "vision"
  | "long_context"
  | "file_access"
  | "shell_access";

export type WorkflowCapabilitySupport = "supported" | "unsupported" | "unknown";

export type CoordinationMode = "advisory" | "guarded";
export type GroupStatus = "active" | "completed" | "archived";
export type ParticipantRole = "worker" | "coordinator" | "reviewer" | "observer";
export type ParticipantState = "planned" | "active" | "waiting" | "blocked" | "completed" | "detached";
export type LeaseState = "released" | "active" | "uncertain";
export type ResourceKind = "file" | "directory" | "logical";
export type AccessLevel = "read" | "write" | "exclusive";
export type ClaimState = "proposed" | "granted" | "conflicted" | "released";

export type TaskCoordinationThreadKey = {
  source: string;
  workspace_id: string;
  thread_id: string;
};

export type TaskCoordinationGroup = {
  id: string;
  name: string;
  repository_id: string;
  repository_root: string;
  base_revision: string | null;
  coordinator_thread_key: TaskCoordinationThreadKey | null;
  mode: CoordinationMode;
  status: GroupStatus;
  created_at: number;
  updated_at: number;
};

export type TaskResourceClaim = {
  id: string;
  group_id: string;
  owner_thread_key: TaskCoordinationThreadKey;
  kind: ResourceKind;
  resource_key: string;
  access: AccessLevel;
  state: ClaimState;
  reason: string | null;
  created_at: number;
  updated_at: number;
};

export type ConflictResult = {
  conflicting_claim_id: string;
  existing_access: AccessLevel;
  new_access: AccessLevel;
  reason: string;
};

export type CandidateStrength = "strong" | "medium" | "weak";

export type CandidateMatch = {
  thread_key: TaskCoordinationThreadKey;
  reason: string;
  strength: CandidateStrength;
};

export type ShadowTaskComplexity = "low" | "medium" | "high";
export type ShadowTaskRisk = "low" | "medium" | "high";
export type ShadowSpawnOutcome = "not_attempted" | "succeeded" | "failed";

export type ShadowTaskSignals = {
  complexity: ShadowTaskComplexity;
  risk: ShadowTaskRisk;
  parallelizable: boolean;
  requiresWrite: boolean;
  requiresIndependentReview?: boolean;
  requiresUserDecision?: boolean;
};

export type ShadowVerifiedModelCapability = {
  providerId: string;
  modelId: string;
  verified: boolean;
  supportedReasoningEfforts?: string[];
};

export type ShadowProviderContext = {
  activeProviderId: string;
  selectedProviderId: string;
  selectedModelId: string;
  selectedReasoningEffort: string | null;
  models?: ShadowVerifiedModelCapability[];
};

export type ShadowResourceRequest = {
  kind: ResourceKind;
  resourceKey: string;
  access: AccessLevel;
};

export type ShadowCoordinationContext = {
  groupId: string;
  owner: TaskCoordinationThreadKey;
  resources?: ShadowResourceRequest[];
};

export type ShadowRuntimeState = {
  activeSlots: number;
  depth: number;
  rootTokensUsed: number;
  subtaskTokensEstimate: number;
  elapsedMs: number;
  retryCount: number;
  fallbackCount: number;
  spawnOutcome?: ShadowSpawnOutcome;
};

export type ShadowApprovedPlanRef = {
  planId: string;
  planRevision: number;
  planHash: string;
  approvalReceiptId: string;
  nodeId: string;
  taskFingerprint: string;
};

export type ShadowExpectedBinding = {
  modelId: string;
  reasoningEffort: string;
};

export type ShadowActualBinding = {
  modelId: string | null;
  reasoningEffort: string | null;
};

export type ExecutionBindingStatus =
  | "awaiting_expected"
  | "awaiting_actual"
  | "matched"
  | "mismatch"
  | "invalid_expected"
  | "stale"
  | "conflict";

export type ExecutionBindingReasonCode =
  | "binding_expired"
  | "plan_revision_stale"
  | "registration_conflict"
  | "actual_binding_conflict"
  | "sender_thread_mismatch";

export type ExecutionBindingRecord = {
  schemaVersion: number;
  workspaceId: string;
  parentThreadId: string;
  collabToolCallId: string;
  receiverThreadIds: string[];
  activePlanRevision: number | null;
  approvedPlan: ShadowApprovedPlanRef | null;
  expected: ShadowExpectedBinding | null;
  provider: ShadowProviderContext | null;
  actual: ShadowActualBinding | null;
  audit: ShadowBindingAudit | null;
  status: ExecutionBindingStatus;
  reasonCodes: ExecutionBindingReasonCode[];
  registeredAtMs: number | null;
  observedAtMs: number | null;
  expiresAtMs: number | null;
  recordRevision: number;
  updatedAtMs: number;
};

export type ExecutionBindingRegisterInput = {
  workspaceId: string;
  parentThreadId: string;
  collabToolCallId: string;
  activePlanRevision: number;
  approvedPlan: ShadowApprovedPlanRef;
  expected: ShadowExpectedBinding;
  provider: ShadowProviderContext;
  registeredAtMs: number;
  expiresAtMs: number;
};

export type ExecutionBindingObserveInput = {
  workspaceId: string;
  parentThreadId: string;
  collabToolCallId: string;
  senderThreadId: string;
  receiverThreadIds: string[];
  actual: ShadowActualBinding;
  observedAtMs: number;
};

export type ExecutionBindingQuery = {
  workspaceId: string;
  parentThreadId: string;
  collabToolCallId?: string | null;
};

export type ShadowBindingContext = {
  approvedPlan: ShadowApprovedPlanRef | null;
  expected: ShadowExpectedBinding | null;
  actual: ShadowActualBinding | null;
};

export type ShadowRouteRequest = {
  task: ShadowTaskSignals;
  provider: ShadowProviderContext;
  runtime: ShadowRuntimeState;
  coordination: ShadowCoordinationContext | null;
  binding?: ShadowBindingContext | null;
};

export type ShadowRouteRecommendation =
  | "direct"
  | "delegate"
  | "review"
  | "decision-gate";

export type ShadowRouteReasonCode =
  | "low_complexity"
  | "low_risk"
  | "coordination_cost_exceeds_benefit"
  | "complex_task"
  | "parallelizable"
  | "delegation_benefit_exceeds_coordination_cost"
  | "independent_review_required"
  | "high_risk"
  | "user_decision_required"
  | "provider_mismatch"
  | "unknown_model"
  | "unverified_model"
  | "unsupported_effort"
  | "input_limit_exceeded"
  | "slot_limit_reached"
  | "depth_limit_reached"
  | "root_token_budget_exhausted"
  | "subtask_token_budget_exceeded"
  | "timeout_reached"
  | "retry_limit_reached"
  | "fallback_limit_reached"
  | "spawn_failed"
  | "coordination_group_missing"
  | "coordination_group_inactive"
  | "owner_missing"
  | "owner_inactive"
  | "owner_lease_inactive"
  | "owner_lease_expired"
  | "claim_missing"
  | "claim_invalid"
  | "claim_conflict"
  | "coordination_clear"
  | "model_capability_verified"
  | "binding_audit_failed";

export type ShadowBindingAuditStatus =
  | "matched"
  | "mismatch"
  | "missing_evidence"
  | "invalid_expected";

export type ShadowBindingAuditReasonCode =
  | "approved_plan_missing"
  | "approved_plan_invalid"
  | "expected_binding_missing"
  | "expected_binding_invalid"
  | "actual_binding_missing"
  | "expected_model_unknown"
  | "expected_model_unverified"
  | "expected_effort_unsupported"
  | "model_mismatch"
  | "effort_mismatch";

export type ShadowBindingAudit = {
  status: ShadowBindingAuditStatus;
  reasonCodes: ShadowBindingAuditReasonCode[];
  planId: string | null;
  planRevision: number | null;
  nodeId: string | null;
  taskFingerprint: string | null;
  expected: ShadowExpectedBinding | null;
  actual: ShadowActualBinding | null;
};

export type ShadowRouteAdvice = {
  recommendation: ShadowRouteRecommendation;
  reasonCodes: ShadowRouteReasonCode[];
  bindingAudit?: ShadowBindingAudit;
};

export type WorkflowCapabilityProfile = Record<
  WorkflowCapabilityName,
  WorkflowCapabilitySupport
>;

export type WorkflowSkillTrigger = {
  skillName: string;
  scope: WorkflowCapabilityScope;
  reason: "explicit" | "keyword" | "description";
  matchedValue: string;
  compatibility: "compatible" | "fallback" | "blocked";
  missingCapabilities: WorkflowCapabilityName[];
  fallback: string | null;
  priority: number;
};

export type WorkflowPreflightPreview = {
  mode: Exclude<WorkflowRuntimeMode, "off">;
  providerKind: CodexProviderKind;
  model: string | null;
  taskLength: number;
  capabilities: WorkflowCapabilityProfile;
  triggeredSkills: WorkflowSkillTrigger[];
  triggerSummary: string;
  fallbackSummary: string;
  validationSuggestions: string[];
  validationSummary: string;
};

export type WorkflowRuleCandidate = {
  path: string;
  kind: string;
  scope: "global" | "workspace" | "nested";
};

export type WorkflowKnowledgeCandidate = {
  knowledgeId?: string;
  path: string;
  title: string;
  score: number;
  matchedTerms: string[];
  contentFingerprint?: string;
  estimatedTokens?: number;
  freshness?: {
    state: "current" | "stale" | "unknown";
    reason: string;
    sourceProject: string;
    sourceRevision: string;
    sourceBranch: string;
    verifiedAt: string;
    implementationStatus: string;
  };
};

export type WorkflowRetrievalReceipt = {
  schemaVersion: number;
  queryFingerprint: string;
  projectId: string;
  indexRevision: string;
  selected: Array<{
    knowledgeId: string;
    path: string;
    contentFingerprint: string;
    estimatedTokens: number;
    freshness: WorkflowKnowledgeCandidate["freshness"];
  }>;
  omitted: Array<{
    knowledgeId: string;
    path: string;
    reason: string;
    detail: string;
  }>;
  cacheHit: boolean;
  estimatedInjectedTokens: number;
};

export type WorkflowImpactItem = {
  area: string;
  reason: string;
  validation: string[];
};

export type WorkflowContextSource = {
  phase: "stable" | "dynamic";
  kind: string;
  path: string;
  fingerprint: string;
  estimatedTokens: number;
  selected: boolean;
};

export type WorkflowContextPlan = {
  contextFingerprint: string;
  stablePrefixFingerprint: string;
  dynamicContextFingerprint: string;
  budgetTokens: number;
  mandatoryTokens: number;
  selectedTokens: number;
  truncated: boolean;
  sources: WorkflowContextSource[];
};

export type WorkflowValidationGate = {
  id: string;
  kind: "command" | "manual";
  instruction: string;
  status: "pending" | "passed" | "failed" | "skipped";
  sourceAreas: string[];
};

export type WorkflowCompletionPlan = {
  required: boolean;
  phase: "focused_validation" | "not_required";
  validations: WorkflowValidationGate[];
  changedDiffReview: {
    required: boolean;
    status: "pending" | "passed" | "failed" | "not_required";
    scope: "task-owned-changed-diff";
  };
  knowledgeCapture: {
    status: "evaluate" | "captured" | "not_required";
    category: "bug" | "decision" | "checkpoint";
    reason: string;
    submissionMode: "candidate-only-concurrency-safe";
  };
};

export type WorkflowHostPreflightPreview = {
  mode: Exclude<WorkflowRuntimeMode, "off">;
  providerKind: CodexProviderKind;
  model: string | null;
  taskLength: number;
  rules: WorkflowRuleCandidate[];
  knowledgeCandidates: WorkflowKnowledgeCandidate[];
  impacts: WorkflowImpactItem[];
  impactSummary: string;
  validationSuggestions: string[];
  sourceErrors: string[];
  knowledgeCacheHit: boolean;
  retrievalReceipt?: WorkflowRetrievalReceipt;
  contextPlan?: WorkflowContextPlan;
  completionPlan?: WorkflowCompletionPlan;
  workflowGate?: WorkflowGateAdapterStatus | null;
  contextFragments: WorkflowAdditionalContextEntry[];
};

export type KnowledgeAdapterStatus = {
  availability: "ready" | "degraded" | "unavailable";
  root: string | null;
  viewState: "current" | "stale" | "possibly_stale" | "missing" | null;
  viewRevision: string | null;
  ledgerIntegrity: string | null;
  runtimeIntegrity: string | null;
  diagnostic: string | null;
  usageVisibility: "actual" | "estimated" | "unknown";
};

export type KnowledgeQueryHit = {
  knowledge_id: string;
  title: string;
  path: string;
  status: string;
  excerpt: string;
  content_hash?: string;
  freshness?: {
    state: "current" | "stale" | "unknown";
    reason: string;
    source_project: string;
    source_revision: string;
    source_branch: string;
    verified_at: string;
  };
  citation: {
    knowledge_id: string;
    path: string;
    revision: string;
    verification: string;
  };
};

export type KnowledgeQueryResponse = {
  state: "ready" | "blocked";
  mode: "context_only";
  question: string;
  answer: null;
  provider_execution: "not_performed";
  context: {
    catalog_revision?: string;
    results: KnowledgeQueryHit[];
    omitted: Array<Record<string, unknown>>;
    warnings: Array<Record<string, unknown>>;
    retrieval_receipt?: Record<string, unknown>;
  };
  citations: KnowledgeQueryHit["citation"][];
  omitted: Array<Record<string, unknown>>;
  usage_visibility: "unknown";
};

export type KnowledgeIntakeCaptureRequest = {
  projectId: string;
  rawSnapshot: string;
  sourceSession: string;
  sourceTurn: string;
  risk: "low" | "medium" | "high" | "critical";
  sensitivity: "public" | "internal" | "private";
  idempotencyKey: string;
};

export type KnowledgeIntakeCaptureResponse = {
  intake_id: string;
  state: "captured";
  revision: number;
  content_hash: string;
};

export type KnowledgeTaskInitRequest = {
  projectId: string;
  scale: "S" | "M" | "L";
  risk: "low" | "medium" | "high" | "critical";
  authorizationScope: string;
  idempotencyKey: string;
  intakeId: string | null;
  workItemPath: string | null;
  capabilityId: string | null;
  moduleId: string | null;
};

export type KnowledgeTaskInitResponse = {
  task_id: string;
  state: "queued";
  revision: number;
};

export type WorkflowGateProjection = {
  schemaVersion: number;
  workflowId: string;
  projectId: string | null;
  workspace: string;
  taskId: string | null;
  workItemPath: string | null;
  status: string;
  stage: string;
  revision: number;
  planId: string | null;
  planRevision: number | null;
  planReviewStatus: string | null;
  implementationReviewStatus: string | null;
  tokenVisibility: string | null;
  creditVisibility: string | null;
  auditValid: boolean | null;
};

export type WorkflowGateAdapterStatus = {
  enforcementLevel: "gated" | "manual" | "unsupported";
  stateSource: "dev-knowledge-base";
  workflowId: string;
  projection: WorkflowGateProjection | null;
  diagnostic: string | null;
};

export type WorkflowAdditionalContextEntry = {
  sourceId: string;
  kind: "application" | "untrusted";
  value: string;
};

export type WorkflowAdditionalContext = Record<
  string,
  { kind: "application" | "untrusted"; value: string }
>;

export type WorkflowContextCompilation = {
  additionalContext: WorkflowAdditionalContext;
  selectedAgents: string[];
  includedSkills: string[];
  blockedSkills: string[];
  omittedSources: Array<{
    sourceId: string;
    reason: "empty" | "budget" | "duplicate_source" | "duplicate_content";
  }>;
  truncatedSources: string[];
  contextSummary: string;
};

export type WorkflowRuntimeDiagnostics = {
  lastUpdatedAtMs: number | null;
  lastMode: Exclude<WorkflowRuntimeMode, "off"> | null;
  triggerSummary: string | null;
  fallbackSummary: string | null;
  contextSummary: string | null;
  contextApplied: boolean | null;
  contextSourceCount: number;
  completionPhase: string | null;
  pendingValidationCount: number;
  changedDiffReviewStatus: string | null;
  knowledgeCaptureStatus: string | null;
  sourceErrors: string[];
  lastError: string | null;
};

export type AppOption = {
  id: string;
  name: string;
  description?: string;
  isAccessible: boolean;
  installUrl?: string | null;
  distributionChannel?: string | null;
};

export type CustomPromptOption = {
  name: string;
  path: string;
  description?: string;
  argumentHint?: string;
  content: string;
  scope?: "workspace" | "global";
};

export type BranchInfo = {
  name: string;
  lastCommit: number;
};

export type DebugEntry = {
  id: string;
  timestamp: number;
  source: "client" | "server" | "event" | "stderr" | "error";
  label: string;
  payload?: unknown;
};

export type TerminalStatus = "idle" | "connecting" | "ready" | "error";

export type DictationModelState = "missing" | "downloading" | "ready" | "error";

export type DictationDownloadProgress = {
  totalBytes?: number | null;
  downloadedBytes: number;
};

export type DictationModelStatus = {
  state: DictationModelState;
  modelId: string;
  progress?: DictationDownloadProgress | null;
  error?: string | null;
  path?: string | null;
};

export type DictationSessionState = "idle" | "listening" | "processing";

export type DictationEvent =
  | { type: "state"; state: DictationSessionState }
  | { type: "level"; value: number }
  | { type: "transcript"; text: string }
  | { type: "error"; message: string }
  | { type: "canceled"; message: string };

export type DictationTranscript = {
  id: string;
  text: string;
};
