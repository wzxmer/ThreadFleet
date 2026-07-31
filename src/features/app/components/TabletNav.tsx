import type { ComponentType } from "react";
import Activity from "lucide-react/dist/esm/icons/activity";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import House from "lucide-react/dist/esm/icons/house";
import Library from "lucide-react/dist/esm/icons/library";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import Moon from "lucide-react/dist/esm/icons/moon";
import Settings from "lucide-react/dist/esm/icons/settings";
import Sun from "lucide-react/dist/esm/icons/sun";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import User from "lucide-react/dist/esm/icons/user";
import { useI18n } from "@/features/i18n/I18nProvider";
import { PopoverSurface } from "@/features/design-system/components/popover/PopoverPrimitives";
import { useMenuController } from "../hooks/useMenuController";
import type { AccountSnapshot, ThemePreference } from "@/types";
import { resolveNextThemePreference } from "@app/utils/themePreference";

type TabletNavTab = "home" | "projects" | "codex" | "git" | "log";
type RailIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

type TabletNavProps = {
  activeTab: TabletNavTab;
  onSelect: (tab: TabletNavTab) => void;
  onToggleGitPanel?: () => void;
  terminalActive: boolean;
  terminalDisabled: boolean;
  onToggleTerminal: () => void;
  libraryActive: boolean;
  onToggleLibrary: () => void;
  activityActive: boolean;
  onToggleActivity: () => void;
  accountActive: boolean;
  accountDisabled: boolean;
  accountInfo: AccountSnapshot | null;
  accountWorkspaceName: string | null;
  accountActionDisabled: boolean;
  onOpenAccount: () => void;
  theme: ThemePreference;
  onToggleTheme: () => void;
  settingsActive: boolean;
  onOpenSettings: () => void;
};

const tabs: Array<{
  id: Exclude<TabletNavTab, "log">;
  labelKey: "nav.home" | "nav.sessions" | "nav.git";
  icon: RailIcon;
}> = [
  { id: "home", labelKey: "nav.home", icon: House },
  { id: "codex", labelKey: "nav.sessions", icon: MessageSquare },
  { id: "git", labelKey: "nav.git", icon: GitBranch },
];

type RailButtonProps = {
  active: boolean;
  disabled?: boolean;
  icon: RailIcon;
  label: string;
  onClick: () => void;
};

function RailButton({ active, disabled, icon: Icon, label, onClick }: RailButtonProps) {
  return (
    <button
      type="button"
      className={`tablet-nav-item ds-tooltip-trigger${active ? " active" : ""}`}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      data-tooltip={label}
      data-tooltip-placement="right"
      disabled={disabled}
      data-button-elevation="none"
    >
      <Icon className="tablet-nav-icon" aria-hidden />
      <span className="tablet-nav-label">{label}</span>
    </button>
  );
}

