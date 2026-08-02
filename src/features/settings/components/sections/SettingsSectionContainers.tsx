import { SettingsCodexSection } from "./SettingsCodexSection";
import { SettingsProvidersSection } from "./SettingsProvidersSection";
import { SettingsComposerSection } from "./SettingsComposerSection";
import { SettingsDictationSection } from "./SettingsDictationSection";
import { SettingsDisplaySection } from "./SettingsDisplaySection";
import { SettingsEnvironmentsSection } from "./SettingsEnvironmentsSection";
import { SettingsFeaturesSection } from "./SettingsFeaturesSection";
import { SettingsGitSection } from "./SettingsGitSection";
import { SettingsOpenAppsSection } from "./SettingsOpenAppsSection";
import { SettingsProjectsSection } from "./SettingsProjectsSection";
import { SettingsServerSection } from "./SettingsServerSection";
import { SettingsSessionSection } from "./SettingsSessionSection";
import { SettingsShortcutsSection } from "./SettingsShortcutsSection";
import { SettingsAgentsSection } from "./SettingsAgentsSection";
import { SettingsWorkflowSection } from "./SettingsWorkflowSection";
import { SettingsAboutSection } from "./SettingsAboutSection";
import { SettingsCommandExecutionSection } from "./SettingsCommandExecutionSection";
import type { CodexSection } from "@settings/components/settingsTypes";
import type { SettingsViewOrchestration } from "@settings/hooks/useSettingsViewOrchestration";

type SettingsSectionContainersProps = {
  activeSection: CodexSection;
  orchestration: SettingsViewOrchestration;
};

export function SettingsSectionContainers({
  activeSection,
  orchestration,
}: SettingsSectionContainersProps) {
  if (activeSection === "projects") {
    return <SettingsProjectsSection {...orchestration.projectsSectionProps} />;
  }
  if (activeSection === "environments") {
    return <SettingsEnvironmentsSection {...orchestration.environmentsSectionProps} />;
  }
  if (activeSection === "session") {
    return <SettingsSessionSection {...orchestration.sessionSectionProps} />;
  }
  if (activeSection === "display") {
    return <SettingsDisplaySection {...orchestration.displaySectionProps} />;
  }
  if (activeSection === "about") {
    return <SettingsAboutSection {...orchestration.aboutSectionProps} />;
  }
  if (activeSection === "composer") {
    return <SettingsComposerSection {...orchestration.composerSectionProps} />;
  }
  if (activeSection === "dictation") {
    return <SettingsDictationSection {...orchestration.dictationSectionProps} />;
  }
  if (activeSection === "shortcuts") {
    return <SettingsShortcutsSection {...orchestration.shortcutsSectionProps} />;
  }
  if (activeSection === "open-apps") {
    return <SettingsOpenAppsSection {...orchestration.openAppsSectionProps} />;
  }
  if (activeSection === "git") {
    return <SettingsGitSection {...orchestration.gitSectionProps} />;
  }
  if (activeSection === "server") {
    return <SettingsServerSection {...orchestration.serverSectionProps} />;
  }
  if (activeSection === "agents") {
    return <SettingsAgentsSection {...orchestration.agentsSectionProps} />;
  }
  if (activeSection === "workflow") {
    return <SettingsWorkflowSection {...orchestration.workflowSectionProps} />;
  }
  if (activeSection === "command-execution") {
    return <SettingsCommandExecutionSection {...orchestration.commandExecutionSectionProps} />;
  }
  if (activeSection === "codex") {
    return <SettingsCodexSection {...orchestration.codexSectionProps} />;
  }
  if (activeSection === "providers") {
    return (
      <SettingsProvidersSection
        appSettings={orchestration.codexSectionProps.appSettings}
        onUpdateAppSettings={orchestration.codexSectionProps.onUpdateAppSettings}
        providerSessionDiagnostics={
          orchestration.codexSectionProps.providerSessionDiagnostics
        }
      />
    );
  }
  if (activeSection === "features") {
    return <SettingsFeaturesSection {...orchestration.featuresSectionProps} />;
  }
  return null;
}
