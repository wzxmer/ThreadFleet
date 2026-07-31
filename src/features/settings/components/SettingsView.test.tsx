// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppSettings, WorkspaceInfo } from "@/types";
import {
  connectWorkspace,
  getAppBuildType,
  getAgentsSettings,
  getCodexStatus,
  getConfigModel,
  getExperimentalFeatureList,
  getWindowsInstallerMigrationCapability,
  getProviderModels,
  isMobileRuntime,
  getModelList,
  listWorkspaces,
  previewWindowsInstallerRepair,
  applyWindowsInstallerRepair,
  rollbackWindowsInstallerRepair,
  windowsInstallerKind,
} from "@services/tauri";
import { DEFAULT_COMMIT_MESSAGE_PROMPT } from "@utils/commitMessagePrompt";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@services/tauri", async () => {
  const actual = await vi.importActual<typeof import("@services/tauri")>(
    "@services/tauri",
  );
  return {
    ...actual,
    connectWorkspace: vi.fn(),
    getAppBuildType: vi.fn(),
    getModelList: vi.fn(),
    getConfigModel: vi.fn(),
    getExperimentalFeatureList: vi.fn(),
    getWindowsInstallerMigrationCapability: vi.fn(),
    getProviderModels: vi.fn(),
    getAgentsSettings: vi.fn(),
    getCodexStatus: vi.fn(),
    isMobileRuntime: vi.fn(),
    listWorkspaces: vi.fn(),
    previewWindowsInstallerRepair: vi.fn(),
    applyWindowsInstallerRepair: vi.fn(),
    rollbackWindowsInstallerRepair: vi.fn(),
    windowsInstallerKind: vi.fn(),
  };
});

const connectWorkspaceMock = vi.mocked(connectWorkspace);
const getAppBuildTypeMock = vi.mocked(getAppBuildType);
const getConfigModelMock = vi.mocked(getConfigModel);
const getModelListMock = vi.mocked(getModelList);
const getExperimentalFeatureListMock = vi.mocked(getExperimentalFeatureList);
const getWindowsInstallerMigrationCapabilityMock = vi.mocked(
  getWindowsInstallerMigrationCapability,
);
const getProviderModelsMock = vi.mocked(getProviderModels);
const getAgentsSettingsMock = vi.mocked(getAgentsSettings);
const getCodexStatusMock = vi.mocked(getCodexStatus);
const isMobileRuntimeMock = vi.mocked(isMobileRuntime);
const listWorkspacesMock = vi.mocked(listWorkspaces);
const previewWindowsInstallerRepairMock = vi.mocked(previewWindowsInstallerRepair);
const applyWindowsInstallerRepairMock = vi.mocked(applyWindowsInstallerRepair);
const rollbackWindowsInstallerRepairMock = vi.mocked(rollbackWindowsInstallerRepair);
const windowsInstallerKindMock = vi.mocked(windowsInstallerKind);
const openUrlMock = vi.mocked(openUrl);
connectWorkspaceMock.mockResolvedValue(undefined);
getAppBuildTypeMock.mockResolvedValue("release");
getWindowsInstallerMigrationCapabilityMock.mockResolvedValue({
  platformSupported: true,
  runtimeEnabled: false,
  remoteExecutionAllowed: false,
});
getConfigModelMock.mockResolvedValue(null);
isMobileRuntimeMock.mockResolvedValue(false);
listWorkspacesMock.mockResolvedValue([]);
windowsInstallerKindMock.mockResolvedValue("msi");
previewWindowsInstallerRepairMock.mockResolvedValue({
  status: "blocked",
  fingerprint: null,
  currentVersion: "0.7.91",
  records: [],
  blockers: ["An unverifiable legacy shortcut (.lnk) exists."],
  plannedActions: [],
});
applyWindowsInstallerRepairMock.mockResolvedValue({ status: "unsupported" });
rollbackWindowsInstallerRepairMock.mockResolvedValue({ status: "unsupported" });
getAgentsSettingsMock.mockResolvedValue({
  configPath: "/Users/me/.codex/config.toml",
  multiAgentEnabled: false,
  maxThreads: 6,
  maxDepth: 1,
  agents: [],
});
getCodexStatusMock.mockResolvedValue({
  codexHomePath: "/Users/me/.codex",
  codexHomeSource: "默认路径",
  configPath: "/Users/me/.codex/config.toml",
  configExists: true,
  globalAgentsPath: "/Users/me/.codex/AGENTS.md",
  globalAgentsExists: true,
  codexSkillsPath: "/Users/me/.codex/skills",
  codexSkillsCount: 2,
  agentsSkillsPath: "/Users/me/.agents/skills",
  agentsSkillsCount: 3,
  model: "gpt-5-codex",
  modelError: null,
});

const baseSettings: AppSettings = {
  codexBin: null,
  codexHome: null,
  codexArgs: null,
  sessionSources: [],
  codexKeyProfiles: [],
  activeCodexKeyProfileId: null,
  preserveSessionLibraryOnProviderSwitch: true,
  syncProviderProfileToLocalConfig: false,
  backendMode: "local",
  remoteBackendProvider: "tcp",
  remoteBackendHost: "127.0.0.1:4732",
  remoteBackendToken: null,
  remoteBackends: [
    {
      id: "remote-default",
      name: "Primary remote",
      provider: "tcp",
      host: "127.0.0.1:4732",
      token: null,
    },
  ],
  activeRemoteBackendId: "remote-default",
  keepDaemonRunningAfterAppClose: false,
  defaultAccessMode: "current",
  reviewDeliveryMode: "inline",
  composerModelShortcut: null,
  composerAccessShortcut: null,
  composerReasoningShortcut: null,
  composerCollaborationShortcut: null,
  interruptShortcut: null,
  newAgentShortcut: null,
  newWorktreeAgentShortcut: null,
  newCloneAgentShortcut: null,
  archiveThreadShortcut: null,
  toggleProjectsSidebarShortcut: null,
  toggleGitSidebarShortcut: null,
  branchSwitcherShortcut: null,
  toggleDebugPanelShortcut: null,
  toggleTerminalShortcut: null,
  cycleAgentNextShortcut: null,
  cycleAgentPrevShortcut: null,
  cycleWorkspaceNextShortcut: null,
  cycleWorkspacePrevShortcut: null,
  lastComposerModelId: null,
  lastComposerReasoningEffort: null,
  uiScale: 1,
  appLanguage: "system",
  theme: "light",
  showCodexUsage: true,
  usageShowRemaining: false,
  showMessageFilePath: true,
  messageToolGroupsCollapsedByDefault: false,
  messageReadingStyle: "bubble",
  messageCanvasColor: "#f6f8fa",
  messageUserBubbleColor: "#ffffff",
  messageUserTextColor: "#0f1720",
  messageAssistantBubbleColor: "#ffffff",
  messageAssistantAccentColor: "#127e66",
  messageAssistantTextColor: "#233141",
  chatHistoryScrollbackItems: 200,
  threadTitleAutogenerationEnabled: false,
  autoArchiveThreadsEnabled: false,
  autoArchiveThreadsDays: 7,
  autoDeleteArchivedThreadsEnabled: false,
  autoDeleteArchivedThreadsDays: 30,
  automaticAppUpdateChecksEnabled: true,
  experimentalWindowsInstallerMigrationEnabled: false,
  uiFontFamily:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  uiLatinFontFamily:
    '"Segoe UI", Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  uiCjkFontFamily:
    '"PingFang SC", "Noto Sans SC Variable", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  uiFontSize: 14,
  uiFontWeight: 450,
  codeFontFamily:
    'ui-monospace, "Cascadia Mono", "Segoe UI Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  messageFontSize: 14,
  processFontSize: 12,
  messageFontWeight: 450,
  messageFontFamily:
    '"Segoe UI", "PingFang SC", "Noto Sans SC Variable", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
  codeFontSize: 13,
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
  composerFollowUpHintEnabled: true,
  pauseQueuedMessagesWhenResponseRequired: true,
  unifiedExecEnabled: true,
  experimentalAppsEnabled: false,
  personality: "friendly",
  dictationEnabled: false,
  dictationModelId: "base",
  dictationPreferredLanguage: null,
  dictationHoldKey: null,
  composerEditorPreset: "default",
  composerFenceExpandOnSpace: false,
  composerFenceExpandOnEnter: false,
  composerFenceLanguageTags: false,
  composerFenceWrapSelection: false,
  composerFenceAutoWrapPasteMultiline: false,
  composerFenceAutoWrapPasteCodeLike: false,
  composerListContinuation: false,
  composerCodeBlockCopyUseModifier: false,
  workspaceGroups: [],
  openAppTargets: [
    {
      id: "vscode",
      label: "VS Code",
      kind: "app",
      appName: "Visual Studio Code",
      command: null,
      args: [],
    },
  ],
  selectedOpenAppId: "vscode",
  globalWorktreesFolder: null,
};

const createDoctorResult = () => ({
  ok: true,
  codexBin: null,
  version: null,
  appServerOk: true,
  details: null,
  path: null,
  nodeOk: true,
  nodeVersion: null,
  nodeDetails: null,
});

const createUpdateResult = () => ({
  ok: true,
  method: "brew_formula" as const,
  package: "codex",
  beforeVersion: "codex 0.0.0",
  afterVersion: "codex 0.0.1",
  upgraded: true,
  output: null,
  details: null,
});

