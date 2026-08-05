import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import X from "lucide-react/dist/esm/icons/x";
import type { ReactNode } from "react";
import type {
  AppSettings,
  CodexDoctorResult,
  CodexUpdateResult,
  DictationModelStatus,
  WorkspaceSettings,
  WorkspaceGroup,
  WorkspaceInfo,
} from "@/types";
import { useSettingsViewCloseShortcuts } from "@settings/hooks/useSettingsViewCloseShortcuts";
import { useSettingsViewNavigation } from "@settings/hooks/useSettingsViewNavigation";
import { useSettingsViewOrchestration } from "@settings/hooks/useSettingsViewOrchestration";
import { ModalShell } from "@/features/design-system/components/modal/ModalShell";
import { useI18n } from "@/features/i18n/I18nProvider";
import { SETTINGS_SECTION_LABEL_KEYS } from "@/features/i18n/settingsSectionLabels";
import { SettingsNav } from "./SettingsNav";
import type { CodexSection } from "./settingsTypes";
import { SettingsSectionContainers } from "./sections/SettingsSectionContainers";
import type { SettingsWorkflowSectionProps } from "./sections/SettingsWorkflowSection";
import type { ProviderSessionDiagnostics } from "@settings/utils/providerSessionDiagnostics";
import type { UpdateState } from "@/features/update/hooks/useUpdater";
import type { WindowsUiUpdaterState } from "@/features/update/hooks/useWindowsUiUpdater";

export type SettingsUpdaterControls = {
  enabled: boolean;
  state: UpdateState;
  checkForUpdates: () => void;
  startUpdate: () => void;
  dismiss: () => void;
};

export type SettingsWindowsUiUpdaterControls = {
  enabled: boolean;
  state: WindowsUiUpdaterState;
  checkForUpdates: () => void;
  startInstall: () => void;
  dismiss: () => void;
};

export type SettingsViewProps = {
  workspaceGroups: WorkspaceGroup[];
  groupedWorkspaces: Array<{
    id: string | null;
    name: string;
    workspaces: WorkspaceInfo[];
  }>;
  ungroupedLabel: string;
  onClose: () => void;
  onMoveWorkspace: (id: string, direction: "up" | "down") => void;
  onDeleteWorkspace: (id: string) => void;
  onCreateWorkspaceGroup: (name: string) => Promise<WorkspaceGroup | null>;
  onRenameWorkspaceGroup: (id: string, name: string) => Promise<boolean | null>;
  onMoveWorkspaceGroup: (id: string, direction: "up" | "down") => Promise<boolean | null>;
  onDeleteWorkspaceGroup: (id: string) => Promise<boolean | null>;
  onAssignWorkspaceGroup: (
    workspaceId: string,
    groupId: string | null,
  ) => Promise<boolean | null>;
  reduceTransparency: boolean;
  onToggleTransparency: (value: boolean) => void;
  appSettings: AppSettings;
  openAppIconById: Record<string, string>;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  onToggleAutomaticAppUpdateChecks?: () => void;
  updater?: SettingsUpdaterControls;
  windowsUiUpdater?: SettingsWindowsUiUpdaterControls;
  onRunDoctor: (
    codexBin: string | null,
    codexArgs: string | null,
  ) => Promise<CodexDoctorResult>;
  onRunCodexUpdate?: (
    codexBin: string | null,
    codexArgs: string | null,
  ) => Promise<CodexUpdateResult>;
  onUpdateWorkspaceSettings: (
    id: string,
    settings: Partial<WorkspaceSettings>,
  ) => Promise<void>;
  scaleShortcutTitle: string;
  scaleShortcutText: string;
  onTestNotificationSound: () => void;
  onTestSystemNotification: () => void;
  onMobileConnectSuccess?: () => Promise<void> | void;
  dictationModelStatus?: DictationModelStatus | null;
  onDownloadDictationModel?: () => void;
  onCancelDictationDownload?: () => void;
  onRemoveDictationModel?: () => void;
  workflowSectionProps?: Omit<
    SettingsWorkflowSectionProps,
    "appSettings" | "onUpdateAppSettings"
  >;
  providerSessionDiagnostics?: ProviderSessionDiagnostics | null;
  initialSection?: CodexSection;
  variant?: "modal" | "surface";
};

