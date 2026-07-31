// @vitest-environment jsdom
import { useCallback, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  ConversationItem,
  SendMessageResult,
  TurnExecutionSummary,
} from "../../../types";
import type { SubagentResultSummary } from "../utils/subagentResults";
import { expectOpenedFileTarget } from "../test/fileLinkAssertions";
import { Messages } from "./Messages";

const useFileLinkOpenerMock = vi.fn(
  (
    _workspacePath: string | null,
    _openTargets: unknown[],
    _selectedOpenAppId: string,
  ) => ({
    openFileLink: openFileLinkMock,
    showFileLinkMenu: showFileLinkMenuMock,
  }),
);
const openFileLinkMock = vi.fn();
const showFileLinkMenuMock = vi.fn();
const { exportMarkdownFileMock } = vi.hoisted(() => ({
  exportMarkdownFileMock: vi.fn(),
}));

vi.mock("../hooks/useFileLinkOpener", () => ({
  useFileLinkOpener: (
    workspacePath: string | null,
    openTargets: unknown[],
    selectedOpenAppId: string,
  ) => useFileLinkOpenerMock(workspacePath, openTargets, selectedOpenAppId),
}));

vi.mock("@services/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("@services/tauri")>("@services/tauri");
  return {
    ...actual,
    exportMarkdownFile: exportMarkdownFileMock,
  };
});

