// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDayLabel } from "../homeFormatters";
import { Home } from "./Home";

afterEach(() => {
  cleanup();
});

const baseProps = {
  onOpenSettings: vi.fn(),
  onAddWorkspace: vi.fn(),
  onAddWorkspaceFromUrl: vi.fn(),
  latestAgentRuns: [],
  isLoadingLatestAgents: false,
  localUsageSnapshot: null,
  isLoadingLocalUsage: false,
  localUsageError: null,
  onRefreshLocalUsage: vi.fn(),
  usageMetric: "tokens" as const,
  onUsageMetricChange: vi.fn(),
  usageWorkspaceId: null,
  usageWorkspaceOptions: [],
  onUsageWorkspaceChange: vi.fn(),
  accountRateLimits: null,
  usageShowRemaining: false,
  accountInfo: null,
  onSelectThread: vi.fn(),
};

describe("Home", () => {
  it("keeps the primary home actions and token usage entry points", () => {
    const onStartNoProjectChat = vi.fn();
    const onAddWorkspace = vi.fn();
    const onAddWorkspaceFromUrl = vi.fn();

    render(
      <Home
        {...baseProps}
        onStartNoProjectChat={onStartNoProjectChat}
        onAddWorkspace={onAddWorkspace}
        onAddWorkspaceFromUrl={onAddWorkspaceFromUrl}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "无项目对话" }));
    fireEvent.click(screen.getByRole("button", { name: "添加项目" }));
    fireEvent.click(screen.getByRole("button", { name: "从 URL 添加项目" }));

    expect(onStartNoProjectChat).toHaveBeenCalledTimes(1);
    expect(onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(onAddWorkspaceFromUrl).toHaveBeenCalledTimes(1);
    expect(screen.getByText("命令工作台")).toBeTruthy();
    expect(screen.getByText("Token 与 Agent 用量")).toBeTruthy();
    expect(screen.getByRole("button", { name: "了解 ThreadFleet" })).toBeTruthy();
  });

  it("omits the latest agent panel from the focused usage dashboard", () => {
    const onSelectThread = vi.fn();
    render(
      <Home
        {...baseProps}
        latestAgentRuns={[
          {
            message: "Ship the dashboard refresh",
            timestamp: Date.now(),
            projectName: "Example Project",
            groupName: "Frontend",
            workspaceId: "workspace-1",
            threadId: "thread-1",
            isProcessing: true,
          },
        ]}
        onSelectThread={onSelectThread}
      />,
    );

    expect(screen.queryByText("最新 Agent")).toBeNull();
    expect(screen.queryByText("Example Project")).toBeNull();
    expect(screen.queryByText("Ship the dashboard refresh")).toBeNull();
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("renders usage cards in time mode", () => {
    render(
      <Home
        {...baseProps}
        usageMetric="time"
        localUsageSnapshot={{
          updatedAt: Date.now(),
          days: [
            {
              day: "2026-01-20",
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              agentTimeMs: 120000,
              agentRuns: 2,
            },
          ],
          totals: {
            lastHourTokens: 0,
            last7DaysTokens: 15,
            last30DaysTokens: 15,
            averageDailyTokens: 15,
            cacheHitRatePercent: 0,
            peakDay: "2026-01-20",
            peakDayTokens: 15,
          },
          topModels: [],
        }}
      />,
    );

    expect(screen.getAllByText("Agent 时间").length).toBeGreaterThan(0);
    expect(screen.getByText("运行次数")).toBeTruthy();
    expect(screen.getByText("峰值日")).toBeTruthy();
    expect(screen.getByText("单次平均")).toBeTruthy();
    expect(screen.getByText("活跃日平均")).toBeTruthy();
    expect(screen.getByText("最长连续")).toBeTruthy();
    expect(screen.getByText("活跃天数")).toBeTruthy();
  });

  it("renders expanded token stats and account limits", () => {
    render(
      <Home
        {...baseProps}
        localUsageSnapshot={{
          updatedAt: Date.now(),
          days: [
            {
              day: "2026-01-07",
              inputTokens: 20,
              cachedInputTokens: 5,
              outputTokens: 10,
              totalTokens: 30,
              agentTimeMs: 60000,
              agentRuns: 1,
            },
            {
              day: "2026-01-08",
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              agentTimeMs: 0,
              agentRuns: 0,
            },
            {
              day: "2026-01-09",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              agentTimeMs: 0,
              agentRuns: 0,
            },
            {
              day: "2026-01-10",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              agentTimeMs: 0,
              agentRuns: 0,
            },
            {
              day: "2026-01-11",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              agentTimeMs: 0,
              agentRuns: 0,
            },
            {
              day: "2026-01-12",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              agentTimeMs: 0,
              agentRuns: 0,
            },
            {
              day: "2026-01-13",
              inputTokens: 30,
              cachedInputTokens: 10,
              outputTokens: 20,
              totalTokens: 50,
              agentTimeMs: 120000,
              agentRuns: 2,
            },
            {
              day: "2026-01-14",
              inputTokens: 35,
              cachedInputTokens: 10,
              outputTokens: 15,
              totalTokens: 50,
              agentTimeMs: 120000,
              agentRuns: 2,
            },
            {
              day: "2026-01-15",
              inputTokens: 25,
              cachedInputTokens: 5,
              outputTokens: 15,
              totalTokens: 40,
              agentTimeMs: 120000,
              agentRuns: 2,
            },
            {
              day: "2026-01-16",
              inputTokens: 15,
              cachedInputTokens: 5,
              outputTokens: 10,
              totalTokens: 25,
              agentTimeMs: 60000,
              agentRuns: 1,
            },
            {
              day: "2026-01-17",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              agentTimeMs: 0,
              agentRuns: 0,
            },
            {
              day: "2026-01-18",
              inputTokens: 20,
              cachedInputTokens: 8,
              outputTokens: 12,
              totalTokens: 32,
              agentTimeMs: 90000,
              agentRuns: 1,
            },
            {
              day: "2026-01-19",
              inputTokens: 40,
              cachedInputTokens: 10,
              outputTokens: 25,
              totalTokens: 65,
              agentTimeMs: 180000,
              agentRuns: 3,
            },
            {
              day: "2026-01-20",
              inputTokens: 20,
              cachedInputTokens: 4,
              outputTokens: 16,
              totalTokens: 36,
              agentTimeMs: 120000,
              agentRuns: 2,
            },
          ],
          totals: {
            lastHourTokens: 12,
            last7DaysTokens: 248,
            last30DaysTokens: 343,
            monthTokens: 321,
            averageDailyTokens: 35,
            cacheHitRatePercent: 25,
            peakDay: "2026-01-19",
            peakDayTokens: 65,
          },
          topModels: [{ model: "gpt-5", tokens: 300, sharePercent: 87.5 }],
        }}
        accountRateLimits={{
          primary: {
            usedPercent: 62,
            windowDurationMins: 300,
            resetsAt: Math.round(Date.now() / 1000) + 3600,
          },
          secondary: {
            usedPercent: 34,
            windowDurationMins: 10080,
            resetsAt: Math.round(Date.now() / 1000) + 86400,
          },
          credits: {
            hasCredits: true,
            unlimited: true,
            balance: null,
          },
          planType: "pro",
        }}
        accountInfo={{
          type: "chatgpt",
          email: "user@example.com",
          planType: "pro",
          requiresOpenaiAuth: false,
        }}
      />,
    );

    expect(screen.getByText("缓存读取")).toBeTruthy();
    const uncachedInputCard = screen
      .getByText("未缓存输入")
      .closest(".home-usage-card");
    expect(uncachedInputCard).toBeTruthy();
    if (!(uncachedInputCard instanceof HTMLElement)) {
      throw new Error("Expected uncached input usage card");
    }
    expect(within(uncachedInputCard).getByText("113")).toBeTruthy();
    expect(screen.getByText("单次平均")).toBeTruthy();
    expect(screen.getByText("最长连续")).toBeTruthy();
    expect(screen.getByText("4 天")).toBeTruthy();
    expect(screen.getByText("账号限制")).toBeTruthy();
    expect(screen.getByText("不限量")).toBeTruthy();
    expect(screen.getByText("Pro")).toBeTruthy();
    expect(screen.getByText(/user@example\.com/)).toBeTruthy();
    expect(screen.queryByText("Workspace ThreadFleet")).toBeNull();

    const todayCard = screen.getByText("今天").closest(".home-usage-card");
    expect(todayCard).toBeTruthy();
    if (!(todayCard instanceof HTMLElement)) {
      throw new Error("Expected today usage card");
    }
    expect(within(todayCard).getByText("36")).toBeTruthy();

    const monthCard = screen.getByText("本月").closest(".home-usage-card");
    expect(monthCard).toBeTruthy();
    if (!(monthCard instanceof HTMLElement)) {
      throw new Error("Expected monthly usage card");
    }
    expect(within(monthCard).getByText("321")).toBeTruthy();

    expect(
      screen.getByLabelText("用量周 2026-01-14 到 2026-01-20"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "显示下一周" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen
        .getByText(formatDayLabel("2026-01-20"))
        .closest(".home-usage-bar")
        ?.getAttribute("data-value"),
    ).toBe(`${formatDayLabel("2026-01-20")} · 36 tokens`);

    fireEvent.click(screen.getByRole("button", { name: "显示上一周" }));

    expect(
      screen.getByLabelText("用量周 2026-01-07 到 2026-01-13"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "显示下一周" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "显示下一周" }));

    expect(
      screen.getByLabelText("用量周 2026-01-14 到 2026-01-20"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "显示下一周" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("renders account limits even when no local usage snapshot exists", () => {
    render(
      <Home
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
        accountInfo={{
          type: "chatgpt",
          email: "user@example.com",
          planType: "pro",
          requiresOpenaiAuth: false,
        }}
      />,
    );

    expect(screen.getByText("账号限制")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText(/user@example\.com/)).toBeTruthy();
    expect(screen.getByText("暂无用量数据")).toBeTruthy();
  });
});
