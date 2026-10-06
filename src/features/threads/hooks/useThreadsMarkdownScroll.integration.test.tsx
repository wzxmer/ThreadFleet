// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerEvent, WorkspaceInfo } from "@/types";
import { Messages } from "@/features/messages/components/Messages";
import { subscribeAppServerEvents } from "@services/events";
import { useThreads } from "./useThreads";

vi.mock("@services/events", () => ({
  subscribeAppServerEvents: vi.fn(),
}));

vi.mock("@services/tauri", () => ({
  respondToServerRequest: vi.fn(),
  respondToUserInputRequest: vi.fn(),
  rememberApprovalRule: vi.fn(),
  sendUserMessage: vi.fn(),
  workflowPreflightPreview: vi.fn().mockResolvedValue({
    mode: "shadow",
    providerKind: "openai",
    model: null,
    taskLength: 0,
    rules: [],
    knowledgeCandidates: [],
    impacts: [],
    impactSummary: "",
    sourceErrors: [],
    knowledgeCacheHit: false,
    contextFragments: [],
  }),
  steerTurn: vi.fn(),
  startReview: vi.fn(),
  startThread: vi.fn(),
  listThreads: vi.fn().mockResolvedValue([]),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  resumeThread: vi.fn().mockResolvedValue({ result: { thread: { turns: [] } } }),
  readThread: vi.fn(),
  archiveThread: vi.fn(),
  generateRunMetadata: vi.fn(),
  setThreadName: vi.fn(),
  getAccountRateLimits: vi.fn(),
  getAccountInfo: vi.fn(),
  interruptTurn: vi.fn(),
}));

const workspace: WorkspaceInfo = {
  id: "ws-1",
  name: "ThreadFleet",
  path: "/tmp/codex",
  connected: true,
  settings: { sidebarCollapsed: false },
};

let listener: ((event: AppServerEvent) => void) | null = null;
let setActiveThreadId: ((threadId: string | null) => void) | null = null;

function ThreadsMessagesHarness() {
  const threads = useThreads({
    activeWorkspace: workspace,
    onWorkspaceConnected: vi.fn(),
  });
  useEffect(() => {
    setActiveThreadId = threads.setActiveThreadId;
  }, [threads.setActiveThreadId]);

  return (
    <Messages
      items={threads.activeItems}
      threadId={threads.activeThreadId}
      workspaceId={workspace.id}
      isThinking={threads.threadStatusById[threads.activeThreadId ?? ""]?.isProcessing ?? false}
      openTargets={[]}
      selectedOpenAppId=""
    />
  );
}

describe("useThreads app-server markdown DOM state", () => {
  beforeEach(() => {
    listener = null;
    setActiveThreadId = null;
    vi.mocked(subscribeAppServerEvents).mockImplementation((callback) => {
      listener = callback;
      return vi.fn();
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps session 2 code block scroll state when session 1 runs, completes, and is interrupted", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThreadsMessagesHarness />);
    });
    expect(listener).toBeTypeOf("function");

    const send = (method: string, params: Record<string, unknown>) => {
      act(() => {
        listener?.({ workspace_id: workspace.id, message: { method, params } });
      });
    };

    send("thread/started", { thread: { id: "thread-1", preview: "Background" } });
    send("thread/started", { thread: { id: "thread-2", preview: "Visible" } });
    send("item/completed", {
      threadId: "thread-2",
      turnId: "turn-2",
      item: {
        type: "agentMessage",
        id: "thread-2-wide-code-block",
        text: [
          "```text",
          "D:/DevKnowledgeBase/20-项目知识/ThreadFleet/BUG/ThreadFleet-Markdown表格横向滚动位置被重置.md",
          "Use diagnose and ui-regression-guardian to verify the visible code block scroll state.",
          "```",
        ].join("\n"),
      },
    });
    act(() => {
      setActiveThreadId?.("thread-2");
    });

    const codeBlockScroller = container.querySelector<HTMLElement>(".markdown-codeblock pre");
    expect(codeBlockScroller).not.toBeNull();
    if (!codeBlockScroller) {
      throw new Error("Expected session 2 markdown code block scroller");
    }
    Object.defineProperties(codeBlockScroller, {
      clientWidth: { configurable: true, value: 480 },
      scrollWidth: { configurable: true, value: 1200 },
    });
    codeBlockScroller.scrollLeft = 240;

    const assertScrollState = () => {
      const currentScroller = container.querySelector<HTMLElement>(".markdown-codeblock pre");
      expect(currentScroller).toBe(codeBlockScroller);
      expect(currentScroller?.scrollLeft).toBe(240);
      expect(currentScroller?.scrollWidth).toBe(1200);
      expect(currentScroller?.clientWidth).toBe(480);
    };

    send("item/agentMessage/delta", {
      threadId: "thread-1",
      itemId: "thread-1-live-message",
      delta: "Still running",
    });
    assertScrollState();

    send("turn/completed", { threadId: "thread-1", turnId: "turn-1" });
    assertScrollState();

    send("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "interrupted" },
    });
    assertScrollState();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps session 2 image nodes when session 1 runs, completes, and is interrupted", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThreadsMessagesHarness />);
    });
    expect(listener).toBeTypeOf("function");

    const send = (method: string, params: Record<string, unknown>) => {
      act(() => {
        listener?.({ workspace_id: workspace.id, message: { method, params } });
      });
    };

    send("thread/started", { thread: { id: "thread-1", preview: "Background" } });
    send("thread/started", { thread: { id: "thread-2", preview: "Visible" } });
    send("item/completed", {
      threadId: "thread-2",
      turnId: "turn-2",
      item: {
        type: "agentMessage",
        id: "thread-2-images",
        text: [
          "![first](https://example.com/first.png)",
          "",
          "![second](https://example.com/second.png)",
          "",
          "[![linked](https://example.com/preview.png)](https://example.com/full-size.png)",
        ].join("\n"),
      },
    });
    act(() => {
      setActiveThreadId?.("thread-2");
    });

    const images = Array.from(container.querySelectorAll(".markdown img"));
    expect(images).toHaveLength(3);

    const assertImageState = () => {
      const currentImages = Array.from(container.querySelectorAll(".markdown img"));
      expect(currentImages).toHaveLength(3);
      images.forEach((image, index) => {
        expect(currentImages[index]).toBe(image);
        expect(container.contains(image)).toBe(true);
      });
    };

    send("item/agentMessage/delta", {
      threadId: "thread-1",
      itemId: "thread-1-live-message",
      delta: "Still running",
    });
    assertImageState();

    send("turn/completed", { threadId: "thread-1", turnId: "turn-1" });
    assertImageState();

    send("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "interrupted" },
    });
    assertImageState();

    await act(async () => {
      root.unmount();
    });
  });
});