const renderDisplaySection = (
  options: {
    appSettings?: Partial<AppSettings>;
    reduceTransparency?: boolean;
    onUpdateAppSettings?: ComponentProps<typeof SettingsView>["onUpdateAppSettings"];
    onToggleTransparency?: ComponentProps<typeof SettingsView>["onToggleTransparency"];
  } = {},
) => {
  cleanup();
  const onUpdateAppSettings =
    options.onUpdateAppSettings ?? vi.fn().mockResolvedValue(undefined);
  const onToggleTransparency = options.onToggleTransparency ?? vi.fn();
  const props: ComponentProps<typeof SettingsView> = {
    reduceTransparency: options.reduceTransparency ?? false,
    onToggleTransparency,
    appSettings: { ...baseSettings, ...options.appSettings },
    openAppIconById: {},
    onUpdateAppSettings,
    workspaceGroups: [],
    groupedWorkspaces: [],
    ungroupedLabel: "Ungrouped",
    onClose: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onCreateWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRenameWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onMoveWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onDeleteWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onAssignWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRunDoctor: vi.fn().mockResolvedValue(createDoctorResult()),
    onUpdateWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    scaleShortcutTitle: "Scale shortcut",
    scaleShortcutText: "Use Command +/-",
    onTestNotificationSound: vi.fn(),
    onTestSystemNotification: vi.fn(),
    dictationModelStatus: null,
    onDownloadDictationModel: vi.fn(),
    onCancelDictationDownload: vi.fn(),
    onRemoveDictationModel: vi.fn(),
  };

  render(<SettingsView {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "显示与通知" }));

  return { onUpdateAppSettings, onToggleTransparency };
};

const renderComposerSection = (
  options: {
    appSettings?: Partial<AppSettings>;
    onUpdateAppSettings?: ComponentProps<typeof SettingsView>["onUpdateAppSettings"];
  } = {},
) => {
  cleanup();
  const onUpdateAppSettings =
    options.onUpdateAppSettings ?? vi.fn().mockResolvedValue(undefined);
  const props: ComponentProps<typeof SettingsView> = {
    reduceTransparency: false,
    onToggleTransparency: vi.fn(),
    appSettings: { ...baseSettings, ...options.appSettings },
    openAppIconById: {},
    onUpdateAppSettings,
    workspaceGroups: [],
    groupedWorkspaces: [],
    ungroupedLabel: "Ungrouped",
    onClose: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onCreateWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRenameWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onMoveWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onDeleteWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onAssignWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRunDoctor: vi.fn().mockResolvedValue(createDoctorResult()),
    onUpdateWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    scaleShortcutTitle: "Scale shortcut",
    scaleShortcutText: "Use Command +/-",
    onTestNotificationSound: vi.fn(),
    onTestSystemNotification: vi.fn(),
    dictationModelStatus: null,
    onDownloadDictationModel: vi.fn(),
    onCancelDictationDownload: vi.fn(),
    onRemoveDictationModel: vi.fn(),
    initialSection: "composer",
  };

  render(<SettingsView {...props} />);
  return { onUpdateAppSettings };
};

const renderCodexSection = (
  options: {
    appSettings?: Partial<AppSettings>;
    onUpdateAppSettings?: ComponentProps<typeof SettingsView>["onUpdateAppSettings"];
    initialSection?: ComponentProps<typeof SettingsView>["initialSection"];
    providerSessionDiagnostics?: ComponentProps<
      typeof SettingsView
    >["providerSessionDiagnostics"];
  } = {},
) => {
  cleanup();
  const onUpdateAppSettings =
    options.onUpdateAppSettings ?? vi.fn().mockResolvedValue(undefined);
  const props: ComponentProps<typeof SettingsView> = {
    reduceTransparency: false,
    onToggleTransparency: vi.fn(),
    appSettings: { ...baseSettings, ...options.appSettings },
    openAppIconById: {},
    onUpdateAppSettings,
    workspaceGroups: [],
    groupedWorkspaces: [],
    ungroupedLabel: "Ungrouped",
    onClose: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onCreateWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRenameWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onMoveWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onDeleteWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onAssignWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRunDoctor: vi.fn().mockResolvedValue(createDoctorResult()),
    onUpdateWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    scaleShortcutTitle: "Scale shortcut",
    scaleShortcutText: "Use Command +/-",
    onTestNotificationSound: vi.fn(),
    onTestSystemNotification: vi.fn(),
    dictationModelStatus: null,
    onDownloadDictationModel: vi.fn(),
    onCancelDictationDownload: vi.fn(),
    onRemoveDictationModel: vi.fn(),
    providerSessionDiagnostics: options.providerSessionDiagnostics,
    initialSection: options.initialSection ?? "codex",
  };

  const rendered = render(<SettingsView {...props} />);
  return { ...rendered, onUpdateAppSettings };
};

const renderAboutSection = (
  options: {
    appSettings?: Partial<AppSettings>;
    onUpdateAppSettings?: ComponentProps<typeof SettingsView>["onUpdateAppSettings"];
    onToggleAutomaticAppUpdateChecks?: ComponentProps<
      typeof SettingsView
    >["onToggleAutomaticAppUpdateChecks"];
    updater?: Partial<NonNullable<ComponentProps<typeof SettingsView>["updater"]>>;
  } = {},
) => {
  cleanup();
  const onUpdateAppSettings =
    options.onUpdateAppSettings ?? vi.fn().mockResolvedValue(undefined);
  const onToggleAutomaticAppUpdateChecks =
    options.onToggleAutomaticAppUpdateChecks ?? vi.fn();
  const updater = {
    enabled: true,
    state: { stage: "idle" as const },
    checkForUpdates: vi.fn(),
    startUpdate: vi.fn(),
    dismiss: vi.fn(),
    ...options.updater,
  };
  const props: ComponentProps<typeof SettingsView> = {
    reduceTransparency: false,
    onToggleTransparency: vi.fn(),
    appSettings: { ...baseSettings, ...options.appSettings },
    openAppIconById: {},
    onUpdateAppSettings,
    onToggleAutomaticAppUpdateChecks,
    updater,
    workspaceGroups: [],
    groupedWorkspaces: [],
    ungroupedLabel: "Ungrouped",
    onClose: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onCreateWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRenameWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onMoveWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onDeleteWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onAssignWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRunDoctor: vi.fn().mockResolvedValue(createDoctorResult()),
    onUpdateWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    scaleShortcutTitle: "Scale shortcut",
    scaleShortcutText: "Use Command +/-",
    onTestNotificationSound: vi.fn(),
    onTestSystemNotification: vi.fn(),
    dictationModelStatus: null,
    onDownloadDictationModel: vi.fn(),
    onCancelDictationDownload: vi.fn(),
    onRemoveDictationModel: vi.fn(),
  };

  render(<SettingsView {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "关于" }));

  return { onUpdateAppSettings, onToggleAutomaticAppUpdateChecks, updater };
};

const renderFeaturesSection = (
  options: {
    appSettings?: Partial<AppSettings>;
    onUpdateAppSettings?: ComponentProps<typeof SettingsView>["onUpdateAppSettings"];
    experimentalFeaturesResponse?: unknown;
  } = {},
) => {
  cleanup();
  const onUpdateAppSettings =
    options.onUpdateAppSettings ?? vi.fn().mockResolvedValue(undefined);
  getExperimentalFeatureListMock.mockResolvedValue(
    (options.experimentalFeaturesResponse as Record<string, unknown>) ?? {
      data: [
        {
          name: "steer",
          stage: "stable",
          enabled: true,
          defaultEnabled: true,
          displayName: "Steer mode",
          description:
            "Send messages immediately. Use Tab to queue while a run is active.",
          announcement: null,
        },
        {
          name: "unified_exec",
          stage: "stable",
          enabled: true,
          defaultEnabled: true,
          displayName: "Background terminal",
          description: "Run long-running terminal commands in the background.",
          announcement: null,
        },
      ],
      nextCursor: null,
    },
  );
  const props: ComponentProps<typeof SettingsView> = {
    reduceTransparency: false,
    onToggleTransparency: vi.fn(),
    appSettings: { ...baseSettings, ...options.appSettings },
    openAppIconById: {},
    onUpdateAppSettings,
    workspaceGroups: [],
    groupedWorkspaces: [
      {
        id: null,
        name: "Ungrouped",
        workspaces: [workspace({ id: "w-features", name: "Features Workspace", connected: true })],
      },
    ],
    ungroupedLabel: "Ungrouped",
    onClose: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onCreateWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRenameWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onMoveWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onDeleteWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onAssignWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRunDoctor: vi.fn().mockResolvedValue(createDoctorResult()),
    onUpdateWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    scaleShortcutTitle: "Scale shortcut",
    scaleShortcutText: "Use Command +/-",
    onTestNotificationSound: vi.fn(),
    onTestSystemNotification: vi.fn(),
    dictationModelStatus: null,
    onDownloadDictationModel: vi.fn(),
    onCancelDictationDownload: vi.fn(),
    onRemoveDictationModel: vi.fn(),
    initialSection: "features",
  };

  render(<SettingsView {...props} />);
  return { onUpdateAppSettings };
};

