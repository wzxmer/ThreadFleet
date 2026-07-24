// @vitest-environment jsdom
import { cleanup, fireEvent, render as testingRender, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef, useState, type ReactElement } from "react";
import {
  LOCAL_CODEX_GROUP_ID,
  LOCAL_CODEX_GROUP_NAME,
  LOCAL_CODEX_WORKSPACE_NAME,
  LOCAL_CODEX_WORKSPACE_ID,
} from "@/features/workspaces/domain/localCodexWorkspace";
import { Sidebar } from "./Sidebar";
import { SessionManagerProvider } from "@/features/sessions/context/SessionManagerContext";

function render(element: ReactElement) {
  function Wrapper() {
    const [active, setActive] = useState(false);
    return <SessionManagerProvider active={active} onActiveChange={setActive} onResumeSession={async () => false} onDeriveSession={() => {}}>{element}</SessionManagerProvider>;
  }
  return testingRender(<Wrapper />);
}

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
  window.localStorage.removeItem("codexmonitor.pinnedWorkspaceFolders");
  cleanup();
});

const baseProps = {
  workspaces: [],
  groupedWorkspaces: [],
  hasWorkspaceGroups: false,
  deletingWorktreeIds: new Set<string>(),
  threadsByWorkspace: {},
  threadParentById: {},
  threadStatusById: {},
  threadListLoadingByWorkspace: {},
  threadListPagingByWorkspace: {},
  threadListCursorByWorkspace: {},
  pinnedThreadsVersion: 0,
  threadListSortKey: "updated_at" as const,
  onSetThreadListSortKey: vi.fn(),
  threadListOrganizeMode: "by_project" as const,
  onSetThreadListOrganizeMode: vi.fn(),
  onRefreshAllThreads: vi.fn(),
  activeWorkspaceId: null,
  activeThreadId: null,
  accountRateLimits: null,
  activeTokenUsage: null,
  showCodexUsage: true,
  usageShowRemaining: false,
  useTokenUsageStats: false,
  thirdPartyProviderUsage: null,
  codexKeyProfiles: [],
  activeCodexKeyProfileId: null,
  onSelectCodexKeyProfile: vi.fn(),
  accountInfo: null,
  onSwitchAccount: vi.fn(),
  onCancelSwitchAccount: vi.fn(),
  accountSwitching: false,
  onOpenSettings: vi.fn(),
  onOpenDebug: vi.fn(),
  showDebugButton: false,
  onAddWorkspace: vi.fn(),
  onSelectHome: vi.fn(),
  onSelectWorkspace: vi.fn(),
  onConnectWorkspace: vi.fn(),
  onAddAgent: vi.fn(),
  onAddWorktreeAgent: vi.fn(),
  onAddCloneAgent: vi.fn(),
  onToggleWorkspaceCollapse: vi.fn(),
  onSelectThread: vi.fn(),
  onSelectLocalCodexThread: vi.fn(),
  onDeleteThread: vi.fn(),
  onSyncThread: vi.fn(),
  pinThread: vi.fn(() => false),
  unpinThread: vi.fn(),
  isThreadPinned: vi.fn(() => false),
  getPinTimestamp: vi.fn(() => null),
  onRenameThread: vi.fn(),
  onDeleteWorkspace: vi.fn(),
  onDeleteWorktree: vi.fn(),
  onLoadOlderThreads: vi.fn(),
  onReloadWorkspaceThreads: vi.fn(),
  workspaceDropTargetRef: createRef<HTMLElement>(),
  isWorkspaceDropActive: false,
  workspaceDropText: "Drop Project Here",
  onWorkspaceDragOver: vi.fn(),
  onWorkspaceDragEnter: vi.fn(),
  onWorkspaceDragLeave: vi.fn(),
  onWorkspaceDrop: vi.fn(),
};