describe("Messages", () => {
  beforeAll(() => {
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = vi.fn();
    }
  });

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useFileLinkOpenerMock.mockClear();
    openFileLinkMock.mockReset();
    showFileLinkMenuMock.mockReset();
    exportMarkdownFileMock.mockReset();
  });

  it("shows the global assistant identity with date time and running state", () => {
    const createdAt = new Date("2026-07-30T14:28:00").getTime();
    const summary: TurnExecutionSummary = {
      schemaVersion: 1,
      executionId: "exec-1",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-1",
      turnChain: ["turn-1"],
      modelId: "gpt-5-codex",
      status: "active",
      startedAtMs: createdAt,
      endedAtMs: null,
      workingDurationMs: null,
      addedLines: null,
      deletedLines: null,
      diffRevision: 0,
      recordRevision: 1,
      updatedAtMs: createdAt,
    };

    const { container } = render(
      <Messages
        items={[
          {
            id: "user-1",
            kind: "message",
            role: "user",
            text: "全部 UI 都要升级",
            createdAt,
            turnId: "turn-1",
          },
          {
            id: "assistant-1",
            kind: "message",
            role: "assistant",
            text: "完整客户端壳层已建立。",
            createdAt,
            turnId: "turn-1",
          },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking
        messageReadingStyle="native"
        assistantInstructionContent="# Identity: BT-7274"
        turnExecutionSummary={summary}
        turnExecutionSummaries={[summary]}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(container.querySelector(".message-agent-name")?.textContent).toBe(
      "BT-7274",
    );
    expect(container.querySelector(".message-agent-time")?.textContent).toBe(
      "2026-07-30 14:28",
    );
    expect(container.querySelector(".message-agent-avatar svg")).toBeTruthy();
    expect(
      container.querySelector(".message-agent-running")?.textContent,
    ).toContain("RUNNING");
    expect(container.querySelector(".message-user-time")?.textContent).toBe(
      "14:28",
    );
    expect(container.querySelector(".working-agent-name")).toBeNull();
    expect(container.querySelector(".working-status")?.textContent).toBe(
      "RUNNING",
    );
  });

  it("normalizes the turn model to a provider name instead of showing its slug", () => {
    const summary: TurnExecutionSummary = {
      schemaVersion: 1,
      executionId: "exec-1",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-1",
      turnChain: ["turn-1"],
      modelId: "gpt-5-codex",
      status: "completed",
      startedAtMs: 1,
      endedAtMs: 2,
      workingDurationMs: 1,
      addedLines: null,
      deletedLines: null,
      diffRevision: 0,
      recordRevision: 1,
      updatedAtMs: 2,
    };

    const { container } = render(
      <Messages
        items={[
          {
            id: "assistant-1",
            kind: "message",
            role: "assistant",
            text: "Done",
            turnId: "turn-1",
          },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        messageReadingStyle="native"
        turnExecutionSummaries={[summary]}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(container.querySelector(".message-agent-name")?.textContent).toBe(
      "GPT",
    );
    expect(container.querySelector(".message-agent-avatar svg")).toBeTruthy();
    expect(container.textContent).not.toContain("gpt-5-codex");
  });

  it("shows turn activity and code changes on the final assistant message", () => {
    const summary: TurnExecutionSummary = {
      schemaVersion: 1,
      executionId: "exec-claude",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-claude",
      turnChain: ["turn-claude"],
      modelId: "model-claude",
      status: "completed",
      startedAtMs: 1,
      endedAtMs: 2,
      workingDurationMs: 1,
      addedLines: 8,
      deletedLines: 3,
      diffRevision: 1,
      recordRevision: 1,
      updatedAtMs: 2,
    };

    const { container } = render(
      <Messages
        items={[
          {
            id: "assistant-commentary",
            kind: "message",
            role: "assistant",
            phase: "commentary",
            text: "Checking files.",
            turnId: "turn-claude",
          },
          {
            id: "tool-1",
            kind: "tool",
            toolType: "commandExecution",
            title: "Command",
            detail: "rg files",
            turnId: "turn-claude",
          },
          {
            id: "reasoning-1",
            kind: "reasoning",
            summary: "Plan",
            content: "Inspect first",
            turnId: "turn-claude",
          },
          {
            id: "assistant-final",
            kind: "message",
            role: "assistant",
            phase: "final_answer",
            text: "Done",
            turnId: "turn-claude",
          },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        assistantModelOptions={[
          {
            id: "model-claude",
            model: "claude-sonnet",
            displayName: "Claude Sonnet",
          },
        ]}
        turnExecutionSummaries={[summary]}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const finalMessage = container.querySelector(
      ".message.assistant:last-of-type",
    );
    expect(
      finalMessage?.querySelector(".message-agent-name")?.textContent,
    ).toBe("Claude");
    expect(
      finalMessage?.querySelector(".message-agent-stats")?.textContent,
    ).toContain("1 次工具调用");
    expect(
      finalMessage?.querySelector(".message-agent-stats")?.textContent,
    ).toContain("2 条过程消息");
    expect(
      finalMessage?.querySelector(".message-agent-stat-add")?.textContent,
    ).toBe("+8");
    expect(
      finalMessage?.querySelector(".message-agent-stat-delete")?.textContent,
    ).toBe("-3");
  });

  it("requests an older backend history page after the local window is exhausted", async () => {
    const onLoadOlderHistory = vi.fn(async () => true);
    render(
      <Messages
        items={[
          {
            id: "message-1",
            kind: "message",
            role: "assistant",
            text: "Latest",
          },
        ]}
        threadId="thread-history"
        workspaceId="ws-history"
        isThinking={false}
        hasOlderHistory
        onLoadOlderHistory={onLoadOlderHistory}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加载更早历史" }));

    await waitFor(() => expect(onLoadOlderHistory).toHaveBeenCalledTimes(1));
  });

  it("loads an older backend history page when the user keeps scrolling upward at the top", async () => {
    const onLoadOlderHistory = vi.fn(async () => true);
    const { container } = render(
      <Messages
        items={[
          {
            id: "message-1",
            kind: "message",
            role: "assistant",
            text: "Latest",
          },
        ]}
        threadId="thread-history"
        workspaceId="ws-history"
        isThinking={false}
        hasOlderHistory
        onLoadOlderHistory={onLoadOlderHistory}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const scroller = container.querySelector<HTMLDivElement>(
      ".messages.messages-full",
    );
    expect(scroller).toBeTruthy();
    fireEvent.wheel(scroller!, { deltaY: -48 });

    await waitFor(() => expect(onLoadOlderHistory).toHaveBeenCalledTimes(1));
  });

  it("reveals local hidden history before requesting an older backend page on upward top scroll", () => {
    const onLoadOlderHistory = vi.fn(async () => true);
    const { container } = render(
      <Messages
        items={[
          {
            id: "message-0",
            kind: "message",
            role: "user",
            text: "Older local",
          },
          {
            id: "message-1",
            kind: "message",
            role: "assistant",
            text: "Latest local",
          },
        ]}
        threadId="thread-local-window"
        workspaceId="ws-history"
        isThinking={false}
        hasOlderHistory
        onLoadOlderHistory={onLoadOlderHistory}
        chatHistoryScrollbackItems={1}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(screen.queryByText("Older local")).toBeNull();
    const scroller = container.querySelector<HTMLDivElement>(
      ".messages.messages-full",
    );
    expect(scroller).toBeTruthy();
    fireEvent.wheel(scroller!, { deltaY: -48 });

    expect(screen.getByText("Older local")).toBeTruthy();
    expect(onLoadOlderHistory).not.toHaveBeenCalled();
  });

  it("selects exportable conversation messages and clears selection when the thread changes", () => {
    const items: ConversationItem[] = [
      { id: "user-export", kind: "message", role: "user", text: "Question" },
      {
        id: "tool-export",
        kind: "tool",
        toolType: "shell",
        title: "Internal tool call",
        detail: "not exported",
        status: "completed",
      },
      {
        id: "assistant-export",
        kind: "message",
        role: "assistant",
        text: "Answer",
      },
    ];
    const renderMessages = (threadId: string) => (
      <Messages
        items={items}
        threadId={threadId}
        workspaceId="ws-export"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />
    );

    const { container, rerender } = render(renderMessages("thread-export-a"));
    const exportButtons = screen.getAllByRole("button", {
      name: "导出会话正文",
    });
    expect(exportButtons).toHaveLength(2);

    fireEvent.click(exportButtons[0]);
    expect(screen.getByRole("toolbar", { name: "导出会话正文" })).toBeTruthy();
    expect(
      screen.getAllByRole("checkbox", { name: "导出会话正文" }),
    ).toHaveLength(2);
    expect(screen.getByText("已选 1 条")).toBeTruthy();
    expect(
      container.querySelector(".tool-inline .message-export-checkbox"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全选正文" }));
    expect(screen.getByText("已选 2 条")).toBeTruthy();

    rerender(renderMessages("thread-export-b"));
    expect(screen.queryByRole("toolbar", { name: "导出会话正文" })).toBeNull();
  });

  it("summarizes child results and opens long output in a detail drawer", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onOpenThreadLink = vi.fn();
    const subagentResults: SubagentResultSummary[] = [
      {
        threadId: "child-thread",
        title: "检查许可证",
        status: "completed",
        summary: "package.json 中没有定义 license 字段。",
        content: "package.json 中没有定义 license 字段。\n\n这是完整结果。",
        checkpointCount: 2,
        updatedAt: 1,
      },
    ];

    render(
      <Messages
        items={[]}
        threadId="thread-parent"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        subagentResults={subagentResults}
        onOpenThreadLink={onOpenThreadLink}
      />,
    );

    expect(screen.getByText("子会话结果")).toBeTruthy();
    expect(
      screen.getByText("package.json 中没有定义 license 字段。"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /查看详情/ }));

    const drawer = screen.getByRole("dialog", { name: "检查许可证" });
    expect(drawer).toBeTruthy();
    expect(screen.getByText("这是完整结果。")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "复制结果" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(subagentResults[0].content),
    );
    fireEvent.click(within(drawer).getByRole("button", { name: "打开子会话" }));
    expect(onOpenThreadLink).toHaveBeenCalledWith("child-thread", "ws-1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "检查许可证" })).toBeNull();
  });

  it("renders checkpoint injections as visible system rows without user actions", () => {
    const items: ConversationItem[] = [
      { id: "user-1", kind: "message", role: "user", text: "Start" },
      {
        id: "checkpoint-1",
        kind: "subagentCheckpoint",
        checkpoints: [
          {
            checkpointId: "child:item:progress",
            childThreadId: "child-thread",
            childName: "worker",
            priority: "normal",
            sequence: 1,
            text: "Checkpoint body",
          },
        ],
      },
      { id: "assistant-1", kind: "message", role: "assistant", text: "Done" },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-checkpoint"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onQuoteMessage={vi.fn()}
        onResendUserMessage={vi.fn()}
      />,
    );

    const checkpoint = screen.getByRole("note", {
      name: "子会话检查点: worker",
    });
    expect(screen.getByText("Checkpoint body")).toBeTruthy();
    expect(checkpoint.closest(".process-group")).toBeNull();
    expect(checkpoint.querySelector(".message-quote-button")).toBeNull();
    expect(checkpoint.querySelector(".message-edit-button")).toBeNull();
    expect(checkpoint.querySelector(".message-copy-button")).toBeNull();
  });

  it("renders only the latest configured history batch initially", () => {
    const items: ConversationItem[] = Array.from({ length: 3 }, (_, index) => ({
      id: `msg-${index}`,
      kind: "message",
      role: "user",
      text: `Message ${index}`,
    }));

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        chatHistoryScrollbackItems={2}
      />,
    );

    expect(screen.queryByText("Message 0")).toBeNull();
    expect(screen.getByText("Message 1")).toBeTruthy();
    expect(screen.getByText("Message 2")).toBeTruthy();
    expect(screen.getByText(/上方还有 1 条/)).toBeTruthy();
  });

  it("keeps unlimited history DOM bounded to the safe default batch", () => {
    const items: ConversationItem[] = Array.from(
      { length: 3000 },
      (_, index) => ({
        id: `large-msg-${index}`,
        kind: "message",
        role: "user",
        text: `Large message ${index}`,
      }),
    );

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-large"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        chatHistoryScrollbackItems={null}
      />,
    );

    expect(container.querySelectorAll(".message")).toHaveLength(200);
    expect(screen.queryByText("Large message 0")).toBeNull();
    expect(screen.getByText("Large message 2999")).toBeTruthy();
    expect(screen.getByText(/上方还有 2800 条/)).toBeTruthy();
  });

  it("recalculates the visible history batch when the setting changes", () => {
    const items: ConversationItem[] = Array.from({ length: 5 }, (_, index) => ({
      id: `resize-msg-${index}`,
      kind: "message",
      role: "user",
      text: `Resize message ${index}`,
    }));
    const renderMessages = (batchSize: number) => (
      <Messages
        items={items}
        threadId="thread-resize"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        chatHistoryScrollbackItems={batchSize}
      />
    );

    const { container, rerender } = render(renderMessages(2));
    expect(container.querySelectorAll(".message")).toHaveLength(2);

    rerender(renderMessages(4));
    expect(container.querySelectorAll(".message")).toHaveLength(4);
    expect(screen.getByText("Resize message 1")).toBeTruthy();
  });

  it("loads earlier history when scrolling to the top", async () => {
    const items: ConversationItem[] = Array.from({ length: 4 }, (_, index) => ({
      id: `msg-${index}`,
      kind: "message",
      role: "user",
      text: `Message ${index}`,
    }));

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        chatHistoryScrollbackItems={2}
      />,
    );

    const messages = container.querySelector(".messages") as HTMLDivElement;
    let scrollHeightReads = 0;
    Object.defineProperties(messages, {
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollHeight: {
        configurable: true,
        get: () => (scrollHeightReads++ < 2 ? 800 : 1200),
      },
      clientHeight: { configurable: true, value: 400 },
    });
    scrollHeightReads = 0;
    fireEvent.scroll(messages);

    await waitFor(() => {
      expect(screen.getByText("Message 0")).toBeTruthy();
      expect(screen.getByText("Message 1")).toBeTruthy();
      expect(messages.scrollTop).toBe(400);
    });
  });

  it("reveals hidden history when session search finds it", async () => {
    const scrollIntoViewMock = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
    const items: ConversationItem[] = Array.from({ length: 4 }, (_, index) => ({
      id: `msg-${index}`,
      kind: "message",
      role: "user",
      text: `Searchable message ${index}`,
    }));

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        chatHistoryScrollbackItems={2}
      />,
    );

    expect(screen.queryByText("Searchable message 0")).toBeNull();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.change(screen.getByLabelText("搜索当前会话"), {
      target: { value: "message 0" },
    });

    await waitFor(() => {
      expect(screen.getByText("Searchable message 0")).toBeTruthy();
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
  });

  it("renders structured process items for skills and agents", () => {
    const items: ConversationItem[] = [
      {
        id: "skill-1",
        kind: "process",
        processType: "skillTriggered",
        label: "diagnose",
        detail: "bug report matched",
        status: "started",
      },
      {
        id: "agent-1",
        kind: "process",
        processType: "agentSpawned",
        label: "Atlas [reviewer]",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(screen.getByText("Using skill:")).toBeTruthy();
    expect(screen.getByText("diagnose")).toBeTruthy();
    expect(screen.getByText("bug report matched")).toBeTruthy();
    expect(screen.getByText("Spawned agent:")).toBeTruthy();
    expect(screen.getByText("Atlas [reviewer]")).toBeTruthy();
  });

  it("opens current-session search with Ctrl+F and jumps to matching content", async () => {
    const scrollIntoViewMock = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
    const items: ConversationItem[] = [
      {
        id: "msg-alpha",
        kind: "message",
        role: "assistant",
        text: "Alpha output",
      },
      {
        id: "msg-beta",
        kind: "message",
        role: "assistant",
        text: "Beta target output",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = screen.getByLabelText("搜索当前会话");
    fireEvent.change(input, { target: { value: "target" } });

    await waitFor(() => {
      expect(screen.getByText("1/1")).toBeTruthy();
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it("renders image grid above message text and opens lightbox", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-1",
        kind: "message",
        role: "user",
        text: "Hello",
        images: ["data:image/png;base64,AAA"],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const bubble = container.querySelector(".message-bubble");
    const grid = container.querySelector(".message-image-grid");
    const markdown = container.querySelector(".markdown");
    expect(bubble).toBeTruthy();
    expect(grid).toBeTruthy();
    expect(markdown).toBeTruthy();
    if (grid && markdown) {
      expect(bubble?.firstChild).toBe(grid);
    }
    const openButton = screen.getByRole("button", { name: "Open image 1" });
    fireEvent.click(openButton);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders non-image message attachments without image preview", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-attachment-1",
        kind: "message",
        role: "user",
        text: "看这个日志",
        attachments: ['data:text/plain;name="trace.log";base64,AAA'],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(container.querySelector(".message-image-grid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open image 1" })).toBeNull();
    expect(screen.getByText("trace.log")).toBeTruthy();
  });

  it("preserves newlines when images are attached", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-2",
        kind: "message",
        role: "user",
        text: "Line 1\n\n- item 1\n- item 2",
        images: ["data:image/png;base64,AAA"],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const markdown = container.querySelector(".markdown");
    expect(markdown).toBeTruthy();
    expect(markdown?.textContent ?? "").toContain("Line 1");
    expect(markdown?.textContent ?? "").toContain("item 1");
    expect(markdown?.textContent ?? "").toContain("item 2");
  });

  it("keeps literal [image] text when images are attached", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-3",
        kind: "message",
        role: "user",
        text: "Literal [image] token",
        images: ["data:image/png;base64,AAA"],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const markdown = container.querySelector(".markdown");
    expect(markdown?.textContent ?? "").toContain("Literal [image] token");
  });

  it("uses the table container as the visual bubble for assistant table-only messages", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-table-1",
        kind: "message",
        role: "assistant",
        text: [
          "src/features/app/hooks/useMainAppLayoutSurfaces.ts | category=clarity | Layout assembly is still too broad. | Split surface assembly by domain. | high",
          "",
          "src/features/threads/hooks/threadMessagingHelpers.ts | category=clarity | Helper responsibilities are too broad. | Split helpers by concern. | medium",
        ].join("\n"),
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(container.querySelector(".message-bubble-table-only")).toBeTruthy();
    expect(container.querySelector(".markdown-table-wrap")).toBeTruthy();
  });

  it("preserves markdown table scroll position across conversation rerenders", () => {
    const tableItem: ConversationItem = {
      id: "assistant-table-scroll",
      kind: "message",
      role: "assistant",
      text: ["| Name | Value |", "| --- | --- |", "| Status | Ready |"].join(
        "\n",
      ),
    };
    const renderMessages = (items: ConversationItem[]) => (
      <Messages
        items={items}
        threadId="thread-table-scroll"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />
    );
    const { container, rerender } = render(renderMessages([tableItem]));
    const tableWrap = container.querySelector<HTMLElement>(
      ".markdown-table-wrap",
    );

    expect(tableWrap).not.toBeNull();
    if (!tableWrap) {
      throw new Error("Expected markdown table wrapper");
    }
    tableWrap.scrollLeft = 240;

    rerender(renderMessages([{ ...tableItem }]));

    expect(container.querySelector(".markdown-table-wrap")).toBe(tableWrap);
    expect(tableWrap.scrollLeft).toBe(240);
  });

  it("quotes a message into composer using markdown blockquote format", () => {
    const onQuoteMessage = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "msg-quote-1",
        kind: "message",
        role: "assistant",
        text: "First line\nSecond line",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onQuoteMessage={onQuoteMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "引用消息" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /引用到当前会话/ }));
    expect(onQuoteMessage).toHaveBeenCalledWith(
      "> First line\n> Second line\n\n",
    );
  });

  it("quotes selected message fragment when text is highlighted", () => {
    const onQuoteMessage = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "msg-quote-selection-1",
        kind: "message",
        role: "assistant",
        text: "Alpha beta gamma",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onQuoteMessage={onQuoteMessage}
      />,
    );

    const textNode = screen.getByText("Alpha beta gamma").firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error("Expected message text node");
    }
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 10);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const quoteButton = screen.getByRole("button", { name: "引用消息" });
    fireEvent.pointerDown(quoteButton);
    fireEvent.click(quoteButton);
    fireEvent.click(screen.getByRole("menuitem", { name: /引用到当前会话/ }));

    expect(onQuoteMessage).toHaveBeenCalledWith("> beta\n\n");
    selection?.removeAllRanges();
  });

  it("edits a user message in place and resends it", async () => {
    const onResendUserMessage = vi.fn(async () => ({
      status: "sent" as const,
    }));
    const items: ConversationItem[] = [
      {
        id: "msg-edit-user-1",
        kind: "message",
        role: "user",
        text: "重新打包后的没有问题了",
        images: ["data:image/png;base64,AAA"],
        turnId: "turn-failed-1",
      },
      {
        id: "msg-edit-assistant-1",
        kind: "message",
        role: "assistant",
        text: "Turn failed: Service unavailable",
        turnId: "turn-failed-1",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onResendUserMessage={onResendUserMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑并重新发送" }));
    const textarea = screen.getByLabelText("编辑消息");
    fireEvent.change(textarea, {
      target: { value: "重新打包后的现在还有问题吗？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重新发送" }));

    expect(onResendUserMessage).toHaveBeenCalledWith(
      "重新打包后的现在还有问题吗？",
      ["data:image/png;base64,AAA"],
      { replaceMessageId: "msg-edit-user-1" },
    );
    await waitFor(() => {
      expect(screen.queryByLabelText("编辑消息")).toBeNull();
    });
  });

  it("keeps the edited turn mounted while rollback refresh is pending", async () => {
    let resolveResend: (result: SendMessageResult) => void = () => {};
    const onResendUserMessage = vi.fn(
      () =>
        new Promise<SendMessageResult>((resolve) => {
          resolveResend = resolve;
        }),
    );
    const history: ConversationItem[] = [
      {
        id: "msg-history-user",
        kind: "message",
        role: "user",
        text: "Earlier prompt",
      },
      {
        id: "msg-history-agent",
        kind: "message",
        role: "assistant",
        text: "Earlier reply",
      },
    ];
    const failedTurn: ConversationItem[] = [
      {
        id: "msg-retry-user",
        kind: "message",
        role: "user",
        text: "Original failed prompt",
        turnId: "turn-retry",
      },
      {
        id: "msg-retry-agent",
        kind: "message",
        role: "assistant",
        text: "Turn failed: Service unavailable",
        turnId: "turn-retry",
      },
    ];
    const renderMessages = (items: ConversationItem[]) => (
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onResendUserMessage={onResendUserMessage}
      />
    );
    const { rerender } = render(renderMessages([...history, ...failedTurn]));

    fireEvent.click(screen.getByRole("button", { name: "编辑并重新发送" }));
    fireEvent.change(screen.getByLabelText("编辑消息"), {
      target: { value: "Edited retry prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重新发送" }));

    rerender(renderMessages(history));

    expect(
      (screen.getByLabelText("编辑消息") as HTMLTextAreaElement).value,
    ).toBe("Edited retry prompt");
    expect(screen.getByText("Turn failed: Service unavailable")).toBeTruthy();

    rerender(
      renderMessages([
        ...history,
        {
          id: "msg-retry-user",
          kind: "message",
          role: "user",
          text: "Edited retry prompt",
          turnId: "turn-retry-next",
        },
      ]),
    );
    await act(async () => {
      resolveResend({ status: "sent" });
    });

    await waitFor(() => expect(screen.queryByLabelText("编辑消息")).toBeNull());
    expect(screen.getByText("Edited retry prompt")).toBeTruthy();
    expect(screen.queryByText("Turn failed: Service unavailable")).toBeNull();
  });

  it("does not offer retry when a pre-turn failure follows completed history", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-completed-user",
        kind: "message",
        role: "user",
        text: "原来的配置问题",
        turnId: "turn-completed",
      },
      {
        id: "msg-completed-assistant",
        kind: "message",
        role: "assistant",
        text: "原来的问题已经处理完成",
        turnId: "turn-completed",
      },
      {
        id: "msg-pre-turn-error",
        kind: "message",
        role: "assistant",
        text: "Turn failed to start: thread not found",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onResendUserMessage={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "编辑并重新发送" })).toBeNull();
  });

  it("shows retry progress immediately and preserves the draft when retry is blocked", async () => {
    let resolveResend: (result: SendMessageResult) => void = () => {};
    const onResendUserMessage = vi.fn(
      () =>
        new Promise<SendMessageResult>((resolve) => {
          resolveResend = resolve;
        }),
    );
    const items: ConversationItem[] = [
      {
        id: "msg-edit-user-pending",
        kind: "message",
        role: "user",
        text: "原始消息",
        turnId: "turn-failed-pending",
      },
      {
        id: "msg-edit-assistant-pending",
        kind: "message",
        role: "assistant",
        text: "Turn failed: Service unavailable",
        turnId: "turn-failed-pending",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onResendUserMessage={onResendUserMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑并重新发送" }));
    const textarea = screen.getByLabelText("编辑消息") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "修改后的消息" } });
    fireEvent.click(screen.getByRole("button", { name: "重新发送" }));

    const pendingButton = screen.getByRole("button", { name: "正在重新发送" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    expect(pendingButton.getAttribute("aria-busy")).toBe("true");
    expect(textarea.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(pendingButton);
    expect(onResendUserMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveResend({ status: "blocked" });
    });

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "重新发送" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(
      (screen.getByLabelText("编辑消息") as HTMLTextAreaElement).value,
    ).toBe("修改后的消息");
  });

  it("marks user search matches so the highlight can follow the bubble", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(
      <Messages
        items={[
          {
            id: "msg-user-target",
            kind: "message",
            role: "user",
            text: "User target content",
          },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.change(screen.getByLabelText("搜索当前会话"), {
      target: { value: "target" },
    });

    await waitFor(() => {
      const target = screen
        .getByText("User target content")
        .closest(".messages-search-target");
      expect(target?.className).toContain("is-active-search-match");
      expect(target?.className).toContain("is-user-message-search-target");
    });
  });

  it("clears current-session search when switching threads", async () => {
    const scrollIntoViewMock = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
    const renderMessages = (threadId: string, text: string) => (
      <Messages
        items={[
          {
            id: `${threadId}-message`,
            kind: "message" as const,
            role: "assistant" as const,
            text,
          },
        ]}
        threadId={threadId}
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />
    );
    const { rerender } = render(
      renderMessages("thread-1", "Shared target in thread one"),
    );

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.change(screen.getByLabelText("搜索当前会话"), {
      target: { value: "target" },
    });
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    scrollIntoViewMock.mockClear();

    rerender(renderMessages("thread-2", "Shared target in thread two"));

    await waitFor(() => {
      expect(screen.queryByLabelText("搜索当前会话")).toBeNull();
    });
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("does not repeat search positioning after an unrelated rerender", async () => {
    const scrollIntoViewMock = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
    const makeItems = (): ConversationItem[] => [
      {
        id: "stable-target",
        kind: "message",
        role: "assistant",
        text: "Stable target output",
      },
    ];
    const renderMessages = (items: ConversationItem[]) => (
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />
    );
    const { rerender } = render(renderMessages(makeItems()));

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.change(screen.getByLabelText("搜索当前会话"), {
      target: { value: "target" },
    });
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    scrollIntoViewMock.mockClear();

    rerender(renderMessages(makeItems()));
    await Promise.resolve();

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("does not offer edit and resend for successful history", () => {
    render(
      <Messages
        items={[
          { id: "msg-user", kind: "message", role: "user", text: "Hello" },
          {
            id: "msg-assistant",
            kind: "message",
            role: "assistant",
            text: "Done",
          },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onResendUserMessage={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "编辑并重新发送" })).toBeNull();
  });

  it("offers edit and resend for interrupted final user message", () => {
    render(
      <Messages
        items={[
          { id: "msg-user", kind: "message", role: "user", text: "Continue" },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        interruptedStatus={{ timestamp: Date.now() }}
        openTargets={[]}
        selectedOpenAppId=""
        onResendUserMessage={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "编辑并重新发送" })).toBeTruthy();
  });

  it("opens linked review thread when clicking thread link", () => {
    const onOpenThreadLink = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "msg-thread-link",
        kind: "message",
        role: "assistant",
        text: "Detached review completed. [Open review thread](/thread/thread-review-1)",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-parent"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onOpenThreadLink={onOpenThreadLink}
      />,
    );

    fireEvent.click(screen.getByText("Open review thread"));
    expect(onOpenThreadLink).toHaveBeenCalledWith("thread-review-1", "ws-1");
  });

  it("renders file references as compact links and opens them", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-file-link",
        kind: "message",
        role: "assistant",
        text: "Refactor candidate: `iosApp/src/views/DocumentsList/DocumentListView.swift:111`",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const fileLinkName = screen.getByText("DocumentListView.swift");
    const fileLinkLine = screen.getByText("L111");
    const fileLinkPath = screen.getByText("iosApp/src/views/DocumentsList");
    const fileLink = container.querySelector(".message-file-link");
    expect(fileLinkName).toBeTruthy();
    expect(fileLinkLine).toBeTruthy();
    expect(fileLinkPath).toBeTruthy();
    expect(fileLink).toBeTruthy();

    fireEvent.click(fileLink as Element);
    expectOpenedFileTarget(
      openFileLinkMock,
      "iosApp/src/views/DocumentsList/DocumentListView.swift",
      111,
    );
  });

  it("routes markdown href file paths through the file opener", () => {
    const linkedPath =
      "/Users/dimillian/Documents/Dev/ThreadFleet/src/features/messages/components/Markdown.tsx:244";
    const items: ConversationItem[] = [
      {
        id: "msg-file-href-link",
        kind: "message",
        role: "assistant",
        text: `Open [this file](${linkedPath})`,
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByText("this file"));
    expectOpenedFileTarget(
      openFileLinkMock,
      "/Users/dimillian/Documents/Dev/ThreadFleet/src/features/messages/components/Markdown.tsx",
      244,
    );
  });

  it("routes absolute non-whitelisted file href paths through the file opener", () => {
    const linkedPath = "/custom/project/src/App.tsx:12";
    const items: ConversationItem[] = [
      {
        id: "msg-file-href-absolute-non-whitelisted-link",
        kind: "message",
        role: "assistant",
        text: `Open [app file](${linkedPath})`,
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByText("app file"));
    expectOpenedFileTarget(openFileLinkMock, "/custom/project/src/App.tsx", 12);
  });

  it("decodes percent-encoded href file paths before opening", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-file-href-encoded-link",
        kind: "message",
        role: "assistant",
        text: "Open [guide](./docs/My%20Guide.md)",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByText("guide"));
    expectOpenedFileTarget(openFileLinkMock, "./docs/My Guide.md");
  });

  it("routes absolute href file paths with #L anchors through the file opener", () => {
    const linkedPath =
      "/Users/dimillian/Documents/Dev/ThreadFleet/src/features/messages/components/Markdown.tsx#L244";
    const items: ConversationItem[] = [
      {
        id: "msg-file-href-anchor-link",
        kind: "message",
        role: "assistant",
        text: `Open [this file](${linkedPath})`,
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByText("this file"));
    expectOpenedFileTarget(
      openFileLinkMock,
      "/Users/dimillian/Documents/Dev/ThreadFleet/src/features/messages/components/Markdown.tsx",
      244,
    );
  });

  it("routes Windows absolute href file paths with #L anchors through the file opener", () => {
    const linkedPath =
      "I:\\gpt-projects\\ThreadFleet\\src\\features\\settings\\components\\sections\\SettingsDisplaySection.tsx#L422";
    const items: ConversationItem[] = [
      {
        id: "msg-file-href-windows-anchor-link",
        kind: "message",
        role: "assistant",
        text: `Open [settings display](${linkedPath})`,
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByText("settings display"));
    expectOpenedFileTarget(
      openFileLinkMock,
      "I:\\gpt-projects\\ThreadFleet\\src\\features\\settings\\components\\sections\\SettingsDisplaySection.tsx",
      422,
    );
  });

  it("routes dotless workspace href file paths through the file opener", () => {
    const linkedPath = "/workspace/ThreadFleet/LICENSE";
    const items: ConversationItem[] = [
      {
        id: "msg-file-href-workspace-dotless-link",
        kind: "message",
        role: "assistant",
        text: `Open [license](${linkedPath})`,
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByText("license"));
    expectOpenedFileTarget(openFileLinkMock, linkedPath);
  });

  it("keeps non-file relative links as normal markdown links", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-help-href-link",
        kind: "message",
        role: "assistant",
        text: "See [Help](/help/getting-started)",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const helpLink = screen.getByText("Help").closest("a");
    expect(helpLink?.getAttribute("href")).toBe("/help/getting-started");
    fireEvent.click(screen.getByText("Help"));
    expect(openFileLinkMock).not.toHaveBeenCalled();
  });

  it("keeps route-like absolute links as normal markdown links", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-help-workspace-route-link",
        kind: "message",
        role: "assistant",
        text: "See [Workspace Home](/workspace/settings)",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const link = screen.getByText("Workspace Home").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/settings");
    fireEvent.click(screen.getByText("Workspace Home"));
    expect(openFileLinkMock).not.toHaveBeenCalled();
  });

  it("keeps deep workspace route links as normal markdown links", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-help-workspace-route-link-deep",
        kind: "message",
        role: "assistant",
        text: "See [Profile](/workspace/settings/profile)",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const link = screen.getByText("Profile").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/settings/profile");
    fireEvent.click(screen.getByText("Profile"));
    expect(openFileLinkMock).not.toHaveBeenCalled();
  });

  it("keeps dot-relative non-file links as normal markdown links", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-help-dot-relative-href-link",
        kind: "message",
        role: "assistant",
        text: "See [Help](./help/getting-started)",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const helpLink = screen.getByText("Help").closest("a");
    expect(helpLink?.getAttribute("href")).toBe("./help/getting-started");
    fireEvent.click(screen.getByText("Help"));
    expect(openFileLinkMock).not.toHaveBeenCalled();
  });

  it("does not crash or navigate on malformed codex-file links", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-malformed-file-link",
        kind: "message",
        role: "assistant",
        text: "Bad [path](codex-file:%E0%A4%A)",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByText("path"));
    expect(openFileLinkMock).not.toHaveBeenCalled();
  });

  it("hides file parent paths when message file path display is disabled", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-file-link-hidden-path",
        kind: "message",
        role: "assistant",
        text: "Refactor candidate: `iosApp/src/views/DocumentsList/DocumentListView.swift:111`",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        showMessageFilePath={false}
      />,
    );

    const fileName = container.querySelector(".message-file-link-name");
    const lineLabel = container.querySelector(".message-file-link-line");
    expect(fileName?.textContent).toBe("DocumentListView.swift");
    expect(lineLabel?.textContent).toBe("L111");
    expect(container.querySelector(".message-file-link-path")).toBeNull();
  });

  it("renders absolute file references as workspace-relative paths", () => {
    const workspacePath = "/Users/dimillian/Documents/Dev/ThreadFleet";
    const absolutePath =
      "/Users/dimillian/Documents/Dev/ThreadFleet/src/features/messages/components/Markdown.tsx:244";
    const items: ConversationItem[] = [
      {
        id: "msg-file-link-absolute-inside",
        kind: "message",
        role: "assistant",
        text: `Reference: \`${absolutePath}\``,
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        workspacePath={workspacePath}
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(screen.getByText("Markdown.tsx")).toBeTruthy();
    expect(screen.getByText("L244")).toBeTruthy();
    expect(screen.getByText("src/features/messages/components")).toBeTruthy();

    const fileLink = container.querySelector(".message-file-link");
    expect(fileLink).toBeTruthy();
    fireEvent.click(fileLink as Element);
    expectOpenedFileTarget(
      openFileLinkMock,
      "/Users/dimillian/Documents/Dev/ThreadFleet/src/features/messages/components/Markdown.tsx",
      244,
    );
  });

  it("renders absolute file references outside workspace using dotdot-relative paths", () => {
    const workspacePath = "/Users/dimillian/Documents/Dev/ThreadFleet";
    const absolutePath =
      "/Users/dimillian/Documents/Other/IceCubesApp/file.rs:123";
    const items: ConversationItem[] = [
      {
        id: "msg-file-link-absolute-outside",
        kind: "message",
        role: "assistant",
        text: `Reference: \`${absolutePath}\``,
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        workspacePath={workspacePath}
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(screen.getByText("file.rs")).toBeTruthy();
    expect(screen.getByText("L123")).toBeTruthy();
    expect(screen.getByText("../../Other/IceCubesApp")).toBeTruthy();

    const fileLink = container.querySelector(".message-file-link");
    expect(fileLink).toBeTruthy();
    fireEvent.click(fileLink as Element);
    expectOpenedFileTarget(
      openFileLinkMock,
      "/Users/dimillian/Documents/Other/IceCubesApp/file.rs",
      123,
    );
  });

  it("does not re-render messages while typing when message props stay stable", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-stable-1",
        kind: "message",
        role: "assistant",
        text: "Stable content",
      },
    ];
    const openTargets: [] = [];
    function Harness() {
      const [draft, setDraft] = useState("");
      const handleOpenThreadLink = useCallback(() => {}, []);

      return (
        <div>
          <input
            aria-label="Draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Messages
            items={items}
            threadId="thread-stable"
            workspaceId="ws-1"
            isThinking={false}
            openTargets={openTargets}
            selectedOpenAppId=""
            onOpenThreadLink={handleOpenThreadLink}
          />
        </div>
      );
    }

    render(<Harness />);
    expect(useFileLinkOpenerMock).toHaveBeenCalledTimes(1);
    const input = screen.getByLabelText("Draft");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "abc" } });

    expect(useFileLinkOpenerMock).toHaveBeenCalledTimes(1);
  });

  it("uses reasoning title for the working indicator and hides title-only reasoning rows", () => {
    const items: ConversationItem[] = [
      {
        id: "reasoning-1",
        kind: "reasoning",
        summary: "Scanning repository",
        content: "",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking
        processingStartedAt={Date.now() - 1_000}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const workingText = container.querySelector(".working-text");
    expect(workingText?.textContent ?? "").toContain("Scanning repository");
    expect(container.querySelector(".reasoning-inline")).toBeNull();
  });

  it("renders reasoning rows when there is reasoning body content", () => {
    const items: ConversationItem[] = [
      {
        id: "reasoning-2",
        kind: "reasoning",
        summary: "Scanning repository\nLooking for entry points",
        content: "",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking
        processingStartedAt={Date.now() - 2_000}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(container.querySelector(".reasoning-inline")).toBeTruthy();
    const reasoningDetail = container.querySelector(".reasoning-inline-detail");
    expect(reasoningDetail?.textContent ?? "").toContain(
      "Looking for entry points",
    );
    const workingText = container.querySelector(".working-text");
    expect(workingText?.textContent ?? "").toContain("Scanning repository");
  });

  it("uses content for the reasoning title when summary is empty", () => {
    const items: ConversationItem[] = [
      {
        id: "reasoning-content-title",
        kind: "reasoning",
        summary: "",
        content: "Plan from content\nMore detail here",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking
        processingStartedAt={Date.now() - 1_500}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const workingText = container.querySelector(".working-text");
    expect(workingText?.textContent ?? "").toContain("Plan from content");
    const reasoningDetail = container.querySelector(".reasoning-inline-detail");
    expect(reasoningDetail?.textContent ?? "").toContain("More detail here");
    expect(reasoningDetail?.textContent ?? "").not.toContain(
      "Plan from content",
    );
  });

  it("does not show a stale reasoning label from a previous turn", () => {
    const items: ConversationItem[] = [
      {
        id: "reasoning-old",
        kind: "reasoning",
        summary: "Old reasoning title",
        content: "",
      },
      {
        id: "assistant-msg",
        kind: "message",
        role: "assistant",
        text: "Previous assistant response",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking
        processingStartedAt={Date.now() - 800}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const workingText = container.querySelector(".working-text");
    expect(workingText?.textContent ?? "").toContain("Working");
    expect(workingText?.textContent ?? "").not.toContain("Old reasoning title");
  });

  it("keeps the latest title-only reasoning label without rendering a reasoning row", () => {
    const items: ConversationItem[] = [
      {
        id: "reasoning-title-only",
        kind: "reasoning",
        summary: "Indexing workspace",
        content: "",
      },
      {
        id: "tool-after-reasoning",
        kind: "tool",
        title: "Command: rg --files",
        detail: "/tmp",
        toolType: "commandExecution",
        output: "",
        status: "running",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking
        processingStartedAt={Date.now() - 1_000}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const workingText = container.querySelector(".working-text");
    expect(workingText?.textContent ?? "").toContain("Indexing workspace");
    expect(container.querySelector(".reasoning-inline")).toBeNull();
  });

  it("advances the working timer while a first thread is still being created", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const { container } = render(
        <Messages
          items={[]}
          threadId={null}
          workspaceId="ws-1"
          isThinking
          processingStartedAt={null}
          openTargets={[]}
          selectedOpenAppId=""
        />,
      );

      expect(container.querySelector(".working-timer-clock")?.textContent).toBe(
        "0:00",
      );
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(container.querySelector(".working-timer-clock")?.textContent).toBe(
        "0:02",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows polling fetch countdown text instead of done duration when requested", () => {
    vi.useFakeTimers();
    try {
      const items: ConversationItem[] = [
        {
          id: "assistant-msg-done",
          kind: "message",
          role: "assistant",
          text: "Completed response",
        },
      ];

      render(
        <Messages
          items={items}
          threadId="thread-1"
          workspaceId="ws-1"
          isThinking={false}
          lastDurationMs={4_000}
          showPollingFetchStatus
          pollingIntervalMs={12_000}
          openTargets={[]}
          selectedOpenAppId=""
        />,
      );

      expect(
        screen.getByText("New message will be fetched in 12 seconds"),
      ).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(
        screen.getByText("New message will be fetched in 11 seconds"),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps done duration text when polling fetch countdown is not requested", () => {
    const items: ConversationItem[] = [
      {
        id: "assistant-msg-done-default",
        kind: "message",
        role: "assistant",
        text: "Completed response",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        lastDurationMs={4_000}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(screen.getByText("Done in 0:04")).toBeTruthy();
  });

  it("renders answered user input items with preview and expandable details", () => {
    const items: ConversationItem[] = [
      {
        id: "user-input-1",
        kind: "userInput",
        status: "answered",
        questions: [
          {
            id: "q1",
            header: "Confirm",
            question: "Proceed with deployment?",
            answers: ["Yes", "user_note: after running tests"],
          },
        ],
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(screen.getByText(/Proceed with deployment\?: Yes \+1/)).toBeTruthy();
    expect(screen.queryByText("user_note: after running tests")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle answered input details" }),
    );

    expect(screen.getByText("user_note: after running tests")).toBeTruthy();
  });

  it("merges consecutive explore items under a single explored block", async () => {
    const items: ConversationItem[] = [
      {
        id: "explore-1",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "search", label: "Find routes" }],
      },
      {
        id: "explore-2",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "read", label: "routes.ts" }],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".explore-inline")).toBeTruthy();
    });
    expect(screen.queryByText(/tool calls/i)).toBeNull();
    const exploreItems = container.querySelectorAll(".explore-inline-item");
    expect(exploreItems.length).toBe(2);
    expect(
      container.querySelector(".explore-inline-title")?.textContent ?? "",
    ).toContain("Explored");
  });

  it("uses the latest explore status when merging a consecutive run", async () => {
    const items: ConversationItem[] = [
      {
        id: "explore-started",
        kind: "explore",
        status: "exploring",
        entries: [{ kind: "search", label: "starting" }],
      },
      {
        id: "explore-finished",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "read", label: "finished" }],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".explore-inline").length).toBe(1);
    });
    const exploreTitle = container.querySelector(".explore-inline-title");
    expect(exploreTitle?.textContent ?? "").toContain("Explored");
  });

  it("does not merge explore items across interleaved tools", async () => {
    const items: ConversationItem[] = [
      {
        id: "explore-a",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "search", label: "Find reducers" }],
      },
      {
        id: "tool-a",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: rg reducers",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "explore-b",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "read", label: "useThreadsReducer.ts" }],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      const groupHeaders = container.querySelectorAll(".tool-group-header");
      expect(groupHeaders.length).toBe(1);
    });
    await waitFor(() => {
      const exploreBlocks = container.querySelectorAll(".explore-inline");
      expect(exploreBlocks.length).toBe(2);
    });
    const exploreItems = container.querySelectorAll(".explore-inline-item");
    expect(exploreItems.length).toBe(2);
    expect(screen.getByText(/rg reducers/i)).toBeTruthy();
  });

  it("preserves chronology when reasoning with body appears between explore items", async () => {
    const items: ConversationItem[] = [
      {
        id: "explore-1",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "search", label: "first explore" }],
      },
      {
        id: "reasoning-body",
        kind: "reasoning",
        summary: "Reasoning title\nReasoning body",
        content: "",
      },
      {
        id: "explore-2",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "read", label: "second explore" }],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".explore-inline").length).toBe(2);
    });
    const exploreBlocks = Array.from(
      container.querySelectorAll(".explore-inline"),
    );
    const reasoningDetail = container.querySelector(".reasoning-inline-detail");
    expect(exploreBlocks.length).toBe(2);
    expect(reasoningDetail).toBeTruthy();
    const [firstExploreBlock, secondExploreBlock] = exploreBlocks;
    const firstBeforeReasoning =
      firstExploreBlock.compareDocumentPosition(reasoningDetail as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING;
    const reasoningBeforeSecond =
      (reasoningDetail as Node).compareDocumentPosition(secondExploreBlock) &
      Node.DOCUMENT_POSITION_FOLLOWING;
    expect(firstBeforeReasoning).toBeTruthy();
    expect(reasoningBeforeSecond).toBeTruthy();
  });

  it("does not merge across message boundaries and does not drop messages", async () => {
    const items: ConversationItem[] = [
      {
        id: "explore-before",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "search", label: "before message" }],
      },
      {
        id: "assistant-msg",
        kind: "message",
        role: "assistant",
        text: "A message between explore blocks",
      },
      {
        id: "explore-after",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "read", label: "after message" }],
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      const groupHeaders = container.querySelectorAll(".tool-group-header");
      expect(groupHeaders.length).toBe(1);
    });
    expect(screen.getByText("A message between explore blocks")).toBeTruthy();
    screen.getAllByLabelText(/展开(?:工具调用|过程消息)/).forEach((button) => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      const exploreBlocks = container.querySelectorAll(".explore-inline");
      expect(exploreBlocks.length).toBe(2);
    });
  });

  it("keeps the last historical assistant message visible when a local turn-start error follows", async () => {
    const items: ConversationItem[] = [
      {
        id: "historical-user",
        kind: "message",
        role: "user",
        text: "Run the checks",
        turnId: "historical-turn",
      },
      {
        id: "historical-tool",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: npm test",
        detail: "/repo",
        status: "completed",
        output: "",
        turnId: "historical-turn",
      },
      {
        id: "historical-final",
        kind: "message",
        role: "assistant",
        text: "Historical final response",
        turnId: "historical-turn",
      },
      {
        id: "local-turn-start-error",
        kind: "message",
        role: "assistant",
        text: "Failed to resume the old session",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-old-session"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Historical final response")).toBeTruthy();
    });
    expect(screen.getByText("Failed to resume the old session")).toBeTruthy();
    expect(
      container
        .querySelector(".process-group")
        ?.textContent?.includes("Historical final response") ?? false,
    ).toBe(false);
  });

  it("counts explore entry steps in the tool group summary", async () => {
    const items: ConversationItem[] = [
      {
        id: "tool-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git status --porcelain=v1",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "explore-steps-1",
        kind: "explore",
        status: "explored",
        entries: [
          { kind: "read", label: "Messages.tsx" },
          { kind: "search", label: "toolCount" },
        ],
      },
      {
        id: "explore-steps-2",
        kind: "explore",
        status: "explored",
        entries: [{ kind: "read", label: "types.ts" }],
      },
      {
        id: "tool-2",
        kind: "tool",
        toolType: "commandExecution",
        title:
          "Command: git diff -- src/features/messages/components/Messages.tsx",
        detail: "/repo",
        status: "completed",
        output: "",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("5 次工具调用")).toBeTruthy();
    });
  });

  it("keeps future tool groups collapsed after collapse-all is selected", async () => {
    const firstItems: ConversationItem[] = [
      {
        id: "tool-collapse-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git status",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "tool-collapse-1b",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git log",
        detail: "/repo",
        status: "completed",
        output: "",
      },
    ];
    const nextItems: ConversationItem[] = [
      ...firstItems,
      {
        id: "message-between-tools",
        kind: "message",
        role: "assistant",
        text: "Done with first command.",
      },
      {
        id: "tool-collapse-2",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git diff",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "tool-collapse-2b",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git branch",
        detail: "/repo",
        status: "completed",
        output: "",
      },
    ];

    const { rerender } = render(
      <Messages
        items={firstItems}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "工具调用自动收起：关" }),
    );
    await waitFor(() => {
      expect(screen.queryByText("git status")).toBeNull();
    });

    rerender(
      <Messages
        items={nextItems}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("git diff")).toBeNull();
    });
    expect(screen.getByText("Done with first command.")).toBeTruthy();
  });

  it("collapses tool groups before a final assistant message", async () => {
    const items: ConversationItem[] = [
      {
        id: "tool-final-collapse-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git status",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "tool-final-collapse-2",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git diff",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "assistant-final-collapse",
        kind: "message",
        role: "assistant",
        text: "Final result is ready.",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("git status")).toBeNull();
    });

    expect(screen.getByText("2 次工具调用")).toBeTruthy();
    expect(screen.getByText("Final result is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));
    expect(screen.getByText("git status")).toBeTruthy();
  });

  it("collapses late process rows inserted before an existing final assistant message", async () => {
    const firstItems: ConversationItem[] = [
      {
        id: "tool-final-late-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git status",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "assistant-final-late",
        kind: "message",
        role: "assistant",
        text: "Final result is ready.",
      },
    ];
    const { rerender } = render(
      <Messages
        items={firstItems}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("git status")).toBeNull();
    });

    rerender(
      <Messages
        items={[
          firstItems[0],
          {
            id: "tool-final-late-2",
            kind: "tool",
            toolType: "commandExecution",
            title: "Command: git diff",
            detail: "/repo",
            status: "completed",
            output: "",
          },
          firstItems[1],
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("git diff")).toBeNull();
    });
    expect(screen.getByText("Final result is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));
    expect(screen.getByText("git diff")).toBeTruthy();
  });

  it("collapses late process rows inserted after an existing final assistant message", async () => {
    const firstItems: ConversationItem[] = [
      {
        id: "assistant-final-before-late-process",
        kind: "message",
        role: "assistant",
        text: "Final result is ready.",
      },
    ];
    const { rerender } = render(
      <Messages
        items={firstItems}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(screen.getByText("Final result is ready.")).toBeTruthy();

    rerender(
      <Messages
        items={[
          firstItems[0],
          {
            id: "tool-after-final-late",
            kind: "tool",
            toolType: "commandExecution",
            title: "Command: npm run typecheck",
            detail: "/repo",
            status: "completed",
            output: "",
          },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("npm run typecheck")).toBeNull();
    });
    expect(screen.getByText("Final result is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));
    expect(screen.getByText("npm run typecheck")).toBeTruthy();
  });

  it("collapses assistant process messages before a final assistant message", async () => {
    const items: ConversationItem[] = [
      {
        id: "user-final-process-collapse",
        kind: "message",
        role: "user",
        text: "检查最终折叠",
      },
      {
        id: "assistant-process-collapse-1",
        kind: "message",
        role: "assistant",
        text: "Interim process answer should collapse.",
      },
      {
        id: "tool-process-collapse-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git status",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "assistant-final-process-collapse",
        kind: "message",
        role: "assistant",
        text: "Final result is ready.",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByText("Interim process answer should collapse."),
      ).toBeNull();
    });
    expect(screen.queryByText("git status")).toBeNull();
    expect(screen.getByText("1 次工具调用")).toBeTruthy();
    expect(screen.getByText("1 条过程消息")).toBeTruthy();
    expect(screen.getByText("Final result is ready.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));
    expect(
      screen.getByText("Interim process answer should collapse."),
    ).toBeTruthy();
    expect(screen.getByText("git status")).toBeTruthy();
  });

  it("unifies process messages and late tool calls under one process header", async () => {
    const items: ConversationItem[] = [
      {
        id: "assistant-unified-process-1",
        kind: "message",
        role: "assistant",
        phase: "commentary",
        turnId: "turn-unified-process",
        text: "准备落补丁，先统一过程显示。",
      },
      {
        id: "assistant-unified-final",
        kind: "message",
        role: "assistant",
        phase: "final_answer",
        turnId: "turn-unified-process",
        text: "最终结果已完成。",
      },
      {
        id: "tool-unified-process-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: npm run typecheck",
        detail: "/repo",
        status: "completed",
        output: "",
        turnId: "turn-unified-process",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("准备落补丁，先统一过程显示。")).toBeNull();
    });
    expect(screen.queryByText("npm run typecheck")).toBeNull();
    expect(screen.getByText("1 次工具调用")).toBeTruthy();
    expect(screen.getByText("1 条过程消息")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "展开工具调用" })).toBeNull();
    expect(container.querySelectorAll(".process-group")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));

    expect(screen.getByText("准备落补丁，先统一过程显示。")).toBeTruthy();
    expect(screen.getByText("npm run typecheck")).toBeTruthy();
    const processGroup = container.querySelector(".process-group");
    expect(processGroup?.querySelector(".process-message-inline")).toBeTruthy();
    expect(processGroup?.querySelector(".message-agent-meta")).toBeNull();
  });

  it("folds late same-turn tools into a final message without a phase marker", async () => {
    const items: ConversationItem[] = [
      {
        id: "assistant-late-unphased-process",
        kind: "message",
        role: "assistant",
        text: "先检查开发版状态。",
        turnId: "turn-late-unphased",
      },
      {
        id: "tool-late-unphased-before",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: first check",
        detail: "/repo",
        status: "completed",
        output: "",
        turnId: "turn-late-unphased",
      },
      {
        id: "assistant-late-unphased-final",
        kind: "message",
        role: "assistant",
        text: "开发版已经启动。",
        turnId: "turn-late-unphased",
      },
      {
        id: "tool-late-unphased-after",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: second check",
        detail: "/repo",
        status: "completed",
        output: "",
        turnId: "turn-late-unphased",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("first check")).toBeNull();
      expect(screen.queryByText("second check")).toBeNull();
    });
    expect(screen.getByText("2 次工具调用")).toBeTruthy();
    expect(
      container.querySelectorAll(".message-agent-process-toggle"),
    ).toHaveLength(1);
    expect(container.querySelectorAll(".tool-group-header")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));
    expect(screen.getByText("first check")).toBeTruthy();
    expect(screen.getByText("second check")).toBeTruthy();
  });

  it("collapses dense tool runs again inside expanded process details", async () => {
    const items: ConversationItem[] = [
      {
        id: "assistant-dense-tools-process",
        kind: "message",
        role: "assistant",
        phase: "commentary",
        text: "准备执行一组检查。",
        turnId: "turn-dense-tools",
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `dense-tool-${index + 1}`,
        kind: "tool" as const,
        toolType: "commandExecution" as const,
        title: `Command: nested command ${index + 1}`,
        detail: "/repo",
        status: "completed",
        output: "",
        turnId: "turn-dense-tools",
      })),
      {
        id: "assistant-dense-tools-final",
        kind: "message",
        role: "assistant",
        phase: "final_answer",
        text: "检查完成。",
        turnId: "turn-dense-tools",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));
    expect(screen.queryByText("nested command 1")).toBeNull();
    expect(
      container.querySelector(
        ".process-group-nested-collapsible .tool-group-summary",
      )?.textContent,
    ).toBe("5 次工具调用");

    fireEvent.click(screen.getByRole("button", { name: "展开工具调用" }));
    expect(screen.getByText("nested command 1")).toBeTruthy();
    expect(screen.getByText("nested command 5")).toBeTruthy();
  });

  it("coalesces split tool runs into one nested disclosure", async () => {
    const items: ConversationItem[] = [
      {
        id: "split-tool-first",
        kind: "tool",
        toolType: "dynamicToolCall",
        title: "Tool: functions / exec",
        detail: "first",
        status: "completed",
        output: "",
        turnId: "turn-split-tools",
      },
      {
        id: "split-tool-commentary",
        kind: "message",
        role: "assistant",
        phase: "commentary",
        text: "继续检查剩余状态。",
        turnId: "turn-split-tools",
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `split-tool-rest-${index + 1}`,
        kind: "tool" as const,
        toolType: "dynamicToolCall" as const,
        title: index === 1 ? "Tool: functions / wait" : "Tool: functions / exec",
        detail: `rest ${index + 1}`,
        status: "completed",
        output: "",
        turnId: "turn-split-tools",
      })),
      {
        id: "split-tool-final",
        kind: "message",
        role: "assistant",
        phase: "final_answer",
        text: "检查完成。",
        turnId: "turn-split-tools",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));
    const nestedGroups = container.querySelectorAll(
      ".process-group-nested-collapsible",
    );
    expect(nestedGroups).toHaveLength(1);
    expect(nestedGroups[0]?.querySelector(".tool-group-summary")?.textContent).toBe(
      "7 次工具调用",
    );
    expect(container.querySelectorAll(".process-group-nested:not(.process-group-nested-collapsible)")).toHaveLength(0);
  });

  it("renders turn line changes inline after process group summary text", async () => {
    const items: ConversationItem[] = [
      {
        id: "assistant-process-line-stats",
        kind: "message",
        role: "assistant",
        text: "Editing files.",
      },
      {
        id: "tool-process-line-stats",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: apply patch",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "assistant-final-line-stats",
        kind: "message",
        role: "assistant",
        text: "Done.",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        activeTurnDiff={[
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,2 +1,3 @@",
          "-old",
          "+new",
          "+added",
        ].join("\n")}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Editing files.")).toBeNull();
    });
    const stats = container.querySelector(".message-agent-stats");
    expect(stats?.textContent).toContain("+2");
    expect(stats?.textContent).toContain("-1");
    expect(container.querySelector(".tool-group-line-change-stats")).toBeNull();
  });

  it("binds persisted line changes to the matching turn tool group", async () => {
    const items: ConversationItem[] = [
      {
        id: "tool-turn-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: first",
        detail: "/repo",
        status: "completed",
        output: "",
        turnId: "turn-1",
      },
      {
        id: "assistant-turn-1",
        kind: "message",
        role: "assistant",
        text: "First done.",
        turnId: "turn-1",
      },
      {
        id: "tool-turn-2",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: second",
        detail: "/repo",
        status: "completed",
        output: "",
        turnId: "turn-2",
      },
      {
        id: "assistant-turn-2",
        kind: "message",
        role: "assistant",
        text: "Second done.",
        turnId: "turn-2",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        turnExecutionSummary={{
          schemaVersion: 1,
          executionId: "execution-2",
          workspaceId: "ws-1",
          threadId: "thread-1",
          turnId: "turn-2",
          turnChain: ["turn-2"],
          status: "completed",
          startedAtMs: 10,
          endedAtMs: 20,
          workingDurationMs: 10,
          addedLines: 5,
          deletedLines: 2,
          diffRevision: 1,
          recordRevision: 2,
          updatedAtMs: 20,
        }}
      />,
    );

    await waitFor(() => {
      const additions = container.querySelectorAll(".message-agent-stat-add");
      expect(additions).toHaveLength(1);
      expect(additions[0]?.textContent).toContain("+5");
      expect(
        container.querySelector(".message-agent-stat-delete")?.textContent,
      ).toContain("-2");
    });
  });

  it("derives historical line changes from persisted fileChange diffs", async () => {
    const items: ConversationItem[] = [
      {
        id: "file-change-history",
        kind: "tool",
        toolType: "fileChange",
        title: "File changes",
        detail: "M src/a.ts",
        status: "completed",
        output: "",
        changes: [
          {
            path: "src/a.ts",
            kind: "update",
            diff: [
              "diff --git a/src/a.ts b/src/a.ts",
              "--- a/src/a.ts",
              "+++ b/src/a.ts",
              "@@ -1 +1,2 @@",
              "-old",
              "+new",
              "+added",
            ].join("\n"),
          },
        ],
        turnId: "turn-history",
      },
      {
        id: "assistant-history-final",
        kind: "message",
        role: "assistant",
        phase: "final_answer",
        text: "Done.",
        turnId: "turn-history",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      const stats = container.querySelector(".message-agent-stats");
      expect(stats?.textContent).toContain("+2");
      expect(stats?.textContent).toContain("-1");
    });
  });

  it("derives historical line changes from persisted dynamic apply_patch calls", async () => {
    const items: ConversationItem[] = [
      {
        id: "dynamic-patch-history",
        kind: "tool",
        toolType: "dynamicToolCall",
        title: "Tool: functions / exec",
        detail: "truncated persisted arguments",
        status: "completed",
        output: "",
        lineChangeStats: { additions: 1, deletions: 1 },
        turnId: "turn-dynamic-history",
      },
      {
        id: "assistant-dynamic-history-final",
        kind: "message",
        role: "assistant",
        phase: "final_answer",
        text: "Done.",
        turnId: "turn-dynamic-history",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      const stats = container.querySelector(".message-agent-stats");
      expect(stats?.textContent).toContain("+1");
      expect(stats?.textContent).toContain("-1");
    });
  });

  it("collapses assistant process messages before a final message without a visible user anchor", async () => {
    const items: ConversationItem[] = [
      {
        id: "assistant-process-no-user-1",
        kind: "message",
        role: "assistant",
        text: "跑消息和设置测试，抓 UI 交互回归。",
      },
      {
        id: "tool-process-no-user-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: npm run test",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "assistant-process-no-user-2",
        kind: "message",
        role: "assistant",
        text: "测试过。再补一条回归。",
      },
      {
        id: "tool-process-no-user-2",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: npm run typecheck",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "assistant-final-no-user",
        kind: "message",
        role: "assistant",
        text: "最终结果已完成。",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByText("跑消息和设置测试，抓 UI 交互回归。"),
      ).toBeNull();
    });
    expect(screen.queryByText("测试过。再补一条回归。")).toBeNull();
    expect(screen.queryByText("npm run test")).toBeNull();
    expect(screen.getByText("2 次工具调用")).toBeTruthy();
    expect(screen.getByText("2 条过程消息")).toBeTruthy();
    expect(screen.getByText("最终结果已完成。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "展开过程消息" }));
    expect(screen.getByText("跑消息和设置测试，抓 UI 交互回归。")).toBeTruthy();
    expect(screen.getByText("npm run test")).toBeTruthy();
  });

  it("keeps text-only commentary visible beside the final answer", async () => {
    const firstTimestamp = new Date("2026-07-08T19:54:52").getTime();
    const secondTimestamp = new Date("2026-07-08T19:55:44").getTime();
    const items: ConversationItem[] = [
      {
        id: "assistant-process-cli-time-1",
        kind: "message",
        role: "assistant",
        phase: "commentary",
        turnId: "turn-text-only",
        text: "First process message.",
        createdAt: firstTimestamp,
      },
      {
        id: "assistant-process-cli-time-2",
        kind: "message",
        role: "assistant",
        phase: "commentary",
        turnId: "turn-text-only",
        text: "Second process message.",
        createdAt: secondTimestamp,
      },
      {
        id: "assistant-final-cli-time",
        kind: "message",
        role: "assistant",
        phase: "final_answer",
        turnId: "turn-text-only",
        text: "Final result.",
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        messageReadingStyle="cli"
      />,
    );

    expect(
      container.querySelector(".message-agent-stats")?.textContent,
    ).toContain("2 条过程消息");
    expect(screen.queryByRole("button", { name: "展开过程消息" })).toBeNull();
    expect(screen.getByText("First process message.")).toBeTruthy();
    expect(screen.getByText("Second process message.")).toBeTruthy();
    expect(container.querySelector(".messages-view")?.className).toContain(
      "messages-reading-native",
    );
    expect(container.querySelector("[data-cli-timestamp]")).toBeNull();
  });

  it("collapses verbose text-only commentary before the final answer", async () => {
    const items: ConversationItem[] = [
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `assistant-verbose-commentary-${index}`,
        kind: "message" as const,
        role: "assistant" as const,
        phase: "commentary",
        turnId: "turn-verbose-text-only",
        text: `Verbose process message ${index + 1}.`,
      })),
      {
        id: "assistant-verbose-final",
        kind: "message",
        role: "assistant",
        phase: "final_answer",
        turnId: "turn-verbose-text-only",
        text: "Final result.",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Verbose process message 1.")).toBeNull();
    });
    expect(screen.getAllByText("3 条过程消息")).toHaveLength(1);
    expect(screen.getByText("Final result.")).toBeTruthy();
  });

  it("collapses process messages in every completed turn", async () => {
    const items: ConversationItem[] = [
      {
        id: "user-turn-collapse-1",
        kind: "message",
        role: "user",
        text: "第一轮",
      },
      {
        id: "assistant-turn-process-1",
        kind: "message",
        role: "assistant",
        text: "第一轮过程消息",
      },
      {
        id: "tool-turn-process-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: npm run test",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "assistant-turn-final-1",
        kind: "message",
        role: "assistant",
        text: "第一轮最终结果",
      },
      {
        id: "user-turn-collapse-2",
        kind: "message",
        role: "user",
        text: "第二轮",
      },
      {
        id: "assistant-turn-process-2",
        kind: "message",
        role: "assistant",
        text: "第二轮过程消息",
      },
      {
        id: "tool-turn-process-2",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: npm run typecheck",
        detail: "/repo",
        status: "completed",
        output: "",
      },
      {
        id: "assistant-turn-final-2",
        kind: "message",
        role: "assistant",
        text: "第二轮最终结果",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("第一轮过程消息")).toBeNull();
    });
    expect(screen.queryByText("第二轮过程消息")).toBeNull();
    expect(screen.queryByText("npm run test")).toBeNull();
    expect(screen.queryByText("npm run typecheck")).toBeNull();
    expect(screen.getByText("第一轮最终结果")).toBeTruthy();
    expect(screen.getByText("第二轮最终结果")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "展开过程消息" }),
    ).toHaveLength(2);
  });

  it("collapses standalone process rows before a final assistant message", async () => {
    const planItem: ConversationItem = {
      id: "plan-final-collapse",
      kind: "tool",
      toolType: "plan",
      title: "Plan",
      detail: "completed",
      status: "completed",
      output: "Standalone plan output",
    };
    const { rerender } = render(
      <Messages
        items={[planItem]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Standalone plan output")).toBeTruthy();
    });

    rerender(
      <Messages
        items={[
          planItem,
          {
            id: "assistant-final-after-plan",
            kind: "message",
            role: "assistant",
            text: "Final result is ready.",
          },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Standalone plan output")).toBeNull();
    });
    expect(screen.getByText("Final result is ready.")).toBeTruthy();
  });

  it("does not expose message reading style switches from the conversation toolbar", () => {
    const onUpdateConversationStyle = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "msg-style",
        kind: "message",
        role: "assistant",
        text: "Readable output",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onUpdateConversationStyle={onUpdateConversationStyle}
      />,
    );

    expect(screen.queryByRole("button", { name: "气泡" })).toBeNull();
    expect(screen.queryByRole("button", { name: "原生" })).toBeNull();
    expect(screen.queryByRole("button", { name: "CLI" })).toBeNull();
    expect(screen.queryByRole("button", { name: "样式" })).toBeNull();
    expect(onUpdateConversationStyle).not.toHaveBeenCalled();
  });

  it("keeps tool auto-collapse controls visible for an empty new thread", () => {
    render(
      <Messages
        items={[]}
        threadId={null}
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(
      screen.getByRole("button", { name: /工具调用自动收起/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "阅读样式" })).toBeNull();
    expect(screen.queryByRole("button", { name: "样式" })).toBeNull();
  });

  it("moves conversation tools into the main header host when available", async () => {
    const host = document.createElement("div");
    host.className = "main-header-message-tools";
    document.body.appendChild(host);
    try {
      render(
        <Messages
          items={[]}
          threadId={null}
          workspaceId="ws-1"
          isThinking={false}
          openTargets={[]}
          selectedOpenAppId=""
        />,
      );

      await waitFor(() => {
        expect(host.querySelector(".messages-tool-controls")).toBeTruthy();
      });
      expect(document.querySelector(".messages-control-layer")).toBeNull();
    } finally {
      host.remove();
    }
  });

  it("does not render CLI assistant message headers", () => {
    const items: ConversationItem[] = [
      {
        id: "assistant-cli-time",
        kind: "message",
        role: "assistant",
        text: "Readable output",
        createdAt: new Date("2026-07-07T15:21:59").getTime(),
      },
    ];

    const { container } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        messageReadingStyle="cli"
      />,
    );

    expect(container.querySelector(".messages-view")?.className).toContain(
      "messages-reading-native",
    );
    expect(
      container
        .querySelector(".message.assistant .message-bubble")
        ?.getAttribute("data-cli-timestamp"),
    ).toBeNull();
  });

  it("shows interrupted status on the latest assistant message without replacing content", () => {
    const items: ConversationItem[] = [
      {
        id: "assistant-before-stop",
        kind: "message",
        role: "assistant",
        text: "最后一段流式输出",
        createdAt: new Date("2026-07-07T15:21:59").getTime(),
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        messageReadingStyle="cli"
        interruptedStatus={{ timestamp: Date.now() }}
      />,
    );

    expect(screen.getByText("最后一段流式输出")).toBeTruthy();
    expect(screen.getByText("Session stopped.")).toBeTruthy();
  });

  it("does not expose conversation color style controls", () => {
    const onUpdateConversationStyle = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "msg-style-popover",
        kind: "message",
        role: "assistant",
        text: "Readable output",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        messageCanvasColor="#f6f8fa"
        messageUserBubbleColor="#ffffff"
        messageUserTextColor="#0f1720"
        messageAssistantBubbleColor="#ffffff"
        messageAssistantAccentColor="#127e66"
        messageAssistantTextColor="#233141"
        onUpdateConversationStyle={onUpdateConversationStyle}
      />,
    );

    expect(screen.queryByRole("button", { name: "样式" })).toBeNull();
    expect(screen.queryByRole("button", { name: /黑橙/ })).toBeNull();
    expect(screen.queryByDisplayValue("#ffffff")).toBeNull();
    expect(onUpdateConversationStyle).not.toHaveBeenCalled();
    expect(screen.queryByText("字体")).toBeNull();
    expect(screen.queryByText(/字号/)).toBeNull();
    expect(screen.queryByText(/字重/)).toBeNull();
  });

  it("re-pins to bottom on thread switch even when previous thread was scrolled up", () => {
    const items: ConversationItem[] = [
      {
        id: "msg-shared",
        kind: "message",
        role: "assistant",
        text: "Shared tail",
      },
    ];

    const { container, rerender } = render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const messagesNode = container.querySelector(".messages.messages-full");
    expect(messagesNode).toBeTruthy();
    const scrollNode = messagesNode as HTMLDivElement;

    Object.defineProperty(scrollNode, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollNode, "scrollHeight", {
      configurable: true,
      value: 600,
    });
    scrollNode.scrollTop = 100;
    fireEvent.scroll(scrollNode);

    Object.defineProperty(scrollNode, "scrollHeight", {
      configurable: true,
      value: 900,
    });

    rerender(
      <Messages
        items={items}
        threadId="thread-2"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(scrollNode.scrollTop).toBe(900);
  });

  it("pins to the latest batch when history arrives after a thread switch", () => {
    const onUpdateConversationStyle = vi.fn();
    const { container, rerender } = render(
      <Messages
        items={[]}
        threadId="thread-loading"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        chatHistoryScrollbackItems={20}
        onUpdateConversationStyle={onUpdateConversationStyle}
      />,
    );

    const scrollNode = container.querySelector(
      ".messages.messages-full",
    ) as HTMLDivElement;
    let scrollHeight = 0;
    Object.defineProperty(scrollNode, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    const loadedItems: ConversationItem[] = Array.from(
      { length: 60 },
      (_, index) => ({
        id: `async-msg-${index}`,
        kind: "message",
        role: "assistant",
        text: `Async message ${index}`,
      }),
    );
    scrollHeight = 1200;

    rerender(
      <Messages
        items={loadedItems}
        threadId="thread-loading"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        chatHistoryScrollbackItems={20}
        onUpdateConversationStyle={onUpdateConversationStyle}
      />,
    );

    expect(screen.queryByText("Async message 0")).toBeNull();
    expect(screen.getByText("Async message 59")).toBeTruthy();
    expect(scrollNode.scrollTop).toBe(1200);

    const controlLayer = container.querySelector(".messages-control-layer");
    const controls = screen.getByLabelText("工具调用自动收起");
    expect(controlLayer).toBeTruthy();
    expect(controlLayer?.contains(controls)).toBe(true);
    expect(scrollNode.contains(controls)).toBe(false);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    const search = screen.getByRole("search");
    expect(controlLayer?.contains(search)).toBe(true);
    expect(scrollNode.contains(search)).toBe(false);
    expect(screen.queryByRole("dialog", { name: "对话样式" })).toBeNull();
  });

  it("does not invent a CLI timestamp when a historical message has no trusted time", () => {
    const { container } = render(
      <Messages
        items={[
          {
            id: "historical-message-without-time",
            kind: "message",
            role: "assistant",
            text: "Historical response.",
          },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        messageReadingStyle="cli"
      />,
    );

    expect(
      container
        .querySelector(".message-bubble")
        ?.getAttribute("data-cli-timestamp"),
    ).toBeNull();
  });

  it("keeps the latest content pinned when message layout grows after opening", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = observe;
        unobserve = vi.fn();
        disconnect = disconnect;
      },
    );
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    const { container } = render(
      <Messages
        items={[
          { id: "msg-1", kind: "message", role: "assistant", text: "Latest" },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const scrollNode = container.querySelector(
      ".messages.messages-full",
    ) as HTMLDivElement;
    let scrollHeight = 600;
    Object.defineProperty(scrollNode, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    scrollNode.scrollTop = 600;
    scrollHeight = 900;

    (resizeCallback as ResizeObserverCallback | null)?.(
      [],
      {} as ResizeObserver,
    );

    expect(observe).toHaveBeenCalled();
    expect(scrollNode.scrollTop).toBe(900);

    requestAnimationFrameSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("does not reclaim scroll position after the user scrolls away from latest", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    const { container } = render(
      <Messages
        items={[
          { id: "msg-1", kind: "message", role: "assistant", text: "Latest" },
        ]}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const scrollNode = container.querySelector(
      ".messages.messages-full",
    ) as HTMLDivElement;
    Object.defineProperty(scrollNode, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollNode, "scrollHeight", {
      configurable: true,
      value: 900,
    });
    scrollNode.scrollTop = 200;
    fireEvent.scroll(scrollNode);

    (resizeCallback as ResizeObserverCallback | null)?.(
      [],
      {} as ResizeObserver,
    );

    expect(scrollNode.scrollTop).toBe(200);

    requestAnimationFrameSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows a plan-ready follow-up prompt after a completed plan tool item", () => {
    const onPlanAccept = vi.fn();
    const onPlanSubmitChanges = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "plan-1",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "completed",
        status: "completed",
        output: "- Step 1",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onPlanAccept={onPlanAccept}
        onPlanSubmitChanges={onPlanSubmitChanges}
      />,
    );

    expect(screen.getByText("计划已就绪")).toBeTruthy();
    expect(screen.getByRole("button", { name: "执行这个计划" })).toBeTruthy();
  });

  it("exports plan tool-call output from the conversation view", async () => {
    exportMarkdownFileMock.mockResolvedValueOnce("/tmp/plan-7.md");
    const items: ConversationItem[] = [
      {
        id: "plan-7",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "completed",
        status: "completed",
        output: "## Steps\n- Step 1",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    const exportButton = await screen.findByRole("button", {
      name: "Export .md",
    });
    fireEvent.click(exportButton);

    await waitFor(() =>
      expect(exportMarkdownFileMock).toHaveBeenCalledWith(
        "## Steps\n- Step 1",
        "plan-7.md",
      ),
    );
  });

  it("hides the plan-ready follow-up once the user has replied after the plan", () => {
    const onPlanAccept = vi.fn();
    const onPlanSubmitChanges = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "plan-2",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "completed",
        status: "completed",
        output: "Plan text",
      },
      {
        id: "user-after-plan",
        kind: "message",
        role: "user",
        text: "OK",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onPlanAccept={onPlanAccept}
        onPlanSubmitChanges={onPlanSubmitChanges}
      />,
    );

    expect(screen.queryByText("Plan ready")).toBeNull();
  });

  it("hides the plan-ready follow-up when the plan tool item is still running", () => {
    const onPlanAccept = vi.fn();
    const onPlanSubmitChanges = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "plan-3",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "Generating plan...",
        status: "in_progress",
        output: "Partial plan",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={true}
        openTargets={[]}
        selectedOpenAppId=""
        onPlanAccept={onPlanAccept}
        onPlanSubmitChanges={onPlanSubmitChanges}
      />,
    );

    expect(screen.queryByText("Plan ready")).toBeNull();
  });

  it("shows the plan-ready follow-up once the turn stops thinking even if the plan status stays in_progress", () => {
    const onPlanAccept = vi.fn();
    const onPlanSubmitChanges = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "plan-stuck-in-progress",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "Generating plan...",
        status: "in_progress",
        output: "Plan text",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onPlanAccept={onPlanAccept}
        onPlanSubmitChanges={onPlanSubmitChanges}
      />,
    );

    expect(screen.getByText("计划已就绪")).toBeTruthy();
  });

  it("calls the plan follow-up callbacks", () => {
    const onPlanAccept = vi.fn();
    const onPlanSubmitChanges = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "plan-4",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "completed",
        status: "completed",
        output: "Plan text",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onPlanAccept={onPlanAccept}
        onPlanSubmitChanges={onPlanSubmitChanges}
      />,
    );

    const sendChangesButton = screen.getByRole("button", {
      name: "发送修改意见",
    });
    expect((sendChangesButton as HTMLButtonElement).disabled).toBe(true);

    const textarea =
      screen.getByPlaceholderText("描述你想修改计划中的哪些内容...");
    fireEvent.change(textarea, { target: { value: "Add error handling" } });

    expect((sendChangesButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendChangesButton);
    expect(onPlanSubmitChanges).toHaveBeenCalledWith("Add error handling");
    expect(screen.queryByText("计划已就绪")).toBeNull();
  });

  it("dismisses the plan-ready follow-up when the plan is accepted", () => {
    const onPlanAccept = vi.fn();
    const onPlanSubmitChanges = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "plan-accept",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "completed",
        status: "completed",
        output: "Plan text",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onPlanAccept={onPlanAccept}
        onPlanSubmitChanges={onPlanSubmitChanges}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "执行这个计划" }));
    expect(onPlanAccept).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("计划已就绪")).toBeNull();
  });

  it("does not render plan-ready tagged internal user messages", () => {
    const onPlanAccept = vi.fn();
    const onPlanSubmitChanges = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "plan-6",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "completed",
        status: "completed",
        output: "Plan text",
      },
      {
        id: "internal-user",
        kind: "message",
        role: "user",
        text: "[[cm_plan_ready:accept]] Implement this plan.",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        onPlanAccept={onPlanAccept}
        onPlanSubmitChanges={onPlanSubmitChanges}
      />,
    );

    expect(screen.queryByText(/cm_plan_ready/)).toBeNull();
    expect(screen.queryByText("Plan ready")).toBeNull();
  });

  it("hides the plan follow-up when an input-requested bubble is active", () => {
    const onPlanAccept = vi.fn();
    const onPlanSubmitChanges = vi.fn();
    const items: ConversationItem[] = [
      {
        id: "plan-5",
        kind: "tool",
        toolType: "plan",
        title: "Plan",
        detail: "completed",
        status: "completed",
        output: "Plan text",
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
        userInputRequests={[
          {
            workspace_id: "ws-1",
            request_id: 1,
            params: {
              thread_id: "thread-1",
              turn_id: "turn-1",
              item_id: "item-1",
              questions: [],
            },
          },
        ]}
        onUserInputSubmit={vi.fn()}
        onPlanAccept={onPlanAccept}
        onPlanSubmitChanges={onPlanSubmitChanges}
      />,
    );

    expect(screen.getByText("Input requested")).toBeTruthy();
    expect(screen.queryByText("Plan ready")).toBeNull();
  });

  it("renders hook rows through the standard tool renderer", () => {
    const items: ConversationItem[] = [
      {
        id: "hook-hook-1",
        kind: "tool",
        toolType: "hook",
        title: "Hook: session-start",
        detail: "command • sync • thread • session-start.sh • Preparing",
        status: "failed",
        output: "[error] Missing config",
        durationMs: 3100,
      },
    ];

    render(
      <Messages
        items={items}
        threadId="thread-1"
        workspaceId="ws-1"
        isThinking={false}
        openTargets={[]}
        selectedOpenAppId=""
      />,
    );

    expect(screen.getByText("hook:")).toBeTruthy();
    expect(screen.getByText("session-start")).toBeTruthy();
    expect(screen.getByText("failed • 0:03")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle tool details" }),
    );
    expect(
      screen.getByText(
        "command • sync • thread • session-start.sh • Preparing",
      ),
    ).toBeTruthy();
    expect(screen.getByText("[error] Missing config")).toBeTruthy();
  });
});