const workspace = (
  overrides: Omit<Partial<WorkspaceInfo>, "settings"> &
    Pick<WorkspaceInfo, "id" | "name"> & {
      settings?: Partial<WorkspaceInfo["settings"]>;
    },
): WorkspaceInfo => ({
  id: overrides.id,
  name: overrides.name,
  path: overrides.path ?? `/tmp/${overrides.id}`,
  connected: overrides.connected ?? false,
  kind: overrides.kind ?? "main",
  parentId: overrides.parentId ?? null,
  worktree: overrides.worktree ?? null,
  settings: {
    sidebarCollapsed: false,
    sortOrder: null,
    groupId: null,
    gitRoot: null,
    launchScript: null,
    launchScripts: null,
    worktreeSetupScript: null,
    ...overrides.settings,
  },
});

const renderEnvironmentsSection = (
  options: {
    appSettings?: Partial<AppSettings>;
    groupedWorkspaces?: ComponentProps<typeof SettingsView>["groupedWorkspaces"];
    onUpdateAppSettings?: ComponentProps<typeof SettingsView>["onUpdateAppSettings"];
    onUpdateWorkspaceSettings?: ComponentProps<typeof SettingsView>["onUpdateWorkspaceSettings"];
  } = {},
) => {
  cleanup();
  const onUpdateAppSettings =
    options.onUpdateAppSettings ?? vi.fn().mockResolvedValue(undefined);
  const onUpdateWorkspaceSettings =
    options.onUpdateWorkspaceSettings ?? vi.fn().mockResolvedValue(undefined);
  const defaultGroupedWorkspaces =
    options.groupedWorkspaces ??
    [
      {
        id: null,
        name: "Ungrouped",
        workspaces: [
          workspace({
            id: "w1",
            name: "Project One",
            settings: {
              sidebarCollapsed: false,
              worktreeSetupScript: "echo one",
            },
          }),
        ],
      },
    ];

  const buildProps = (
    nextOptions: {
      appSettings?: Partial<AppSettings>;
      groupedWorkspaces?: ComponentProps<typeof SettingsView>["groupedWorkspaces"];
    } = {},
  ): ComponentProps<typeof SettingsView> => ({
    reduceTransparency: false,
    onToggleTransparency: vi.fn(),
    appSettings: { ...baseSettings, ...options.appSettings, ...nextOptions.appSettings },
    openAppIconById: {},
    onUpdateAppSettings,
    workspaceGroups: [],
    groupedWorkspaces: nextOptions.groupedWorkspaces ?? defaultGroupedWorkspaces,
    ungroupedLabel: "Ungrouped",
    onClose: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onCreateWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRenameWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onMoveWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onDeleteWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onAssignWorkspaceGroup: vi.fn().mockResolvedValue(null),
    onRunDoctor: vi.fn().mockResolvedValue(createDoctorResult()),
    onUpdateWorkspaceSettings,
    scaleShortcutTitle: "Scale shortcut",
    scaleShortcutText: "Use Command +/-",
    onTestNotificationSound: vi.fn(),
    onTestSystemNotification: vi.fn(),
    dictationModelStatus: null,
    onDownloadDictationModel: vi.fn(),
    onCancelDictationDownload: vi.fn(),
    onRemoveDictationModel: vi.fn(),
    initialSection: "environments",
  });

  const renderResult = render(<SettingsView {...buildProps()} />);
  return {
    onUpdateAppSettings,
    onUpdateWorkspaceSettings,
    rerender: (
      nextOptions: {
        appSettings?: Partial<AppSettings>;
        groupedWorkspaces?: ComponentProps<typeof SettingsView>["groupedWorkspaces"];
      } = {},
    ) => renderResult.rerender(<SettingsView {...buildProps(nextOptions)} />),
  };
};

describe("SettingsView About", () => {
  it("shows localized update source text and opens the project repository", async () => {
    openUrlMock.mockClear();

    renderAboutSection();

    expect(
      screen.getByText(
        "启用后，ThreadFleet 启动时会检查新版本。默认使用 GitHub，发布者配置国内镜像后会自动回退。",
      ),
    ).toBeTruthy();
    expect(screen.getByText("项目仓库：")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "https://github.com/wzxmer/ThreadFleet",
      }),
    );

    expect(openUrlMock).toHaveBeenCalledWith(
      "https://github.com/wzxmer/ThreadFleet",
    );
  });
});

describe("SettingsView Display", () => {
  it("groups navigation by task domain without hiding settings", () => {
    renderDisplaySection();

    const workspaceGroup = screen.getByRole("region", { name: "工作区" });
    const experienceGroup = screen.getByRole("region", { name: "使用体验" });
    const developmentGroup = screen.getByRole("region", { name: "开发" });
    const applicationGroup = screen.getByRole("region", { name: "应用" });

    expect(within(workspaceGroup).getByRole("button", { name: "项目" })).toBeTruthy();
    expect(within(experienceGroup).getByRole("button", { name: "显示与通知" })).toBeTruthy();
    expect(within(developmentGroup).getByRole("button", { name: "命令执行" })).toBeTruthy();
    expect(within(applicationGroup).getByRole("button", { name: "关于" })).toBeTruthy();

    const navigationButtons = screen.getAllByRole("button").filter((button) =>
      button.classList.contains("settings-nav"),
    );
    expect(navigationButtons.every((button) => button.dataset.buttonElevation === "none")).toBe(true);
  });

  it("opens the session section from the settings navigation", async () => {
    renderDisplaySection();

    fireEvent.click(screen.getByRole("button", { name: "会话" }));

    expect(screen.getByText("管理会话生命周期、标题和历史加载。")).toBeTruthy();
    expect(screen.getByText("自动归档旧会话")).toBeTruthy();
  });

  it("updates the app language preference", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    fireEvent.click(screen.getByRole("button", { name: "语言" }));
    fireEvent.click(screen.getByRole("option", { name: "English" }));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ appLanguage: "en" }),
      );
    });
  });

  it("updates the theme selection", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const select = screen.getByLabelText("主题");
    fireEvent.change(select, { target: { value: "dark" } });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "dark" }),
      );
    });
  });

  it("toggles remaining limits display", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const row = screen
      .getByText("用量显示为剩余量")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (!row) {
      throw new Error("Expected remaining limits row");
    }
    const toggle = row.querySelector(
      "button.settings-toggle",
    ) as HTMLButtonElement | null;
    if (!toggle) {
      throw new Error("Expected remaining limits toggle");
    }
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ usageShowRemaining: true }),
      );
    });
  });

  it("toggles file path visibility in messages", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const row = screen
      .getByText("在消息中显示文件路径")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (!row) {
      throw new Error("Expected file path visibility row");
    }
    const toggle = row.querySelector(
      "button.settings-toggle",
    ) as HTMLButtonElement | null;
    if (!toggle) {
      throw new Error("Expected file path visibility toggle");
    }
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ showMessageFilePath: false }),
      );
    });
  });

  it("toggles split chat and diff center panes", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const row = screen
      .getByText("聊天和 Diff 分栏显示")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (!row) {
      throw new Error("Expected split center panes row");
    }
    const toggle = row.querySelector("button.settings-toggle") as HTMLButtonElement | null;
    if (!toggle) {
      throw new Error("Expected split center panes toggle");
    }
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ splitChatDiffView: true }),
      );
    });
  });

  it("toggles reduce transparency", async () => {
    const onToggleTransparency = vi.fn();
    renderDisplaySection({ onToggleTransparency, reduceTransparency: false });

    const row = screen
      .getByText("降低透明度")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (!row) {
      throw new Error("Expected reduce transparency row");
    }
    const toggle = row.querySelector(
      "button.settings-toggle",
    ) as HTMLButtonElement | null;
    if (!toggle) {
      throw new Error("Expected reduce transparency toggle");
    }
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(onToggleTransparency).toHaveBeenCalledWith(true);
    });
  });

  it("commits interface scale on blur and enter with clamping", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const scaleInput = screen.getByLabelText("界面缩放");

    fireEvent.change(scaleInput, { target: { value: "500%" } });
    fireEvent.blur(scaleInput);

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ uiScale: 3 }),
      );
    });

    fireEvent.change(scaleInput, { target: { value: "3%" } });
    fireEvent.keyDown(scaleInput, { key: "Enter" });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ uiScale: 0.1 }),
      );
    });
  });

  it("commits font family changes on blur and enter", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const uiLatinFontInput = screen.getByLabelText("自定义界面英文字体");
    fireEvent.change(uiLatinFontInput, {
      target: { value: "Avenir, sans-serif" },
    });
    fireEvent.blur(uiLatinFontInput);

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ uiLatinFontFamily: "Avenir, sans-serif" }),
      );
    });

    const uiCjkFontInput = screen.getByLabelText("自定义界面中文字体");
    fireEvent.change(uiCjkFontInput, {
      target: { value: '"Microsoft YaHei", sans-serif' },
    });
    fireEvent.keyDown(uiCjkFontInput, { key: "Enter" });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          uiCjkFontFamily: '"Microsoft YaHei", sans-serif',
        }),
      );
    });

    const codeFontInput = screen.getByLabelText("自定义代码字体");
    fireEvent.change(codeFontInput, {
      target: { value: "JetBrains Mono, monospace" },
    });
    fireEvent.keyDown(codeFontInput, { key: "Enter" });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ codeFontFamily: "JetBrains Mono, monospace" }),
      );
    });
  });

  it("resets font families to defaults", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const resetButtons = screen.getAllByRole("button", { name: "重置" });
    fireEvent.click(resetButtons[1]);
    fireEvent.click(resetButtons[2]);
    fireEvent.click(resetButtons[5]);

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          uiLatinFontFamily: expect.stringContaining("Segoe UI"),
        }),
      );
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          uiCjkFontFamily: expect.stringContaining("PingFang SC"),
        }),
      );
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          codeFontFamily: expect.stringContaining("ui-monospace"),
        }),
      );
    });
  });

  it("updates code font size from the slider", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    const slider = screen.getByLabelText("代码字号");
    fireEvent.change(slider, { target: { value: "14" } });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ codeFontSize: 14 }),
      );
    });
  });

  it("toggles notification sounds", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { notificationSoundsEnabled: false },
    });

    const row = screen
      .getByText("通知声音")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (!row) {
      throw new Error("Expected notification sounds row");
    }
    fireEvent.click(within(row).getByRole("button"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ notificationSoundsEnabled: true }),
      );
    });
  });

  it("toggles sub-agent system notifications", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: { subagentSystemNotificationsEnabled: false },
    });

    const row = screen
      .getByText("子 agent 通知")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (!row) {
      throw new Error("Expected sub-agent notifications row");
    }
    fireEvent.click(within(row).getByRole("button"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ subagentSystemNotificationsEnabled: true }),
      );
    });
  });
});

