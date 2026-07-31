import type { ReactNode } from "react";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import House from "lucide-react/dist/esm/icons/house";
import MessagesSquare from "lucide-react/dist/esm/icons/messages-square";
import TerminalSquare from "lucide-react/dist/esm/icons/terminal-square";
import { useI18n } from "@/features/i18n/I18nProvider";

type TabKey = "home" | "projects" | "codex" | "git" | "log";

type TabBarProps = {
  activeTab: TabKey;
  onSelect: (tab: TabKey) => void;
};

const tabs: { id: TabKey; labelKey: "nav.home" | "nav.chat" | "nav.git" | "nav.log"; icon: ReactNode }[] = [
  { id: "home", labelKey: "nav.home", icon: <House className="tabbar-icon" /> },
  { id: "codex", labelKey: "nav.chat", icon: <MessagesSquare className="tabbar-icon" /> },
  { id: "git", labelKey: "nav.git", icon: <GitBranch className="tabbar-icon" /> },
  { id: "log", labelKey: "nav.log", icon: <TerminalSquare className="tabbar-icon" /> },
];

export function TabBar({ activeTab, onSelect }: TabBarProps) {
  const { t } = useI18n();
  return (
    <nav className="tabbar" aria-label={t("nav.main")}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tabbar-item ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => onSelect(tab.id)}
          aria-current={activeTab === tab.id ? "page" : undefined}
        >
          {tab.icon}
          <span className="tabbar-label">{t(tab.labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}
