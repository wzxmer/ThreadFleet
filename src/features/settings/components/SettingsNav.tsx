import LayoutGrid from "lucide-react/dist/esm/icons/layout-grid";
import Archive from "lucide-react/dist/esm/icons/archive";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import Mic from "lucide-react/dist/esm/icons/mic";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import TerminalSquare from "lucide-react/dist/esm/icons/terminal-square";
import FileText from "lucide-react/dist/esm/icons/file-text";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Layers from "lucide-react/dist/esm/icons/layers";
import ServerCog from "lucide-react/dist/esm/icons/server-cog";
import Bot from "lucide-react/dist/esm/icons/bot";
import Workflow from "lucide-react/dist/esm/icons/workflow";
import KeyRound from "lucide-react/dist/esm/icons/key-round";
import Info from "lucide-react/dist/esm/icons/info";
import type { ComponentType } from "react";
import { PanelNavItem, PanelNavList } from "@/features/design-system/components/panel/PanelPrimitives";
import { useI18n } from "@/features/i18n/I18nProvider";
import { SETTINGS_SECTION_LABEL_KEYS } from "@/features/i18n/settingsSectionLabels";
import type { I18nKey } from "@/features/i18n/strings";
import type { CodexSection } from "./settingsTypes";

type SettingsNavProps = {
  activeSection: CodexSection;
  onSelectSection: (section: CodexSection) => void;
  showDisclosure?: boolean;
};

type SettingsNavItem = {
  section: CodexSection;
  Icon: ComponentType<{ "aria-hidden"?: boolean }>;
};

type SettingsNavGroup = {
  label: I18nKey;
  items: SettingsNavItem[];
};

const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "settings.navGroup.workspace",
    items: [
      { section: "projects", Icon: LayoutGrid },
      { section: "environments", Icon: Layers },
      { section: "session", Icon: Archive },
    ],
  },
  {
    label: "settings.navGroup.experience",
    items: [
      { section: "display", Icon: SlidersHorizontal },
      { section: "composer", Icon: FileText },
      { section: "dictation", Icon: Mic },
      { section: "shortcuts", Icon: Keyboard },
      { section: "open-apps", Icon: ExternalLink },
    ],
  },
  {
    label: "settings.navGroup.development",
    items: [
      { section: "git", Icon: GitBranch },
      { section: "server", Icon: ServerCog },
      { section: "agents", Icon: Bot },
      { section: "workflow", Icon: Workflow },
      { section: "command-execution", Icon: TerminalSquare },
      { section: "codex", Icon: TerminalSquare },
      { section: "providers", Icon: KeyRound },
    ],
  },
  {
    label: "settings.navGroup.application",
    items: [
      { section: "features", Icon: FlaskConical },
      { section: "about", Icon: Info },
    ],
  },
];

export function SettingsNav({
  activeSection,
  onSelectSection,
  showDisclosure = false,
}: SettingsNavProps) {
  const { t } = useI18n();
  return (
    <aside className="settings-sidebar">
      <PanelNavList className="settings-nav-list">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <section className="settings-nav-group" key={group.label} aria-label={t(group.label)}>
            <div className="settings-nav-group-label">{t(group.label)}</div>
            <div className="settings-nav-group-items">
              {group.items.map(({ section, Icon }) => (
                <PanelNavItem
                  className="settings-nav"
                  icon={<Icon aria-hidden />}
                  active={activeSection === section}
                  key={section}
                  showDisclosure={showDisclosure}
                  onClick={() => onSelectSection(section)}
                >
                  {t(SETTINGS_SECTION_LABEL_KEYS[section])}
                </PanelNavItem>
              ))}
            </div>
          </section>
        ))}
      </PanelNavList>
    </aside>
  );
}