export function SettingsView({
  workspaceGroups,
  groupedWorkspaces,
  ungroupedLabel,
  onClose,
  onMoveWorkspace,
  onDeleteWorkspace,
  onCreateWorkspaceGroup,
  onRenameWorkspaceGroup,
  onMoveWorkspaceGroup,
  onDeleteWorkspaceGroup,
  onAssignWorkspaceGroup,
  reduceTransparency,
  onToggleTransparency,
  appSettings,
  openAppIconById,
  onUpdateAppSettings,
  onToggleAutomaticAppUpdateChecks,
  updater,
  windowsUiUpdater,
  onRunDoctor,
  onRunCodexUpdate,
  onUpdateWorkspaceSettings,
  scaleShortcutTitle,
  scaleShortcutText,
  onTestNotificationSound,
  onTestSystemNotification,
  onMobileConnectSuccess,
  dictationModelStatus,
  onDownloadDictationModel,
  onCancelDictationDownload,
  onRemoveDictationModel,
  workflowSectionProps,
  providerSessionDiagnostics,
  initialSection,
  variant = "modal",
}: SettingsViewProps) {
  const { t } = useI18n();
  const resolvedWorkflowSectionProps = workflowSectionProps ?? {
    workspaceName: null,
    providerKind: "openai" as const,
    model: null,
    skills: [],
    agents: [],
    registryFingerprint: null,
    registryErrors: [],
    registryCacheHit: false,
    registryRefreshing: false,
    registryRefreshError: null,
    registryLastRefreshAtMs: null,
    diagnostics: {
      lastUpdatedAtMs: null,
      lastMode: null,
      triggerSummary: null,
      fallbackSummary: null,
      contextSummary: null,
      contextApplied: null,
      contextSourceCount: 0,
      completionPhase: null,
      pendingValidationCount: 0,
      changedDiffReviewStatus: null,
      knowledgeCaptureStatus: null,
      sourceErrors: [],
      lastError: null,
    },
    onRefreshRegistry: async () => undefined,
  };
  const {
    activeSection,
    showMobileDetail,
    setShowMobileDetail,
    useMobileMasterDetail,
    handleSelectSection,
  } = useSettingsViewNavigation({ initialSection });

  const orchestration = useSettingsViewOrchestration({
    workspaceGroups,
    groupedWorkspaces,
    ungroupedLabel,
    reduceTransparency,
    onToggleTransparency,
    appSettings,
    openAppIconById,
    onUpdateAppSettings,
    onToggleAutomaticAppUpdateChecks,
    updater,
    windowsUiUpdater,
    onRunDoctor,
    onRunCodexUpdate,
    onUpdateWorkspaceSettings,
    scaleShortcutTitle,
    scaleShortcutText,
    onTestNotificationSound,
    onTestSystemNotification,
    onMoveWorkspace,
    onDeleteWorkspace,
    onCreateWorkspaceGroup,
    onRenameWorkspaceGroup,
    onMoveWorkspaceGroup,
    onDeleteWorkspaceGroup,
    onAssignWorkspaceGroup,
    onMobileConnectSuccess,
    dictationModelStatus,
    onDownloadDictationModel,
    onCancelDictationDownload,
    onRemoveDictationModel,
    providerSessionDiagnostics,
    workflowSectionProps: resolvedWorkflowSectionProps,
  });

  useSettingsViewCloseShortcuts(onClose);

  const activeSectionLabel = t(SETTINGS_SECTION_LABEL_KEYS[activeSection]);
  const settingsBodyClassName = `settings-body${
    useMobileMasterDetail ? " settings-body-mobile-master-detail" : ""
  }${useMobileMasterDetail && showMobileDetail ? " is-detail-visible" : ""}`;

  const titleId = variant === "surface" ? "settings-surface-title" : "settings-modal-title";
  const settingsContent: ReactNode = (
    <>
      <div className="settings-titlebar">
        <div className="settings-title" id={titleId}>
          {t("settings.title")}
        </div>
        {variant === "modal" ? (
          <button
            type="button"
            className="ghost icon-button settings-close"
            onClick={onClose}
            aria-label={t("settings.close")}
          >
            <X aria-hidden />
          </button>
        ) : null}
      </div>
      <div className={settingsBodyClassName}>
        {(!useMobileMasterDetail || !showMobileDetail) && (
          <div className="settings-master">
            <SettingsNav
              activeSection={activeSection}
              onSelectSection={handleSelectSection}
              showDisclosure={useMobileMasterDetail}
            />
          </div>
        )}
        {(!useMobileMasterDetail || showMobileDetail) && (
          <div className="settings-detail">
            {useMobileMasterDetail && (
              <div className="settings-mobile-detail-header">
                <button
                  type="button"
                  className="settings-mobile-back"
                  onClick={() => setShowMobileDetail(false)}
                  aria-label={t("settings.backToCategories")}
                >
                  <ChevronLeft aria-hidden />
                  {t("settings.categories")}
                </button>
                <div className="settings-mobile-detail-title">{activeSectionLabel}</div>
              </div>
            )}
            <div className="settings-content">
              <div className="settings-content-inner">
                <SettingsSectionContainers
                  activeSection={activeSection}
                  orchestration={orchestration}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );

  if (variant === "surface") {
    return (
      <section
        className="settings-window settings-surface"
        aria-labelledby={titleId}
      >
        {settingsContent}
      </section>
    );
  }

  return (
    <ModalShell
      className="settings-overlay"
      cardClassName="settings-window"
      onBackdropClick={onClose}
      ariaLabelledBy={titleId}
    >
      {settingsContent}
    </ModalShell>
  );
}