export function TabletNav({
  activeTab,
  onSelect,
  onToggleGitPanel,
  terminalActive,
  terminalDisabled,
  onToggleTerminal,
  libraryActive,
  onToggleLibrary,
  activityActive,
  onToggleActivity,
  accountActive,
  accountDisabled,
  accountInfo,
  accountWorkspaceName,
  accountActionDisabled,
  onOpenAccount,
  theme,
  onToggleTheme,
  settingsActive,
  onOpenSettings,
}: TabletNavProps) {
  const { t } = useI18n();
  const accountMenu = useMenuController();
  const activeRailDestination:
    | TabletNavTab
    | "terminal"
    | "library"
    | "account"
    | "settings"
    | "activity" = settingsActive
    ? "settings"
    : accountActive || accountMenu.isOpen
      ? "account"
      : activityActive || activeTab === "log"
        ? "activity"
        : libraryActive
          ? "library"
          : terminalActive
            ? "terminal"
            : activeTab;
  const accountIdentifier = accountInfo?.email?.trim() || accountInfo?.planType?.trim() || "";
  const accountStatusLabel = accountActive
    ? t("sidebar.accountSigningIn")
    : accountIdentifier
      ? t("sidebar.accountSignedIn")
      : accountActionDisabled
        ? t("sidebar.accountUnavailable")
        : t("sidebar.accountSignedOut");
  const accountActionLabel = accountIdentifier
    ? t("sidebar.switchAccount")
    : t("sidebar.loginCodex");
  const nextTheme = resolveNextThemePreference(theme);
  const nextThemeLabel = t(
    nextTheme === "dark"
      ? "sidebar.themeDark"
      : "sidebar.themeLight",
  );
  return (
    <nav className="tablet-nav" aria-label={t("nav.main")}>
      <div className="tablet-nav-brand" aria-hidden>
        <img src="/app-icon.png" alt="" />
      </div>
      <div className="tablet-nav-group">
        {tabs.map(({ id, labelKey, icon }) => (
          <RailButton
            key={id}
            active={activeRailDestination === id}
            icon={icon}
            label={t(labelKey)}
            onClick={() => {
              accountMenu.close();
              if (id === "git" && onToggleGitPanel) {
                onToggleGitPanel();
                return;
              }
              onSelect(id);
            }}
          />
        ))}
        <RailButton
          active={activeRailDestination === "terminal"}
          disabled={terminalDisabled}
          icon={SquareTerminal}
          label={t("nav.terminal")}
          onClick={() => {
            accountMenu.close();
            onToggleTerminal();
          }}
        />
        <RailButton
          active={activeRailDestination === "library"}
          icon={Library}
          label={t("nav.library")}
          onClick={() => {
            accountMenu.close();
            onToggleLibrary();
          }}
        />
      </div>
      <div className="tablet-nav-spacer" />
      <div className="tablet-nav-group tablet-nav-bottom-group">
        <RailButton
          active={false}
          icon={nextTheme === "dark" ? Moon : Sun}
          label={nextThemeLabel}
          onClick={onToggleTheme}
        />
        <div className="tablet-nav-account-menu" ref={accountMenu.containerRef}>
          <RailButton
            active={activeRailDestination === "account"}
            disabled={accountDisabled}
            icon={User}
            label={t("sidebar.account")}
            onClick={accountMenu.toggle}
          />
          {accountMenu.isOpen && (
            <PopoverSurface className="tablet-nav-account-popover" role="dialog">
              <div className="tablet-nav-account-heading">{t("sidebar.accountStatus")}</div>
              <div className="tablet-nav-account-status">
                <span
                  className={`tablet-nav-account-status-dot${accountActive ? " is-busy" : accountIdentifier ? " is-signed-in" : ""}`}
                  aria-hidden
                />
                <span>{accountStatusLabel}</span>
              </div>
              {accountIdentifier ? (
                <div className="tablet-nav-account-value">{accountIdentifier}</div>
              ) : null}
              {accountWorkspaceName ? (
                <div className="tablet-nav-account-meta">
                  <span>{t("sidebar.accountWorkspace")}</span>
                  <strong>{accountWorkspaceName}</strong>
                </div>
              ) : null}
              <button
                type="button"
                className="tablet-nav-account-action"
                onClick={() => {
                  onOpenAccount();
                  if (!accountActionDisabled) {
                    accountMenu.close();
                  }
                }}
                disabled={accountActionDisabled}
                data-button-elevation="none"
              >
                {accountActionLabel}
              </button>
            </PopoverSurface>
          )}
        </div>
        <RailButton
          active={activeRailDestination === "settings"}
          icon={Settings}
          label={t("settings.title")}
          onClick={() => {
            accountMenu.close();
            onOpenSettings();
          }}
        />
        <RailButton
          active={activeRailDestination === "activity"}
          icon={Activity}
          label={t("nav.log")}
          onClick={() => {
            accountMenu.close();
            onToggleActivity();
          }}
        />
      </div>
    </nav>
  );
}