describe("SettingsView About", () => {
  it("toggles automatic app update checks", async () => {
    const onToggleAutomaticAppUpdateChecks = vi.fn();
    renderAboutSection({
      onToggleAutomaticAppUpdateChecks,
      appSettings: { automaticAppUpdateChecksEnabled: false },
    });

    const row = screen
      .getByText("自动检查应用更新")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (!row) {
      throw new Error("Expected automatic app update checks row");
    }
    fireEvent.click(within(row).getByRole("button"));

    await waitFor(() => {
      expect(onToggleAutomaticAppUpdateChecks).toHaveBeenCalledTimes(1);
    });
  });

  it("toggles sidebar Codex usage visibility", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({ onUpdateAppSettings });

    fireEvent.click(screen.getByRole("button", { name: "显示 Codex 用量" }));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ showCodexUsage: false }),
      );
    });
  });

  it("resets all font size categories together", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderDisplaySection({
      onUpdateAppSettings,
      appSettings: {
        uiFontSize: 17,
        messageFontSize: 19,
        processFontSize: 15,
        codeFontSize: 16,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "全部恢复默认" }));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          uiFontSize: 14,
          messageFontSize: 14,
          processFontSize: 12,
          codeFontSize: 13,
        }),
      );
    });
  });

  it("delegates app update checks to the shared updater owner", () => {
    const checkForUpdates = vi.fn();
    renderAboutSection({ updater: { checkForUpdates } });
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("shows the mixed-installer safety block from shared updater state", async () => {
    renderAboutSection({
      updater: {
        state: { stage: "error", errorCode: "mixedInstaller" },
      },
    });

    expect(
      await screen.findByText(/检测到 MSI 与 EXE 安装记录并存/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看修复" }));
    expect(
      await screen.findByRole("dialog", { name: "修复 Windows 安装器状态" }),
    ).toBeTruthy();
    expect(await screen.findByText(/无法验证的旧 \.lnk 快捷方式/)).toBeTruthy();
    expect(previewWindowsInstallerRepairMock).toHaveBeenCalledTimes(1);
  });

  it("renders and dismisses migration UI from the shared updater owner", async () => {
    const dismiss = vi.fn();
    renderAboutSection({
      updater: {
        state: {
          stage: "migrationReady",
          version: "9.9.9",
          migrationRecovery: true,
        },
        dismiss,
      },
    });

    const dialog = await screen.findByRole("dialog", {
      name: "迁移 Windows 安装器",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsView Environments", () => {
  it("shows the global worktrees root input", () => {
    renderEnvironmentsSection({
      appSettings: { globalWorktreesFolder: "I:/existing-worktrees" },
    });

    const input = screen.getByLabelText("全局 worktree 根目录");
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("I:/existing-worktrees");
    expect((input as HTMLInputElement).placeholder).toBe("/path/to/worktrees-root");
  });

  it("saves the global worktrees root through app settings", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    const onUpdateWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    renderEnvironmentsSection({
      onUpdateAppSettings,
      onUpdateWorkspaceSettings,
    });

    const input = screen.getByLabelText("全局 worktree 根目录");
    fireEvent.change(input, { target: { value: "I:/cm-worktrees" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          globalWorktreesFolder: "I:/cm-worktrees",
        }),
      );
    });
    expect(onUpdateWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("does not clear an existing global worktrees root when saving project-only changes", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    const onUpdateWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    renderEnvironmentsSection({
      appSettings: { globalWorktreesFolder: "I:/existing-worktrees" },
      onUpdateAppSettings,
      onUpdateWorkspaceSettings,
    });

    const textarea = screen.getByPlaceholderText("pnpm install");
    fireEvent.change(textarea, { target: { value: "echo updated" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateWorkspaceSettings).toHaveBeenCalledWith("w1", {
        worktreeSetupScript: "echo updated",
        worktreesFolder: null,
      });
    });
    expect(onUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("keeps the global worktrees root marked as saved after workspace save fails", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    const onUpdateWorkspaceSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to save workspace settings"))
      .mockResolvedValueOnce(undefined);
    renderEnvironmentsSection({
      appSettings: { globalWorktreesFolder: "I:/existing-worktrees" },
      onUpdateAppSettings,
      onUpdateWorkspaceSettings,
    });

    fireEvent.change(screen.getByLabelText("全局 worktree 根目录"), {
      target: { value: "I:/cm-worktrees" },
    });
    fireEvent.change(screen.getByPlaceholderText("pnpm install"), {
      target: { value: "echo updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByText("Failed to save workspace settings"),
    ).toBeTruthy();
    expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);
    expect(onUpdateWorkspaceSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateWorkspaceSettings).toHaveBeenCalledTimes(2);
    });
    expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the global worktrees root editable when there are no projects", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderEnvironmentsSection({
      groupedWorkspaces: [],
      onUpdateAppSettings,
    });

    expect(screen.getByText("暂无项目。")).toBeTruthy();
    const input = screen.getByLabelText("全局 worktree 根目录");
    fireEvent.change(input, { target: { value: "I:/cm-worktrees" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          globalWorktreesFolder: "I:/cm-worktrees",
        }),
      );
    });
  });

  it("keeps the no-project global worktrees root save state active until the request resolves", async () => {
    let resolveSave: (() => void) | null = null;
    const pendingSave = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onUpdateAppSettings = vi.fn().mockImplementation(() => pendingSave);
    renderEnvironmentsSection({
      groupedWorkspaces: [],
      onUpdateAppSettings,
    });

    fireEvent.change(screen.getByLabelText("全局 worktree 根目录"), {
      target: { value: "I:/cm-worktrees" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "保存中..." }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
    expect((screen.getByLabelText("全局 worktree 根目录") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "保存中..." }));
    expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave?.();
      await pendingSave;
    });

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  it("resyncs the global worktrees root baseline after dirty state clears", async () => {
    const { rerender } = renderEnvironmentsSection({
      groupedWorkspaces: [],
      appSettings: { globalWorktreesFolder: null },
    });

    const input = screen.getByLabelText("全局 worktree 根目录");
    fireEvent.change(input, { target: { value: "I:/typing" } });

    rerender({
      groupedWorkspaces: [],
      appSettings: { globalWorktreesFolder: "I:/loaded-from-settings" },
    });

    expect((screen.getByLabelText("全局 worktree 根目录") as HTMLInputElement).value).toBe(
      "I:/typing",
    );

    fireEvent.click(screen.getByRole("button", { name: "重置" }));

    await waitFor(() => {
      expect((screen.getByLabelText("全局 worktree 根目录") as HTMLInputElement).value).toBe(
        "I:/loaded-from-settings",
      );
    });
  });

  it("shows save errors for the global worktrees root when there are no projects", async () => {
    const onUpdateAppSettings = vi
      .fn()
      .mockRejectedValue(new Error("Failed to save global worktrees root"));
    renderEnvironmentsSection({
      groupedWorkspaces: [],
      onUpdateAppSettings,
    });

    const input = screen.getByLabelText("全局 worktree 根目录");
    fireEvent.change(input, { target: { value: "I:/cm-worktrees" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByText("Failed to save global worktrees root"),
    ).toBeTruthy();
  });

  it("keeps the new global worktrees root as saved when workspace settings fail afterward", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    const onUpdateWorkspaceSettings = vi
      .fn()
      .mockRejectedValue(new Error("Failed to save workspace settings"));
    renderEnvironmentsSection({
      appSettings: { globalWorktreesFolder: "I:/existing-worktrees" },
      onUpdateAppSettings,
      onUpdateWorkspaceSettings,
    });

    const input = screen.getByLabelText("全局 worktree 根目录");
    const textarea = screen.getByPlaceholderText("pnpm install");
    fireEvent.change(input, { target: { value: "I:/cm-worktrees" } });
    fireEvent.change(textarea, { target: { value: "echo updated" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByText("Failed to save workspace settings"),
    ).toBeTruthy();

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          globalWorktreesFolder: "I:/cm-worktrees",
        }),
      );
      expect(onUpdateWorkspaceSettings).toHaveBeenCalledWith("w1", {
        worktreeSetupScript: "echo updated",
        worktreesFolder: null,
      });
    });

    expect((input as HTMLInputElement).value).toBe("I:/cm-worktrees");

    onUpdateWorkspaceSettings.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateWorkspaceSettings).toHaveBeenCalledTimes(2);
    });
    expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);
  });

  it("saves the setup script for the selected project", async () => {
    const onUpdateWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    renderEnvironmentsSection({ onUpdateWorkspaceSettings });

    expect(
      screen.getByText("环境", { selector: ".settings-section-title" }),
    ).toBeTruthy();
    const textarea = screen.getByPlaceholderText("pnpm install");
    expect((textarea as HTMLTextAreaElement).value).toBe("echo one");

    fireEvent.change(textarea, { target: { value: "echo updated" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateWorkspaceSettings).toHaveBeenCalledWith("w1", {
        worktreeSetupScript: "echo updated",
        worktreesFolder: null,
      });
    });
  });

  it("normalizes whitespace-only scripts to null", async () => {
    const onUpdateWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    renderEnvironmentsSection({ onUpdateWorkspaceSettings });

    const textarea = screen.getByPlaceholderText("pnpm install");
    fireEvent.change(textarea, { target: { value: "   \n\t" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateWorkspaceSettings).toHaveBeenCalledWith("w1", {
        worktreeSetupScript: null,
        worktreesFolder: null,
      });
    });
  });

  it("copies the setup script to the clipboard", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    try {
      renderEnvironmentsSection();

      fireEvent.click(screen.getByRole("button", { name: "复制" }));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("echo one");
      });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, "clipboard", originalDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (navigator as any).clipboard;
      }
    }
  });
});

