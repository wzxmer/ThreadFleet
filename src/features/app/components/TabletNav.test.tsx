// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import { TabletNav } from "./TabletNav";

afterEach(cleanup);

function renderNav(overrides: Partial<Parameters<typeof TabletNav>[0]> = {}) {
  const props: Parameters<typeof TabletNav>[0] = {
    activeTab: "home",
    onSelect: vi.fn(),
    terminalActive: false,
    terminalDisabled: false,
    onToggleTerminal: vi.fn(),
    libraryActive: false,
    onToggleLibrary: vi.fn(),
    activityActive: false,
    onToggleActivity: vi.fn(),
    accountActive: false,
    accountDisabled: false,
    accountInfo: null,
    accountWorkspaceName: "CodexMonitor",
    accountActionDisabled: false,
    onOpenAccount: vi.fn(),
    theme: "dark",
    onToggleTheme: vi.fn(),
    settingsActive: false,
    onOpenSettings: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider preference="zh">
      <TabletNav {...props} />
    </I18nProvider>,
  );
  return props;
}

describe("TabletNav", () => {
  it("exposes the approved global destinations", () => {
    renderNav();

    ["首页", "会话", "Git", "终端", "会话管理", "亮色", "账号", "设置", "日志"].forEach(
      (label) => expect(screen.getByRole("button", { name: label })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "项目" })).toBeNull();
    expect(screen.getByRole("button", { name: "首页" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("routes destinations through their existing actions without starting account login from the rail icon", () => {
    const props = renderNav();

    fireEvent.click(screen.getByRole("button", { name: "会话" }));
    fireEvent.click(screen.getByRole("button", { name: "Git" }));
    fireEvent.click(screen.getByRole("button", { name: "终端" }));
    fireEvent.click(screen.getByRole("button", { name: "会话管理" }));
    fireEvent.click(screen.getByRole("button", { name: "账号" }));
    expect(screen.getByText("登录状态")).toBeTruthy();
    expect(props.onOpenAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "登录 Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "日志" }));

    expect(props.onSelect).toHaveBeenCalledWith("codex");
    expect(props.onSelect).toHaveBeenCalledWith("git");
    expect(props.onToggleTerminal).toHaveBeenCalledTimes(1);
    expect(props.onToggleLibrary).toHaveBeenCalledTimes(1);
    expect(props.onOpenAccount).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(props.onToggleActivity).toHaveBeenCalledTimes(1);
  });

  it("uses Git only to toggle the desktop right panel when a toggle action is provided", () => {
    const onSelect = vi.fn();
    const onToggleGitPanel = vi.fn();
    renderNav({ onSelect, onToggleGitPanel });

    fireEvent.click(screen.getByRole("button", { name: "Git" }));

    expect(onToggleGitPanel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disables terminal without an active workspace", () => {
    const onToggleTerminal = vi.fn();
    renderNav({ terminalDisabled: true, onToggleTerminal });

    const terminal = screen.getByRole("button", { name: "终端" });
    expect((terminal as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(terminal);
    expect(onToggleTerminal).not.toHaveBeenCalled();
  });

  it("keeps the rail selection mutually exclusive", () => {
    renderNav({ libraryActive: true });

    expect(
      screen.getByRole("button", { name: "首页" }).hasAttribute("aria-current"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "会话管理" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("treats settings as the exclusive active rail destination", () => {
    renderNav({
      activeTab: "codex",
      terminalActive: true,
      libraryActive: true,
      activityActive: true,
      settingsActive: true,
    });

    expect(screen.getByRole("button", { name: "设置" }).getAttribute("aria-current")).toBe(
      "page",
    );
    ["会话", "终端", "会话管理", "日志"].forEach((label) => {
      expect(screen.getByRole("button", { name: label }).hasAttribute("aria-current")).toBe(
        false,
      );
    });
  });

  it("closes the account popover before switching to settings", () => {
    const props = renderNav();

    fireEvent.click(screen.getByRole("button", { name: "账号" }));
    expect(screen.getByText("登录状态")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.queryByText("登录状态")).toBeNull();
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps bottom utility order as theme, account, settings, activity", () => {
    renderNav();

    const bottomLabels = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".tablet-nav-bottom-group .tablet-nav-item"),
    ).map((button) => button.getAttribute("aria-label"));

    expect(bottomLabels).toEqual(["亮色", "账号", "设置", "日志"]);
  });

  it("toggles from dark mode back to light mode from the rail above the account entry", () => {
    const onToggleTheme = vi.fn();
    renderNav({ onToggleTheme });

    fireEvent.click(screen.getByRole("button", { name: "亮色" }));

    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it("toggles from light mode to dark mode from the same rail entry", () => {
    const onToggleTheme = vi.fn();
    renderNav({ theme: "light", onToggleTheme });

    fireEvent.click(screen.getByRole("button", { name: "暗黑" }));

    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it("shows the current account status before offering a switch action", () => {
    const props = renderNav({
      accountInfo: {
        email: "pilot@example.com",
        type: "chatgpt",
        planType: "pro",
        requiresOpenaiAuth: false,
      },
      accountWorkspaceName: "Home Project",
    });

    fireEvent.click(screen.getByRole("button", { name: "账号" }));

    expect(screen.getByText("已登录")).toBeTruthy();
    expect(screen.getByText("pilot@example.com")).toBeTruthy();
    expect(screen.getByText("Home Project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "切换账号" }));
    expect(props.onOpenAccount).toHaveBeenCalledTimes(1);
  });
});