describe("Sidebar", () => {
  it("hides usage without removing bottom actions", () => {
    render(<Sidebar {...baseProps} showCodexUsage={false} />);

    expect(screen.queryByText("用量")).toBeNull();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeTruthy();
  });

  it("toggles the search bar from the header icon", () => {
    render(<Sidebar {...baseProps} />);

    const toggleButton = screen.getByRole("button", { name: "切换搜索" });
    expect(screen.queryByLabelText("搜索会话")).toBeNull();

    fireEvent.click(toggleButton);
    const input = screen.getByLabelText("搜索会话") as HTMLInputElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "alpha" } });
    expect(input.value).toBe("alpha");

    fireEvent.click(toggleButton);
    expect(screen.queryByLabelText("搜索会话")).toBeNull();

    fireEvent.click(toggleButton);
    const reopened = screen.getByLabelText("搜索会话") as HTMLInputElement;
    expect(reopened.value).toBe("");
  });

  it("switches session manager mode without losing workspace search", () => {
    render(<Sidebar {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "本地会话管理" }));

    expect(screen.getByLabelText("搜索本地会话")).toBeTruthy();
    expect(screen.queryByLabelText("搜索会话")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "本地会话管理" }));
    expect((screen.getByLabelText("搜索会话") as HTMLInputElement).value).toBe("alpha");
  });

  it("restores the session manager scroll position after switching modes", async () => {
    render(<Sidebar {...baseProps} />);

    const toggle = screen.getByRole("button", { name: "本地会话管理" });
    fireEvent.click(toggle);
    const body = document.querySelector<HTMLElement>(".sidebar-body");
    expect(body).not.toBeNull();

    body!.scrollTop = 320;
    fireEvent.scroll(body!);
    fireEvent.click(toggle);
    await waitFor(() => expect(body!.scrollTop).toBe(0));

    fireEvent.click(toggle);
    await waitFor(() => expect(body!.scrollTop).toBe(320));
  });

  it("keeps the session manager scrollbar on an unmasked stable layer", () => {
    render(<Sidebar {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "本地会话管理" }));
    const body = document.querySelector<HTMLElement>(".sidebar-body");

    expect(body?.classList.contains("is-session-manager")).toBe(true);
    expect(body?.classList.contains("fade-top")).toBe(false);
    expect(body?.classList.contains("fade-bottom")).toBe(false);
  });

  it("clears the local session search from its clear button", () => {
    render(<Sidebar {...baseProps} />);

    const sessionManagerToggle = document.querySelector<HTMLButtonElement>(".sidebar-title-group button[aria-pressed]");
    expect(sessionManagerToggle).not.toBeNull();
    fireEvent.click(sessionManagerToggle!);
    const input = document.querySelector<HTMLInputElement>(".session-manager-search-field input");
    expect(input).not.toBeNull();
    expect(document.querySelector(".session-manager-search-field button")).toBeNull();

    fireEvent.change(input!, { target: { value: "019f6eb8" } });
    const clearButton = document.querySelector<HTMLButtonElement>(".session-manager-search-field button");
    expect(clearButton).not.toBeNull();
    fireEvent.click(clearButton!);

    expect(input!.value).toBe("");
    expect(document.querySelector(".session-manager-search-field button")).toBeNull();
  });

  it("keeps session manager open when a thread is already active", () => {
    render(
      <Sidebar
        {...baseProps}
        activeWorkspaceId="workspace-1"
        activeThreadId="thread-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "本地会话管理" }));

    expect(screen.getByLabelText("搜索本地会话")).toBeTruthy();
    expect(screen.getByRole("button", { name: "本地会话管理" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("opens thread sort menu from the header filter button", () => {
    const onSetThreadListSortKey = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        threadListSortKey="updated_at"
        onSetThreadListSortKey={onSetThreadListSortKey}
      />,
    );

    const button = screen.getByRole("button", { name: "整理和排序会话" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(button);
    const option = screen.getByRole("menuitemradio", { name: "创建时间" });
    fireEvent.click(option);

    expect(onSetThreadListSortKey).toHaveBeenCalledWith("created_at");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("changes organize mode from the header filter menu", () => {
    const onSetThreadListOrganizeMode = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        threadListOrganizeMode="by_project"
        onSetThreadListOrganizeMode={onSetThreadListOrganizeMode}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "整理和排序会话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "会话列表" }));

    expect(onSetThreadListOrganizeMode).toHaveBeenCalledWith("threads_only");
  });

  it("renders available credits in the footer when present", () => {
    render(
      <Sidebar
        {...baseProps}
        accountRateLimits={{
          primary: {
            usedPercent: 62,
            windowDurationMins: 300,
            resetsAt: Math.round(Date.now() / 1000) + 3600,
          },
          secondary: null,
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: "120",
          },
          planType: "pro",
        }}
      />,
    );

    const creditsLabel = screen.getByText(/^可用额度：/);
    expect(creditsLabel.textContent ?? "").toContain("120");
  });

  it("does not estimate cost when the provider reports no cost", () => {
    render(
      <Sidebar
        {...baseProps}
        useTokenUsageStats
        activeTokenUsage={{
          total: {
            totalTokens: 20_000,
            inputTokens: 12_000,
            cachedInputTokens: 2_000,
            outputTokens: 8_000,
            reasoningOutputTokens: 1_000,
            costUsd: null,
          },
          last: {
            totalTokens: 4_000,
            inputTokens: 3_000,
            cachedInputTokens: 1_000,
            outputTokens: 1_000,
            reasoningOutputTokens: 0,
            costUsd: null,
          },
          modelContextWindow: 100_000,
        }}
        accountRateLimits={{
          primary: {
            usedPercent: 62,
            windowDurationMins: 300,
            resetsAt: Math.round(Date.now() / 1000) + 3600,
          },
          secondary: {
            usedPercent: 88,
            windowDurationMins: 10_080,
            resetsAt: Math.round(Date.now() / 1000) + 7200,
          },
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: "120",
          },
          planType: "pro",
        }}
      />,
    );

    expect(screen.getByText("消耗量")).toBeTruthy();
    expect(screen.getByText("20,000")).toBeTruthy();
    expect(screen.getByText("费用")).toBeTruthy();
    expect(screen.getByText("--")).toBeTruthy();
    expect(screen.queryByText(/^≈/)).toBeNull();
    expect(screen.queryByText(/^x\d/)).toBeNull();
    expect(screen.queryByText("本周")).toBeNull();
    expect(screen.queryByText(/^可用额度：/)).toBeNull();
    expect(screen.queryByText("62%")).toBeNull();
  });

  it("uses provider-reported cost for third-party key sessions", () => {
    render(
      <Sidebar
        {...baseProps}
        useTokenUsageStats
        activeTokenUsage={{
          total: {
            totalTokens: 1_260_000,
            inputTokens: 436_160,
            cachedInputTokens: 809_980,
            outputTokens: 10_880,
            reasoningOutputTokens: 0,
            costUsd: 0.1042,
          },
          last: {
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            costUsd: null,
          },
          modelContextWindow: null,
        }}
      />,
    );

    expect(screen.getByText("$0.1042")).toBeTruthy();
  });

  it("shows provider balance and today cost when third-party key usage is available", () => {
    render(
      <Sidebar
        {...baseProps}
        useTokenUsageStats
        thirdPartyProviderUsage={{
          balanceUsd: 12.5,
          todayCostUsd: 0.0342,
          totalCostUsd: null,
          spendPeriod: "today",
          averageLatencyMs: 842,
          isUnlimited: false,
          isPartial: false,
          source: "sub2",
        }}
        activeTokenUsage={{
          total: {
            totalTokens: 1_260_000,
            inputTokens: 436_160,
            cachedInputTokens: 809_980,
            outputTokens: 10_880,
            reasoningOutputTokens: 0,
            costUsd: null,
          },
          last: {
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            costUsd: null,
          },
          modelContextWindow: null,
        }}
      />,
    );

    expect(screen.getByText("余额")).toBeTruthy();
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("今日消费")).toBeTruthy();
    expect(screen.getByText("$0.0342")).toBeTruthy();
    expect(screen.getByText("平均延迟")).toBeTruthy();
    expect(screen.getByText("842 ms")).toBeTruthy();
    expect(screen.queryByText("倍率")).toBeNull();
    expect(screen.queryByText("x1")).toBeNull();
  });

  it("labels New API fallback consumption as cumulative", () => {
    render(
      <Sidebar
        {...baseProps}
        useTokenUsageStats
        thirdPartyProviderUsage={{
          balanceUsd: 12.5,
          todayCostUsd: null,
          totalCostUsd: 3.25,
          spendPeriod: "total",
          averageLatencyMs: null,
          isUnlimited: false,
          isPartial: true,
          source: "new-api",
        }}
      />,
    );

    expect(screen.getByText("累计消费")).toBeTruthy();
    expect(screen.getByText("$3.25")).toBeTruthy();
    expect(screen.queryByText("今日消费")).toBeNull();
  });

  it("switches third-party key profiles from the usage panel", () => {
    const onSelectCodexKeyProfile = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        useTokenUsageStats
        codexKeyProfiles={[
          {
            id: "discount",
            name: "Discount key",
            groupName: "特惠分组",
            keyEnvVar: "OPENAI_API_KEY",
            key: "sk-discount",
            baseUrlEnvVar: "OPENAI_BASE_URL",
            baseUrl: "https://example.com/v1",
          },
          {
            id: "code",
            name: "Code key",
            groupName: "claude code",
            keyEnvVar: "OPENAI_API_KEY",
            key: "sk-code",
            baseUrlEnvVar: "OPENAI_BASE_URL",
            baseUrl: "https://example.com/v1",
          },
        ]}
        activeCodexKeyProfileId="discount"
        onSelectCodexKeyProfile={onSelectCodexKeyProfile}
        activeTokenUsage={{
          total: {
            totalTokens: 1_000_000,
            inputTokens: 700_000,
            cachedInputTokens: 0,
            outputTokens: 300_000,
            reasoningOutputTokens: 0,
            costUsd: null,
          },
          last: {
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            costUsd: null,
          },
          modelContextWindow: null,
        }}
      />,
    );

    const groupSelect = screen.getByLabelText("分组") as HTMLSelectElement;
    expect(groupSelect.value).toBe("discount");

    fireEvent.change(groupSelect, { target: { value: "code" } });
    expect(onSelectCodexKeyProfile).toHaveBeenCalledWith("code");
  });

  it("opens the account menu from the bottom rail", () => {
    render(
      <Sidebar
        {...baseProps}
        activeWorkspaceId="ws-1"
        accountInfo={{
          email: "dimillian@example.com",
          type: "chatgpt",
          planType: "pro",
          requiresOpenaiAuth: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "账号" }));

    expect(screen.getByText("dimillian@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "切换账号" })).toBeTruthy();
  });

  it("renders threads-only mode as a global chronological list", () => {
    const older = Date.now() - 10_000;
    const newer = Date.now();
    const { container } = render(
      <Sidebar
        {...baseProps}
        threadListOrganizeMode="threads_only"
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [{ id: "thread-1", name: "Older thread", updatedAt: older }],
          "ws-2": [{ id: "thread-2", name: "Newer thread", updatedAt: newer }],
        }}
      />,
    );

    const renderedNames = Array.from(container.querySelectorAll(".thread-row .thread-name")).map(
      (node) => node.textContent?.trim(),
    );
    expect(screen.getByText("最近会话")).toBeTruthy();
    expect(renderedNames[0]).toBe("Newer thread");
    expect(renderedNames[1]).toBe("Older thread");
    expect(screen.getByText("Alpha Project")).toBeTruthy();
    expect(screen.getByText("Beta Project")).toBeTruthy();
  });

  it("keeps a project visible when its thread matches the search query", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [{ id: "thread-1", name: "Fix workspace restore", updatedAt: 1000 }],
          "ws-2": [{ id: "thread-2", name: "Unrelated thread", updatedAt: 900 }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), {
      target: { value: "restore" },
    });

    await waitFor(() => {
      expect(screen.getByText("Alpha Project")).toBeTruthy();
      expect(screen.getByText("Fix workspace restore")).toBeTruthy();
      expect(screen.queryByText("Beta Project")).toBeNull();
      expect(screen.queryByText("Unrelated thread")).toBeNull();
    });
  });

  it("searches across loaded root threads before collapsed truncation", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [
            { id: "thread-1", name: "Alpha thread", updatedAt: 1000 },
            { id: "thread-2", name: "Beta thread", updatedAt: 900 },
            { id: "thread-3", name: "Gamma thread", updatedAt: 800 },
            { id: "thread-4", name: "Delta thread", updatedAt: 700 },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), {
      target: { value: "delta" },
    });

    await waitFor(() => {
      expect(screen.getByText("Alpha Project")).toBeTruthy();
      expect(screen.getByText("Delta thread")).toBeTruthy();
      expect(screen.queryByText("Alpha thread")).toBeNull();
      expect(screen.queryByText("More...")).toBeNull();
    });
  });

  it("keeps a project visible during search when only older pages may contain matches", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [{ id: "thread-1", name: "Current page thread", updatedAt: 1000 }],
        }}
        threadListCursorByWorkspace={{ "ws-1": "cursor-1" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), {
      target: { value: "historical" },
    });

    await waitFor(() => {
      expect(screen.getByText("Alpha Project")).toBeTruthy();
      expect(screen.getByRole("button", { name: "搜索更早会话..." })).toBeTruthy();
      expect(screen.queryByText("Current page thread")).toBeNull();
    });
  });

  it("hides active project threads from local Codex history by thread id", () => {
    const projectWorkspace = {
      id: "ws-1",
      name: "Alpha Project",
      path: "/tmp/alpha",
      connected: true,
      settings: { sidebarCollapsed: false },
    };
    const localCodexWorkspace = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    render(
      <Sidebar
        {...baseProps}
        workspaces={[projectWorkspace, localCodexWorkspace]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [projectWorkspace],
          },
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [localCodexWorkspace],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [
            {
              id: "thread-shared",
              name: "Active project thread",
              cwd: "/tmp/alpha",
              updatedAt: 1000,
            },
          ],
          [LOCAL_CODEX_WORKSPACE_ID]: [
            {
              id: "thread-shared",
              name: "Duplicate history thread",
              cwd: "/tmp/alpha",
              updatedAt: 1000,
            },
            {
              id: "thread-history-only",
              name: "History only thread",
              cwd: "/tmp/alpha",
              updatedAt: 900,
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: `展开 ${LOCAL_CODEX_WORKSPACE_NAME}` }));

    expect(screen.getByText("Active project thread")).toBeTruthy();
    expect(screen.queryByText("Duplicate history thread")).toBeNull();
    expect(screen.getByText("History only thread")).toBeTruthy();
  });

  it("keeps the parent project visible when only a worktree thread matches search", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-root",
            name: "Main Project",
            path: "/tmp/main",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-worktree",
            name: "Feature Worktree",
            path: "/tmp/main-feature",
            connected: true,
            kind: "worktree",
            parentId: "ws-root",
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-root",
                name: "Main Project",
                path: "/tmp/main",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-worktree": [
            { id: "thread-worktree", name: "Feature thread routing fix", updatedAt: 1000 },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), {
      target: { value: "routing fix" },
    });

    await waitFor(() => {
      expect(screen.getByText("Main Project")).toBeTruthy();
      expect(screen.getByText("工作树 Agents")).toBeTruthy();
      expect(screen.getByText("Feature Worktree")).toBeTruthy();
      expect(screen.getByText("Feature thread routing fix")).toBeTruthy();
    });
  });

  it("keeps clone agents visible when their thread matches search", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-root",
            name: "Main Project",
            path: "/tmp/main",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-clone",
            name: "Clone Agent",
            path: "/tmp/main-clone",
            connected: true,
            settings: {
              sidebarCollapsed: false,
              cloneSourceWorkspaceId: "ws-root",
            },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-root",
                name: "Main Project",
                path: "/tmp/main",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-clone",
                name: "Clone Agent",
                path: "/tmp/main-clone",
                connected: true,
                settings: {
                  sidebarCollapsed: false,
                  cloneSourceWorkspaceId: "ws-root",
                },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-clone": [
            { id: "thread-clone", name: "Investigate clone search bug", updatedAt: 1000 },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), {
      target: { value: "clone search bug" },
    });

    await waitFor(() => {
      expect(screen.getByText("Main Project")).toBeTruthy();
      expect(screen.getByText("副本 Agents")).toBeTruthy();
      expect(screen.getByText("Clone Agent")).toBeTruthy();
      expect(screen.getByText("Investigate clone search bug")).toBeTruthy();
    });
  });

  it("creates a new thread from the all-threads project picker", () => {
    const onAddAgent = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        threadListOrganizeMode="threads_only"
        onAddAgent={onAddAgent}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "在项目中新建会话" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha Project" }));

    expect(onAddAgent).toHaveBeenCalledTimes(1);
    expect(onAddAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-1" }));
  });

  it("uses the workspace plus for direct new Agent and ellipsis for Agent options", () => {
    const onAddAgent = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        onAddAgent={onAddAgent}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "立即创建" }));
    expect(onAddAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-1" }));

    fireEvent.click(screen.getByRole("button", { name: "更多 Agent 选项" }));
    expect(screen.getByRole("button", { name: "新建 Agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建 worktree Agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建副本 Agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "通过会话 ID 恢复" })).toBeTruthy();
  });

  it("moves pinned workspace session folders to the top of their group", () => {
    window.localStorage.setItem(
      "codexmonitor.pinnedWorkspaceFolders",
      JSON.stringify({ "ws-2": 200 }),
    );
    const { container } = render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
      />,
    );

    const names = Array.from(container.querySelectorAll(".workspace-row .workspace-name")).map(
      (entry) => entry.textContent,
    );
    expect(names).toEqual(["Beta Project", "Alpha Project"]);
    expect(container.querySelector(".workspace-row.is-pinned .workspace-name")?.textContent).toBe(
      "Beta Project",
    );
    window.localStorage.removeItem("codexmonitor.pinnedWorkspaceFolders");
  });

  it("refreshes all workspace threads from the header button", () => {
    const onRefreshAllThreads = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Workspace",
            path: "/tmp/workspace",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Workspace",
                path: "/tmp/workspace",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        onRefreshAllThreads={onRefreshAllThreads}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
    expect(onRefreshAllThreads).toHaveBeenCalledTimes(1);
  });

  it("opens home only from the home header button", () => {
    const onSelectHome = vi.fn();
    const onRefreshAllThreads = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Workspace",
            path: "/tmp/workspace",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Workspace",
                path: "/tmp/workspace",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        onSelectHome={onSelectHome}
        onRefreshAllThreads={onRefreshAllThreads}
      />,
    );

    expect(screen.queryByRole("button", { name: "项目" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
    expect(onRefreshAllThreads).toHaveBeenCalledTimes(1);
    expect(onSelectHome).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "打开首页" }));
    expect(onSelectHome).toHaveBeenCalledTimes(1);
  });

  it("shows the local Codex sessions entry without connect or add actions when no Codex session is available", () => {
    const onConnectWorkspace = vi.fn();
    const onAddAgent = vi.fn();

    render(
      <Sidebar
        {...baseProps}
        onConnectWorkspace={onConnectWorkspace}
        onAddAgent={onAddAgent}
        workspaces={[
          {
            id: LOCAL_CODEX_WORKSPACE_ID,
            name: LOCAL_CODEX_WORKSPACE_NAME,
            path: "",
            connected: false,
            settings: {
              sidebarCollapsed: false,
              groupId: LOCAL_CODEX_GROUP_ID,
            },
          },
        ]}
        groupedWorkspaces={[
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [
              {
                id: LOCAL_CODEX_WORKSPACE_ID,
                name: LOCAL_CODEX_WORKSPACE_NAME,
                path: "",
                connected: false,
                settings: {
                  sidebarCollapsed: false,
                  groupId: LOCAL_CODEX_GROUP_ID,
                },
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText(LOCAL_CODEX_GROUP_NAME)).toBeTruthy();
    expect(screen.getByText(LOCAL_CODEX_WORKSPACE_NAME)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {
      name: `展开 ${LOCAL_CODEX_WORKSPACE_NAME}`,
    }));
    expect(
      screen.getByText("添加或连接一个项目后，这里会同步显示本机 Codex 历史会话。"),
    ).toBeTruthy();
    expect(screen.queryByText("连接")).toBeNull();
    expect(screen.queryByRole("button", { name: "添加 Agent 选项" })).toBeNull();
  });

  it("shows all loaded local Codex sessions without opening an empty workspace", () => {
    const onSelectWorkspace = vi.fn();
    const onSelectThread = vi.fn();
    const onSelectLocalCodexThread = vi.fn();
    const projectWorkspace = {
      id: "project-ws",
      name: "ThreadFleet",
      path: "D:/Project/ThreadFleet",
      connected: true,
      settings: {
        sidebarCollapsed: false,
      },
    };
    const localWorkspace = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        groupId: LOCAL_CODEX_GROUP_ID,
      },
    };
    render(
      <Sidebar
        {...baseProps}
        onSelectWorkspace={onSelectWorkspace}
        onSelectThread={onSelectThread}
        onSelectLocalCodexThread={onSelectLocalCodexThread}
        workspaces={[projectWorkspace, localWorkspace]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Projects",
            workspaces: [projectWorkspace],
          },
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [localWorkspace],
          },
        ]}
        threadsByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: [
            {
              id: "thread-1",
              name: "Recent Codex thread",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 400,
            },
            {
              id: "thread-2",
              name: "Second Codex thread",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 300,
            },
            {
              id: "thread-3",
              name: "Third Codex thread",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 200,
            },
            {
              id: "thread-4",
              name: "Older Codex thread",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 100,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText("Older Codex thread")).toBeNull();
    fireEvent.click(screen.getByRole("button", {
      name: `展开 ${LOCAL_CODEX_WORKSPACE_NAME}`,
    }));
    expect(screen.getByText("Older Codex thread")).toBeTruthy();
    fireEvent.click(screen.getByText("Recent Codex thread").closest(".thread-row") as Element);
    expect(onSelectThread).not.toHaveBeenCalled();
    expect(onSelectLocalCodexThread).toHaveBeenCalledWith(
      "D:/Project/ThreadFleet",
      "thread-1",
    );

    const localWorkspaceRow = screen
      .getByText(LOCAL_CODEX_WORKSPACE_NAME)
      .closest(".local-codex-history-header");
    expect(localWorkspaceRow).toBeTruthy();
    fireEvent.click(localWorkspaceRow as Element);

    expect(screen.queryByText("Older Codex thread")).toBeNull();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it("starts local Codex sessions from cwd when the project is not already in the sidebar", () => {
    const onSelectThread = vi.fn();
    const onSelectLocalCodexThread = vi.fn();
    const localWorkspace = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        groupId: LOCAL_CODEX_GROUP_ID,
      },
    };

    render(
      <Sidebar
        {...baseProps}
        onSelectThread={onSelectThread}
        onSelectLocalCodexThread={onSelectLocalCodexThread}
        workspaces={[localWorkspace]}
        groupedWorkspaces={[
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [localWorkspace],
          },
        ]}
        threadsByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: [
            {
              id: "thread-rime",
              name: "Continue rime session",
              cwd: "D:/Project/rime",
              updatedAt: 100,
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: `展开 ${LOCAL_CODEX_WORKSPACE_NAME}`,
    }));
    fireEvent.click(screen.getByText("Continue rime session").closest(".thread-row") as Element);

    expect(onSelectThread).not.toHaveBeenCalled();
    expect(onSelectLocalCodexThread).toHaveBeenCalledWith(
      "D:/Project/rime",
      "thread-rime",
    );
  });

  it("collapses local Codex project groups and reveals matches during search", async () => {
    const localWorkspace = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        groupId: LOCAL_CODEX_GROUP_ID,
      },
    };

    render(
      <Sidebar
        {...baseProps}
        workspaces={[localWorkspace]}
        groupedWorkspaces={[
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [localWorkspace],
          },
        ]}
        threadsByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: [
            {
              id: "thread-codexmonitor",
              name: "ThreadFleet collapsed session",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 200,
            },
            {
              id: "thread-rime",
              name: "Rime visible session",
              cwd: "D:/Project/rime",
              updatedAt: 100,
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: `展开 ${LOCAL_CODEX_WORKSPACE_NAME}`,
    }));
    fireEvent.click(screen.getByRole("button", { name: "折叠 ThreadFleet" }));

    expect(screen.queryByText("ThreadFleet collapsed session")).toBeNull();
    expect(screen.getByRole("button", { name: "展开 ThreadFleet" })).toBeTruthy();
    expect(screen.getByText("Rime visible session")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), {
      target: { value: "collapsed" },
    });

    await waitFor(() => {
      expect(screen.getByText("ThreadFleet collapsed session")).toBeTruthy();
    });
  });

  it("shows one workspace-level load older control for local Codex project groups", () => {
    const onLoadOlderThreads = vi.fn();
    const localWorkspace = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        groupId: LOCAL_CODEX_GROUP_ID,
      },
    };

    render(
      <Sidebar
        {...baseProps}
        onLoadOlderThreads={onLoadOlderThreads}
        workspaces={[localWorkspace]}
        groupedWorkspaces={[
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [localWorkspace],
          },
        ]}
        threadListCursorByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: "next-page",
        }}
        threadsByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: [
            {
              id: "thread-codexmonitor",
              name: "ThreadFleet session",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 200,
            },
            {
              id: "thread-rime",
              name: "Rime session",
              cwd: "D:/Project/rime",
              updatedAt: 100,
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: `展开 ${LOCAL_CODEX_WORKSPACE_NAME}`,
    }));
    const loadOlderButtons = screen.getAllByRole("button", {
      name: "加载更早会话...",
    });
    expect(loadOlderButtons).toHaveLength(1);

    fireEvent.click(loadOlderButtons[0]);
    expect(onLoadOlderThreads).toHaveBeenCalledWith(LOCAL_CODEX_WORKSPACE_ID);
  });

  it("toggles local Codex sessions from the history row", () => {
    const onSelectWorkspace = vi.fn();
    const localWorkspace = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: {
        sidebarCollapsed: true,
        groupId: LOCAL_CODEX_GROUP_ID,
      },
    };
    const { container } = render(
      <Sidebar
        {...baseProps}
        onSelectWorkspace={onSelectWorkspace}
        workspaces={[localWorkspace]}
        groupedWorkspaces={[
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [localWorkspace],
          },
        ]}
        threadsByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: [
            {
              id: "thread-1",
              name: "Recent Codex thread",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 400,
            },
            {
              id: "thread-4",
              name: "Older Codex thread",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 100,
            },
          ],
        }}
      />,
    );

    const localWorkspaceRow = container.querySelector(
      ".local-codex-history-header",
    ) as HTMLButtonElement | null;
    expect(localWorkspaceRow).toBeTruthy();
    expect(localWorkspaceRow?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Recent Codex thread")).toBeNull();

    fireEvent.click(localWorkspaceRow as Element);

    expect(localWorkspaceRow?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Recent Codex thread")).toBeTruthy();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it("matches local Codex sessions by cwd project path during search", async () => {
    const localWorkspace = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        groupId: LOCAL_CODEX_GROUP_ID,
      },
    };

    render(
      <Sidebar
        {...baseProps}
        workspaces={[localWorkspace]}
        groupedWorkspaces={[
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [localWorkspace],
          },
        ]}
        threadsByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: [
            {
              id: "thread-local-path",
              name: "Unrelated title",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 100,
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), {
      target: { value: "threadfleet" },
    });

    await waitFor(() => {
      expect(screen.getByText("Unrelated title")).toBeTruthy();
      expect(screen.getByText("ThreadFleet")).toBeTruthy();
    });
  });

  it("lets local Codex search continue into older pages when the current page has no matches", async () => {
    const onLoadOlderThreads = vi.fn();
    const localWorkspace = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: LOCAL_CODEX_WORKSPACE_NAME,
      path: "",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        groupId: LOCAL_CODEX_GROUP_ID,
      },
    };

    render(
      <Sidebar
        {...baseProps}
        onLoadOlderThreads={onLoadOlderThreads}
        workspaces={[localWorkspace]}
        groupedWorkspaces={[
          {
            id: LOCAL_CODEX_GROUP_ID,
            name: LOCAL_CODEX_GROUP_NAME,
            workspaces: [localWorkspace],
          },
        ]}
        threadListCursorByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: "next-page",
        }}
        threadsByWorkspace={{
          [LOCAL_CODEX_WORKSPACE_ID]: [
            {
              id: "thread-current",
              name: "Current unrelated title",
              cwd: "D:/Project/ThreadFleet",
              updatedAt: 100,
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), {
      target: { value: "older-only-match" },
    });

    const searchOlderButton = await screen.findByRole("button", {
      name: "搜索更早会话...",
    });
    fireEvent.click(searchOlderButton);

    expect(onLoadOlderThreads).toHaveBeenCalledWith(LOCAL_CODEX_WORKSPACE_ID);
  });

  it("spins the refresh icon while workspace threads are refreshing", () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Workspace",
            path: "/tmp/workspace",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Workspace",
                path: "/tmp/workspace",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadListLoadingByWorkspace={{ "ws-1": true }}
      />,
    );

    const refreshButton = screen.getByRole("button", { name: "刷新会话" });
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");
    const icon = refreshButton.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").toContain("spinning");
  });

  it("shows a top New Agent draft row and selects workspace when clicked", () => {
    const onSelectWorkspace = vi.fn();
    const props = {
      ...baseProps,
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/workspace",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
      ],
      groupedWorkspaces: [
        {
          id: null,
          name: "Workspaces",
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace",
              path: "/tmp/workspace",
              connected: true,
              settings: { sidebarCollapsed: false },
            },
          ],
        },
      ],
      newAgentDraftWorkspaceId: "ws-1",
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      onSelectWorkspace,
    };

    render(<Sidebar {...props} />);

    const draftRow = screen.getByRole("button", { name: /新建 Agent/i });
    expect(draftRow).toBeTruthy();
    expect(draftRow.className).toContain("thread-row-draft");
    expect(draftRow.className).toContain("active");

    fireEvent.click(draftRow);
    expect(onSelectWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("renders clone agents nested under their source project", () => {
    const { container } = render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Main Project",
            path: "/tmp/main",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Clone Agent",
            path: "/tmp/main-copy",
            connected: true,
            settings: {
              sidebarCollapsed: false,
              cloneSourceWorkspaceId: "ws-1",
            },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Main Project",
                path: "/tmp/main",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Clone Agent",
                path: "/tmp/main-copy",
                connected: true,
                settings: {
                  sidebarCollapsed: false,
                  cloneSourceWorkspaceId: "ws-1",
                },
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("副本 Agents")).toBeTruthy();
    expect(screen.getByText("Clone Agent")).toBeTruthy();
    expect(container.querySelectorAll(".workspace-row")).toHaveLength(1);
    expect(container.querySelectorAll(".worktree-row")).toHaveLength(1);
  });

  it("sorts by project activity using clone-thread activity for the source project", () => {
    const { container } = render(
      <Sidebar
        {...baseProps}
        threadListOrganizeMode="by_project_activity"
        workspaces={[
          {
            id: "ws-a",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-a-clone",
            name: "Alpha Clone",
            path: "/tmp/alpha-clone",
            connected: true,
            settings: {
              sidebarCollapsed: false,
              cloneSourceWorkspaceId: "ws-a",
            },
          },
          {
            id: "ws-b",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-a",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-a-clone",
                name: "Alpha Clone",
                path: "/tmp/alpha-clone",
                connected: true,
                settings: {
                  sidebarCollapsed: false,
                  cloneSourceWorkspaceId: "ws-a",
                },
              },
              {
                id: "ws-b",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-a": [{ id: "thread-a", name: "Alpha root", updatedAt: 100 }],
          "ws-a-clone": [
            { id: "thread-a-clone", name: "Alpha clone thread", updatedAt: 300 },
          ],
          "ws-b": [{ id: "thread-b", name: "Beta root", updatedAt: 200 }],
        }}
      />,
    );

    const workspaceNames = Array.from(
      container.querySelectorAll(".workspace-row .workspace-name"),
    ).map((node) => node.textContent?.trim());
    expect(workspaceNames[0]).toBe("Alpha Project");
    expect(workspaceNames[1]).toBe("Beta Project");
  });

  it("does not show a workspace activity indicator when a thread is processing", () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Workspace",
            path: "/tmp/workspace",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Workspace",
                path: "/tmp/workspace",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [
            {
              id: "thread-1",
              name: "Thread 1",
              updated_at: new Date().toISOString(),
            } as never,
          ],
        }}
        threadStatusById={{
          "thread-1": { isProcessing: true, hasUnread: false, isReviewing: false },
        }}
      />,
    );

    const indicator = screen.queryByTitle("Streaming updates in progress");
    expect(indicator).toBeNull();
  });
});