describe("SettingsView Codex section", () => {
  it("updates review mode in codex section", async () => {
    cleanup();
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={onUpdateAppSettings}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onRunCodexUpdate={vi.fn().mockResolvedValue(createUpdateResult())}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="codex"
      />,
    );

    fireEvent.change(screen.getByLabelText("Review 模式"), {
      target: { value: "detached" },
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ reviewDeliveryMode: "detached" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/Codex 配置已关联/)).toBeTruthy();
      expect(screen.getByText(/默认模型：gpt-5-codex/)).toBeTruthy();
      expect(screen.getByText(/Codex 2 个/)).toBeTruthy();
      expect(screen.getByText(/Agents 3 个/)).toBeTruthy();
    });
  });

  it("renders mobile daemon controls in local backend mode for TCP provider", async () => {
    cleanup();
    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={{
          ...baseSettings,
          backendMode: "local",
          remoteBackendProvider: "tcp",
        }}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="server"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "启动守护进程" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "停止守护进程" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "刷新状态" })).toBeTruthy();
      expect(screen.getByLabelText("远程后端地址")).toBeTruthy();
      expect(screen.getByLabelText("远程后端令牌")).toBeTruthy();
    });

    for (const name of [
      "启动守护进程",
      "停止守护进程",
      "刷新状态",
      "检测 Tailscale",
      "刷新守护进程命令",
      "使用建议地址",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button.classList.contains("ghost")).toBe(true);
      expect(button.classList.contains("settings-button-compact")).toBe(true);
    }
  });

  it("shows mobile-only server controls on iOS runtime", async () => {
    cleanup();
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "platform",
    );
    const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "userAgent",
    );
    const originalTouchPointsDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "maxTouchPoints",
    );

    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "iPhone",
    });
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    });
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: 5,
    });

    try {
      render(
        <SettingsView
          workspaceGroups={[]}
          groupedWorkspaces={[]}
          ungroupedLabel="Ungrouped"
          onClose={vi.fn()}
          onMoveWorkspace={vi.fn()}
          onDeleteWorkspace={vi.fn()}
          onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          reduceTransparency={false}
          onToggleTransparency={vi.fn()}
          appSettings={{
            ...baseSettings,
            backendMode: "local",
            remoteBackendProvider: "tcp",
          }}
          openAppIconById={{}}
          onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
          onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
          onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
          scaleShortcutTitle="Scale shortcut"
          scaleShortcutText="Use Command +/-"
          onTestNotificationSound={vi.fn()}
          onTestSystemNotification={vi.fn()}
          dictationModelStatus={null}
          onDownloadDictationModel={vi.fn()}
          onCancelDictationDownload={vi.fn()}
          onRemoveDictationModel={vi.fn()}
          initialSection="server"
        />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText("远程后端地址")).toBeTruthy();
        expect(screen.getByLabelText("远程后端令牌")).toBeTruthy();
        expect(screen.getByRole("button", { name: "连接并测试" })).toBeTruthy();
      });

      const connectButton = screen.getByRole("button", { name: "连接并测试" });
      expect(connectButton.classList.contains("ghost")).toBe(true);
      expect(connectButton.classList.contains("settings-button-compact")).toBe(true);

      expect(screen.queryByLabelText("后端模式")).toBeNull();
      expect(screen.queryByRole("button", { name: "启动守护进程" })).toBeNull();
      expect(screen.queryByRole("button", { name: "检测 Tailscale" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Start Runner" })).toBeNull();
      expect(screen.getByText(/从桌面端 ThreadFleet 获取 Tailscale 主机名和令牌/)).toBeTruthy();
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(window.navigator, "platform", originalPlatformDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "platform");
      }
      if (originalUserAgentDescriptor) {
        Object.defineProperty(window.navigator, "userAgent", originalUserAgentDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "userAgent");
      }
      if (originalTouchPointsDescriptor) {
        Object.defineProperty(
          window.navigator,
          "maxTouchPoints",
          originalTouchPointsDescriptor,
        );
      } else {
        Reflect.deleteProperty(window.navigator, "maxTouchPoints");
      }
    }
  });

  it("supports multiple saved remotes on iOS runtime", async () => {
    cleanup();
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "platform",
    );
    const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "userAgent",
    );
    const originalTouchPointsDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "maxTouchPoints",
    );

    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "iPhone",
    });
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    });
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: 5,
    });

    try {
      render(
        <SettingsView
          workspaceGroups={[]}
          groupedWorkspaces={[]}
          ungroupedLabel="Ungrouped"
          onClose={vi.fn()}
          onMoveWorkspace={vi.fn()}
          onDeleteWorkspace={vi.fn()}
          onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          reduceTransparency={false}
          onToggleTransparency={vi.fn()}
          appSettings={{
            ...baseSettings,
            remoteBackendProvider: "tcp",
            remoteBackendHost: "127.0.0.1:4732",
            remoteBackendToken: "token-a",
            remoteBackends: [
              {
                id: "remote-a",
                name: "Home Mac",
                provider: "tcp",
                host: "127.0.0.1:4732",
                token: "token-a",
              },
              {
                id: "remote-b",
                name: "Office Mac",
                provider: "tcp",
                host: "office-mac.tailnet.ts.net:4732",
                token: "token-b",
              },
            ],
            activeRemoteBackendId: "remote-a",
          }}
          openAppIconById={{}}
          onUpdateAppSettings={onUpdateAppSettings}
          onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
          onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
          scaleShortcutTitle="Scale shortcut"
          scaleShortcutText="Use Command +/-"
          onTestNotificationSound={vi.fn()}
          onTestSystemNotification={vi.fn()}
          dictationModelStatus={null}
          onDownloadDictationModel={vi.fn()}
          onCancelDictationDownload={vi.fn()}
          onRemoveDictationModel={vi.fn()}
          initialSection="server"
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole("list", { name: "已保存远程端" })).toBeTruthy();
        expect(screen.getByLabelText("远程端名称")).toBeTruthy();
      });
      const addRemoteButton = screen.getByRole("button", { name: "添加远程端" });
      expect(addRemoteButton.classList.contains("ghost")).toBe(true);
      expect(addRemoteButton.classList.contains("settings-button-compact")).toBe(true);
      expect(screen.getAllByText(/上次连接：\s*从未/).length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole("button", { name: "使用 Office Mac 远程端" }));

      await waitFor(() => {
        expect(onUpdateAppSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            activeRemoteBackendId: "remote-b",
            remoteBackendProvider: "tcp",
            remoteBackendHost: "office-mac.tailnet.ts.net:4732",
            remoteBackendToken: "token-b",
          }),
        );
      });

      onUpdateAppSettings.mockClear();
      fireEvent.change(screen.getByLabelText("远程端名称"), {
        target: { value: "Home Mac" },
      });
      fireEvent.blur(screen.getByLabelText("远程端名称"));

      await waitFor(() => {
        expect(
          screen.getAllByText('A remote named "Home Mac" already exists.').length,
        ).toBeGreaterThan(0);
      });

      onUpdateAppSettings.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "添加远程端" }));
      expect(screen.getByRole("dialog", { name: "添加远程端" })).toBeTruthy();
      expect(onUpdateAppSettings).toHaveBeenCalledTimes(0);

      fireEvent.click(screen.getByRole("button", { name: "关闭添加远程端弹窗" }));
      expect(screen.queryByRole("dialog", { name: "添加远程端" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "添加远程端" }));
      fireEvent.change(screen.getByLabelText("新远程端名称"), {
        target: { value: "Travel Mac" },
      });
      fireEvent.change(screen.getByLabelText("新远程端地址"), {
        target: { value: "travel-mac.tailnet.ts.net:4732" },
      });
      fireEvent.change(screen.getByLabelText("新远程端令牌"), {
        target: { value: "token-travel" },
      });
      fireEvent.click(screen.getByRole("button", { name: "连接并添加" }));

      await waitFor(() => {
        expect(onUpdateAppSettings).toHaveBeenCalledTimes(2);
      });
      const trialSettings = onUpdateAppSettings.mock.calls[0]?.[0] as AppSettings;
      const connectedSettings = onUpdateAppSettings.mock.calls[1]?.[0] as AppSettings;
      expect(trialSettings.remoteBackends).toHaveLength(3);
      expect(trialSettings.activeRemoteBackendId).toBeTruthy();
      expect(trialSettings.remoteBackendHost).toBe("travel-mac.tailnet.ts.net:4732");
      expect(trialSettings.remoteBackendToken).toBe("token-travel");
      expect(connectedSettings.remoteBackends).toHaveLength(3);
      const connectedEntry = connectedSettings.remoteBackends.find(
        (entry) => entry.id === connectedSettings.activeRemoteBackendId,
      );
      expect(connectedEntry?.lastConnectedAtMs).toEqual(expect.any(Number));
      expect(screen.queryByRole("dialog", { name: "添加远程端" })).toBeNull();
      expect(listWorkspacesMock).toHaveBeenCalled();

      onUpdateAppSettings.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "添加远程端" }));
      fireEvent.change(screen.getByLabelText("新远程端令牌"), {
        target: { value: "" },
      });
      fireEvent.click(screen.getByRole("button", { name: "连接并添加" }));

      await waitFor(() => {
        expect(screen.getByText("Remote backend token is required.")).toBeTruthy();
      });

      onUpdateAppSettings.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "下移 Home Mac" }));

      await waitFor(() => {
        expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);
        const nextSettings = onUpdateAppSettings.mock.calls[0]?.[0] as AppSettings;
        expect(nextSettings.remoteBackends[0]?.id).toBe("remote-b");
      });

      onUpdateAppSettings.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "删除 Office Mac" }));
      fireEvent.click(screen.getByRole("button", { name: "删除远程端" }));

      await waitFor(() => {
        expect(onUpdateAppSettings).toHaveBeenCalledTimes(1);
        const nextSettings = onUpdateAppSettings.mock.calls[0]?.[0] as AppSettings;
        expect(nextSettings.remoteBackends.length).toBeGreaterThanOrEqual(1);
      });
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(window.navigator, "platform", originalPlatformDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "platform");
      }
      if (originalUserAgentDescriptor) {
        Object.defineProperty(window.navigator, "userAgent", originalUserAgentDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "userAgent");
      }
      if (originalTouchPointsDescriptor) {
        Object.defineProperty(
          window.navigator,
          "maxTouchPoints",
          originalTouchPointsDescriptor,
        );
      } else {
        Reflect.deleteProperty(window.navigator, "maxTouchPoints");
      }
    }
  });

});

describe("SettingsView Codex defaults", () => {
  const createModelListResponse = (models: Array<Record<string, unknown>>) => ({
    result: { data: models },
  });

  it("explains that provider profiles only affect ThreadFleet-launched sessions", () => {
    renderCodexSection({ initialSection: "providers" });

    expect(screen.getByText("模型服务商配置")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /使用 Codex 默认配置/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("沿用本机 Codex 配置")).toBeTruthy();
    expect(
      screen.getAllByText(
        /只覆盖 ThreadFleet 新启动会话的 API 密钥、URL、模型和上下文，不修改 CODEX_HOME、sessions、MCP、agents 或全局 config\.toml/,
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText(/倍率/)).toBeNull();
  });

  it("persists explicit opt-in for experimental Windows installer migration", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderAboutSection({
      onUpdateAppSettings,
      appSettings: { experimentalWindowsInstallerMigrationEnabled: false },
    });

    const row = screen
      .getByText("实验性 Windows 安装器迁移")
      .closest(".settings-toggle-row") as HTMLElement | null;
    if (!row) throw new Error("Expected installer migration setting row");
    fireEvent.click(within(row).getByRole("button"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ experimentalWindowsInstallerMigrationEnabled: true }),
      );
    });
  });

  it("persists independent Provider continuity settings with keyboard-ready controls", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderCodexSection({ initialSection: "providers", onUpdateAppSettings });

    const continuityToggle = screen.getByRole("button", {
      name: "切换服务商时保留本机会话",
    });
    const configSyncToggle = screen.getByRole("button", {
      name: "同步服务商到本机 config.toml",
    });

    expect(continuityToggle.getAttribute("aria-pressed")).toBe("true");
    expect(configSyncToggle.getAttribute("aria-pressed")).toBe("false");
    continuityToggle.focus();
    expect(document.activeElement).toBe(continuityToggle);

    fireEvent.click(continuityToggle);
    await waitFor(() =>
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ preserveSessionLibraryOnProviderSwitch: false }),
      ),
    );

    fireEvent.click(configSyncToggle);
    await waitFor(() =>
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ syncProviderProfileToLocalConfig: true }),
      ),
    );
  });

  it("shows a redacted Provider session diagnostic without exposing the key", () => {
    const { container } = renderCodexSection({
      initialSection: "providers",
      appSettings: {
        codexKeyProfiles: [
          {
            id: "work",
            name: "Work",
            providerKind: "custom",
            keyEnvVar: "OPENAI_API_KEY",
            key: "diagnostic-secret",
            baseUrlEnvVar: "OPENAI_BASE_URL",
            baseUrl: "https://example.test/v1",
            model: "model-a",
            contextWindow: null,
            maxOutputTokens: null,
            useGateway: false,
            lastModelRefreshAtMs: null,
            cachedModels: [],
            groupName: "Work",
          },
        ],
        activeCodexKeyProfileId: "work",
      },
      providerSessionDiagnostics: {
        workspaceName: "Workspace A",
        providerName: "Work",
        providerKind: "custom",
        sessionSourceId: "source-a",
        runtimeGeneration: 4,
        listGeneration: 8,
        staleThreadCount: 2,
        staleReason: "snapshot-incomplete",
        fallback: "retained-previous-list",
      },
    });

    const diagnostics = container.querySelector(".settings-provider-diagnostics");
    expect(diagnostics?.textContent).toContain("Work (custom)");
    expect(diagnostics?.textContent).toContain("source-a");
    expect(diagnostics?.textContent).toContain("来源快照不完整");
    expect(diagnostics?.textContent).toContain("保留上一份列表");
    expect(diagnostics?.textContent).not.toContain("diagnostic-secret");
  });

  it("shows a generic error and keeps the previous value when a Provider setting save fails", async () => {
    const onUpdateAppSettings = vi
      .fn()
      .mockRejectedValue(new Error("diagnostic-secret backend detail"));
    renderCodexSection({ initialSection: "providers", onUpdateAppSettings });

    fireEvent.click(
      screen.getByRole("button", { name: "切换服务商时保留本机会话" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("设置保存失败，原值保持不变。");
    expect(alert.textContent).not.toContain("diagnostic-secret");
    expect(
      screen
        .getByRole("button", { name: "切换服务商时保留本机会话" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("renders provider profiles as compact URL buttons and switches the active profile", () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderCodexSection({
      initialSection: "providers",
      onUpdateAppSettings,
      appSettings: {
        codexKeyProfiles: [
          {
            id: "profile-a",
            name: "配置 A",
            providerKind: "custom",
            keyEnvVar: "OPENAI_API_KEY",
            key: "secret",
            baseUrlEnvVar: "OPENAI_BASE_URL",
            baseUrl: "https://api.example.com/v1",
            model: null,
            contextWindow: null,
            maxOutputTokens: null,
            useGateway: false,
            lastModelRefreshAtMs: null,
            cachedModels: [],
            groupName: "配置 A",
          },
        ],
      },
    });

    const profileButton = screen.getByRole("button", { name: /配置 A.*https:\/\/api\.example\.com\/v1/ });
    expect(screen.getByText("https://api.example.com/v1")).toBeTruthy();
    expect(profileButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(profileButton);

    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexKeyProfileId: "profile-a" }),
    );
  });

  it("fills the recommended base URL when selecting a known provider", () => {
    renderCodexSection({ initialSection: "providers" });

    fireEvent.change(screen.getByLabelText("服务商类型"), {
      target: { value: "deepseek" },
    });

    expect((screen.getByLabelText("服务商 Base URL") as HTMLInputElement).value).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  it("persists the selected provider usage protocol", () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderCodexSection({ initialSection: "providers", onUpdateAppSettings });

    fireEvent.change(screen.getByLabelText("模型服务商配置名称"), {
      target: { value: "New API" },
    });
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "secret" },
    });
    fireEvent.change(screen.getByLabelText("用量接口类型"), {
      target: { value: "new-api" },
    });
    fireEvent.change(screen.getByLabelText("New API Access Token"), {
      target: { value: "access-secret" },
    });
    const accessTokenField = screen.getByLabelText("New API Access Token");
    const accessTokenHelp = screen.getByText(
      "用于读取 New API 账户余额；API 密钥仍用于读取令牌消费。未填写或验证失败时回退显示令牌额度。",
    );
    expect(
      accessTokenHelp.closest(".settings-key-profile-secret")?.contains(accessTokenField),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "添加并启用" }));

    const calls = onUpdateAppSettings.mock.calls;
    const nextSettings = calls[calls.length - 1]?.[0] as AppSettings;
    expect(nextSettings.codexKeyProfiles[nextSettings.codexKeyProfiles.length - 1]).toMatchObject({
      name: "New API",
      usageProtocol: "new-api",
      newApiAccessToken: "access-secret",
    });
  });

  it("enables the compatibility gateway for opencode", () => {
    renderCodexSection({ initialSection: "providers" });

    fireEvent.change(screen.getByLabelText("服务商类型"), {
      target: { value: "opencode" },
    });

    expect((screen.getByLabelText("服务商 Base URL") as HTMLInputElement).value).toBe(
      "https://opencode.ai/zen/go/v1",
    );
    const gateway = screen.getByRole("checkbox", { name: "使用本地兼容网关" });
    expect((gateway as HTMLInputElement).checked).toBe(true);
    expect((gateway as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText("OpenCode Zen 必须选择明确模型，不能沿用全局 Codex 模型。"),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText(/倍率/)).toBeNull();
  });

  it("keeps cached provider models when refresh returns a partial list", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    getProviderModelsMock.mockResolvedValueOnce([
      { id: "model-a", name: "Model A refreshed", contextWindow: null },
    ]);
    renderCodexSection({
      initialSection: "providers",
      onUpdateAppSettings,
      appSettings: {
        codexKeyProfiles: [
          {
            id: "opencode",
            name: "OpenCode",
            providerKind: "opencode",
            keyEnvVar: "OPENAI_API_KEY",
            key: "secret",
            baseUrlEnvVar: "OPENAI_BASE_URL",
            baseUrl: "https://opencode.ai/zen/go/v1",
            model: "model-a",
            contextWindow: null,
            maxOutputTokens: null,
            useGateway: true,
            lastModelRefreshAtMs: 1,
            cachedModels: [
              { id: "model-a", name: "Model A", contextWindow: 128000 },
              { id: "model-b", name: "Model B", contextWindow: null },
            ],
            groupName: "OpenCode",
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /编辑 OpenCode/ }));
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await waitFor(() => expect(getProviderModelsMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => {
      const lastCall = onUpdateAppSettings.mock.calls[onUpdateAppSettings.mock.calls.length - 1];
      const nextSettings = lastCall?.[0] as AppSettings;
      expect(nextSettings.codexKeyProfiles[0]?.cachedModels).toEqual([
        { id: "model-a", name: "Model A refreshed", contextWindow: 128000 },
        { id: "model-b", name: "Model B", contextWindow: null },
      ]);
    });
  });

  it("saves provider thinking capability flags", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderCodexSection({
      initialSection: "providers",
      onUpdateAppSettings,
      appSettings: {
        codexKeyProfiles: [
          {
            id: "opencode",
            name: "OpenCode",
            providerKind: "opencode",
            keyEnvVar: "OPENAI_API_KEY",
            key: "secret",
            baseUrlEnvVar: "OPENAI_BASE_URL",
            baseUrl: "https://opencode.ai/zen/go/v1",
            model: "model-a",
            useGateway: true,
            supportsThinking: false,
            supportsReasoningEffort: false,
            cachedModels: [
              { id: "model-a", name: "Model A", contextWindow: null },
            ],
            groupName: "OpenCode",
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /编辑 OpenCode/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "支持思考模式" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "支持思考等级" }));
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => {
      const lastCall = onUpdateAppSettings.mock.calls[onUpdateAppSettings.mock.calls.length - 1];
      const nextSettings = lastCall?.[0] as AppSettings;
      expect(nextSettings.codexKeyProfiles[0]).toMatchObject({
        supportsThinking: true,
        supportsReasoningEffort: true,
      });
    });
  });

  it("shows every fetched provider model without locking the draft to the first result", async () => {
    const initialFetchCount = getProviderModelsMock.mock.calls.length;
    getProviderModelsMock.mockResolvedValueOnce([
      { id: "model-a", name: "Model A", contextWindow: null },
      { id: "model-b", name: "Model B", contextWindow: null },
      { id: "model-c", name: "Model C", contextWindow: null },
    ]);
    renderCodexSection({ initialSection: "providers" });

    fireEvent.change(screen.getByLabelText("服务商类型"), {
      target: { value: "deepseek" },
    });
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));

    await waitFor(() =>
      expect(getProviderModelsMock.mock.calls.length).toBe(initialFetchCount + 1),
    );
    const modelSelect = screen.getByLabelText("服务商模型") as HTMLSelectElement;
    expect(modelSelect.value).toBe("");
    expect(modelSelect.querySelectorAll("option")).toHaveLength(4);
    expect(modelSelect.textContent).toContain("Model A");
    expect(modelSelect.textContent).toContain("Model B");
    expect(modelSelect.textContent).toContain("Model C");

    fireEvent.change(screen.getByLabelText("服务商模型"), {
      target: { value: "model-b" },
    });
    expect(modelSelect.value).toBe("model-b");
  });

  it("clears provider drafts when deleting the profile being edited", () => {
    renderCodexSection({
      initialSection: "providers",
      appSettings: {
        codexKeyProfiles: [
          {
            id: "profile-a",
            name: "配置 A",
            providerKind: "custom",
            keyEnvVar: "OPENAI_API_KEY",
            key: "secret",
            baseUrlEnvVar: "OPENAI_BASE_URL",
            baseUrl: "https://api.example.com/v1",
            model: "model-a",
            contextWindow: null,
            maxOutputTokens: null,
            useGateway: true,
            lastModelRefreshAtMs: null,
            cachedModels: [],
            groupName: "配置 A",
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /编辑 配置 A/ }));
    expect((screen.getByLabelText("模型服务商配置名称") as HTMLInputElement).value).toBe(
      "配置 A",
    );

    fireEvent.click(screen.getByRole("button", { name: /删除 配置 A/ }));

    expect((screen.getByLabelText("模型服务商配置名称") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("服务商模型") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("uses the latest model and medium effort by default (no Default option)", async () => {
    cleanup();
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    getModelListMock.mockResolvedValue(
      createModelListResponse([
        {
          id: "gpt-4.1",
          model: "gpt-4.1",
          displayName: "GPT-4.1",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
        {
          id: "gpt-5.1",
          model: "gpt-5.1",
          displayName: "GPT-5.1",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ]),
    );

    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Ungrouped",
            workspaces: [workspace({ id: "w1", name: "Workspace", connected: true })],
          },
        ]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={onUpdateAppSettings}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onRunCodexUpdate={vi.fn().mockResolvedValue(createUpdateResult())}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="codex"
      />,
    );

    const modelSelect = screen.getByLabelText("模型") as HTMLSelectElement;
    const effortSelect = screen.getByLabelText(
      "推理强度",
    ) as HTMLSelectElement;

    await waitFor(() => {
      expect(getModelListMock).toHaveBeenCalledWith("w1");
      expect(modelSelect.value).toBe("gpt-5.1");
    });

    expect(within(modelSelect).queryByRole("option", { name: /default/i })).toBeNull();
    expect(within(effortSelect).queryByRole("option", { name: /default/i })).toBeNull();
    expect(effortSelect.value).toBe("medium");

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          lastComposerModelId: "gpt-5.1",
          lastComposerReasoningEffort: "medium",
        }),
      );
    });
  });

  it("updates model and effort when the user changes the selects", async () => {
    cleanup();
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    getModelListMock.mockResolvedValue(
      createModelListResponse([
        {
          id: "gpt-4.1",
          model: "gpt-4.1",
          displayName: "GPT-4.1",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
        {
          id: "gpt-5.1",
          model: "gpt-5.1",
          displayName: "GPT-5.1",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ]),
    );

    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Ungrouped",
            workspaces: [workspace({ id: "w1", name: "Workspace", connected: true })],
          },
        ]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={onUpdateAppSettings}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onRunCodexUpdate={vi.fn().mockResolvedValue(createUpdateResult())}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="codex"
      />,
    );

    const modelSelect = screen.getByLabelText("模型") as HTMLSelectElement;
    const effortSelect = screen.getByLabelText(
      "推理强度",
    ) as HTMLSelectElement;
    const tokenEfficiencySelect = screen.getByLabelText(
      "Token 效率",
    ) as HTMLSelectElement;
    const toolOutputTokenLimitInput = screen.getByLabelText(
      "单次工具输出预算",
    ) as HTMLInputElement;

    await waitFor(() => {
      expect(modelSelect.disabled).toBe(false);
      expect(modelSelect.value).toBe("gpt-5.1");
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ lastComposerModelId: "gpt-5.1" }),
      );
    });

    onUpdateAppSettings.mockClear();
    fireEvent.change(modelSelect, { target: { value: "gpt-4.1" } });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ lastComposerModelId: "gpt-4.1" }),
      );
    });

    onUpdateAppSettings.mockClear();
    fireEvent.change(effortSelect, { target: { value: "high" } });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ lastComposerReasoningEffort: "high" }),
      );
    });

    onUpdateAppSettings.mockClear();
    fireEvent.change(tokenEfficiencySelect, { target: { value: "balanced" } });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ tokenEfficiencyMode: "balanced" }),
      );
    });

    onUpdateAppSettings.mockClear();
    fireEvent.change(toolOutputTokenLimitInput, { target: { value: "8000" } });
    fireEvent.blur(toolOutputTokenLimitInput);

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ toolOutputTokenLimit: 8000 }),
      );
    });
  });
});

describe("SettingsView Features", () => {
  it("updates personality selection", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderFeaturesSection({ onUpdateAppSettings });

    fireEvent.change(screen.getByLabelText("个性"), {
      target: { value: "pragmatic" },
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ personality: "pragmatic" }),
      );
    });
  });

  it("hides steer mode dynamic feature row", async () => {
    renderFeaturesSection({
      appSettings: { steerEnabled: true },
    });

    await screen.findByText("统一执行工具");
    expect(screen.queryByText("Steer mode")).toBeNull();
  });

  it("hides steer mode when returned as an experimental feature", async () => {
    renderFeaturesSection({
      appSettings: { steerEnabled: true },
      experimentalFeaturesResponse: {
        data: [
          {
            name: "steer",
            stage: "underDevelopment",
            enabled: true,
            defaultEnabled: true,
            displayName: "Steer mode",
            description: "Legacy steer feature row.",
            announcement: null,
          },
          {
            name: "responses_websockets",
            stage: "underDevelopment",
            enabled: false,
            defaultEnabled: false,
            displayName: null,
            description: null,
            announcement: null,
          },
        ],
        nextCursor: null,
      },
    });

    await screen.findByText("默认使用 Responses API WebSocket 传输。");
    expect(screen.queryByText("Steer mode")).toBeNull();
  });

  it("toggles background terminal in stable features", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderFeaturesSection({
      onUpdateAppSettings,
      appSettings: { unifiedExecEnabled: true },
    });

    const terminalTitle = await screen.findByText("统一执行工具");
    const terminalRow = terminalTitle.closest(".settings-toggle-row");
    expect(terminalRow).not.toBeNull();

    const toggle = within(terminalRow as HTMLElement).getByRole("button");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ unifiedExecEnabled: false }),
      );
    });
  });

  it("localizes dynamic feature labels and descriptions", async () => {
    renderFeaturesSection({
      experimentalFeaturesResponse: {
        data: [
          {
            name: "unified_exec",
            stage: "stable",
            enabled: true,
            defaultEnabled: true,
            displayName: "Background terminal",
            description: "Run long-running terminal commands in the background.",
            announcement: null,
          },
          {
            name: "unknown_preview_flag",
            stage: "underDevelopment",
            enabled: false,
            defaultEnabled: false,
            displayName: "Unknown preview",
            description: "Remote English description.",
            announcement: null,
          },
        ],
        nextCursor: null,
      },
    });

    expect(await screen.findByText("统一执行工具")).toBeTruthy();
    expect(screen.getByText("使用单一 PTY 执行工具。")).toBeTruthy();
    expect(screen.getByText("Unknown preview")).toBeTruthy();
    expect(screen.getByText("Remote English description.")).toBeTruthy();
    expect(screen.queryByText("Background terminal")).toBeNull();
    expect(screen.queryByText("Run long-running terminal commands in the background.")).toBeNull();
  });

  it("shows fallback description when Codex omits feature description", async () => {
    renderFeaturesSection({
      experimentalFeaturesResponse: {
        data: [
          {
            name: "responses_websockets",
            stage: "underDevelopment",
            enabled: false,
            defaultEnabled: false,
            displayName: null,
            description: null,
            announcement: null,
          },
        ],
        nextCursor: null,
      },
    });

    await screen.findByText("默认使用 Responses API WebSocket 传输。");
  });
});

describe("SettingsView Composer", () => {
  it("toggles follow-up hint visibility", async () => {
    const onUpdateAppSettings = vi.fn().mockResolvedValue(undefined);
    renderComposerSection({
      onUpdateAppSettings,
      appSettings: {
        composerFollowUpHintEnabled: true,
      },
    });

    const hintTitle = await screen.findByText("处理中显示追问提示");
    const hintRow = hintTitle.closest(".settings-toggle-row");
    expect(hintRow).not.toBeNull();
    fireEvent.click(within(hintRow as HTMLElement).getByRole("button"));

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ composerFollowUpHintEnabled: false }),
      );
    });
  });

});

describe("SettingsView mobile layout", () => {
  it("uses a master/detail flow on narrow mobile widths", async () => {
    cleanup();
    const originalMatchMedia = window.matchMedia;
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "platform",
    );
    const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "userAgent",
    );
    const originalTouchPointsDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "maxTouchPoints",
    );

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width: 720px"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "iPhone",
    });
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    });
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: 5,
    });

    try {
      const rendered = render(
        <SettingsView
          workspaceGroups={[]}
          groupedWorkspaces={[]}
          ungroupedLabel="Ungrouped"
          onClose={vi.fn()}
          onMoveWorkspace={vi.fn()}
          onDeleteWorkspace={vi.fn()}
          onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
          reduceTransparency={false}
          onToggleTransparency={vi.fn()}
          appSettings={baseSettings}
          openAppIconById={{}}
          onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
          onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
          onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
          scaleShortcutTitle="Scale shortcut"
          scaleShortcutText="Use Command +/-"
          onTestNotificationSound={vi.fn()}
          onTestSystemNotification={vi.fn()}
          dictationModelStatus={null}
          onDownloadDictationModel={vi.fn()}
          onCancelDictationDownload={vi.fn()}
          onRemoveDictationModel={vi.fn()}
        />,
      );

      expect(
        within(rendered.container).queryByText("Sections"),
      ).toBeNull();
      expect(
        rendered.container.querySelectorAll(".ds-panel-nav-item-disclosure")
          .length,
      ).toBeGreaterThan(0);

      fireEvent.click(
        within(rendered.container).getByRole("button", {
          name: "显示与通知",
        }),
      );

      await waitFor(() => {
        expect(
          within(rendered.container).getByRole("button", {
            name: "返回设置分类",
          }),
        ).toBeTruthy();
        expect(
          within(rendered.container).getByText("显示与通知", {
            selector: ".settings-mobile-detail-title",
          }),
        ).toBeTruthy();
      });

      fireEvent.click(
        within(rendered.container).getByRole("button", {
          name: "返回设置分类",
        }),
      );

      await waitFor(() => {
        expect(within(rendered.container).queryByText("Sections")).toBeNull();
      });
    } finally {
      if (originalMatchMedia) {
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          writable: true,
          value: originalMatchMedia,
        });
      } else {
        Reflect.deleteProperty(window, "matchMedia");
      }
      if (originalPlatformDescriptor) {
        Object.defineProperty(window.navigator, "platform", originalPlatformDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "platform");
      }
      if (originalUserAgentDescriptor) {
        Object.defineProperty(window.navigator, "userAgent", originalUserAgentDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "userAgent");
      }
      if (originalTouchPointsDescriptor) {
        Object.defineProperty(
          window.navigator,
          "maxTouchPoints",
          originalTouchPointsDescriptor,
        );
      } else {
        Reflect.deleteProperty(window.navigator, "maxTouchPoints");
      }
    }
  });
});

describe("SettingsView Shortcuts", () => {
  it("closes on Cmd+W", async () => {
    const onClose = vi.fn();
    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={onClose}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
      />,
    );

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={onClose}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
      />,
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("closes when clicking the modal backdrop", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={onClose}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
      />,
    );

    const backdrop = container.querySelector(".ds-modal-backdrop");
    expect(backdrop).toBeTruthy();
    if (!backdrop) {
      throw new Error("Expected settings modal backdrop");
    }

    await act(async () => {
      fireEvent.click(backdrop);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("filters shortcuts by search query", async () => {
    render(
      <SettingsView
        workspaceGroups={[]}
        groupedWorkspaces={[]}
        ungroupedLabel="Ungrouped"
        onClose={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreateWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onRenameWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onMoveWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onDeleteWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        onAssignWorkspaceGroup={vi.fn().mockResolvedValue(null)}
        reduceTransparency={false}
        onToggleTransparency={vi.fn()}
        appSettings={baseSettings}
        openAppIconById={{}}
        onUpdateAppSettings={vi.fn().mockResolvedValue(undefined)}
        onRunDoctor={vi.fn().mockResolvedValue(createDoctorResult())}
        onUpdateWorkspaceSettings={vi.fn().mockResolvedValue(undefined)}
        scaleShortcutTitle="Scale shortcut"
        scaleShortcutText="Use Command +/-"
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
        dictationModelStatus={null}
        onDownloadDictationModel={vi.fn()}
        onCancelDictationDownload={vi.fn()}
        onRemoveDictationModel={vi.fn()}
        initialSection="shortcuts"
      />,
    );

    const searchInput = screen.getByLabelText("搜索快捷键");
    expect(screen.getByText("切换终端面板")).toBeTruthy();
    expect(screen.getByText("切换模型")).toBeTruthy();

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "导航" } });
    });
    await waitFor(() => {
      expect(screen.getByText("下一个项目")).toBeTruthy();
      expect(screen.queryByText("切换终端面板")).toBeNull();
    });

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "侧栏" } });
    });
    await waitFor(() => {
      expect(screen.getByText("切换项目侧栏")).toBeTruthy();
      expect(screen.queryByText("下一个项目")).toBeNull();
    });

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "新快捷键" } });
    });
    await waitFor(() => {
      expect(screen.getByText("切换模型")).toBeTruthy();
      expect(screen.queryByText("切换终端面板")).toBeNull();
    });

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "no-such-shortcut" } });
    });
    await waitFor(() => {
      expect(screen.getByText("没有匹配的快捷键：“no-such-shortcut”")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清除" }));
    });
    await waitFor(() => {
      expect(screen.getByText("切换终端面板")).toBeTruthy();
      expect(screen.queryByText("没有匹配的快捷键：“no-such-shortcut”")).toBeNull();
    });
  });
});
