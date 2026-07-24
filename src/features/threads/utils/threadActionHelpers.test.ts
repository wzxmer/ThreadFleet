import { describe, expect, it } from "vitest";
import type { ConversationItem } from "@/types";
import { buildResumeHydrationPlan } from "./threadActionHelpers";

describe("buildResumeHydrationPlan", () => {
  it("clears local items when replaceLocal receives empty server history", () => {
    const localItems: ConversationItem[] = [
      { id: "stale-user", kind: "message", role: "user", text: "retry" },
    ];

    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: null,
      localItems,
      localStatus: undefined,
      replaceLocal: true,
      thread: { id: "thread-1", turns: [] },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.mergedItems).toEqual([]);
  });

  it("reports the latest matching terminal turn for execution reconciliation", () => {
    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: "turn-2",
      localItems: [],
      localStatus: { isProcessing: true },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          { id: "turn-1", status: "completed", items: [] },
          { id: "turn-2", status: "done", items: [] },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.terminalTurnId).toBe("turn-2");
    expect(plan.terminalTurnStatus).toBe("completed");
  });

  it("does not report a terminal turn when the latest turn is active", () => {
    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: "turn-local",
      localItems: [],
      localStatus: { isProcessing: true },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          { id: "turn-1", status: "completed", items: [] },
          { id: "turn-2", status: "inProgress", items: [] },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.terminalTurnId).toBeNull();
    expect(plan.terminalTurnStatus).toBeNull();
  });

  it("does not fall back to an older terminal turn past an unknown latest turn", () => {
    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: "turn-local",
      localItems: [],
      localStatus: { isProcessing: true },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          { id: "turn-1", status: "completed", items: [] },
          { id: "turn-2", status: "unknown_state", items: [] },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.terminalTurnId).toBeNull();
    expect(plan.terminalTurnStatus).toBeNull();
  });

  it("does not append stale local tools when resumed history uses new item ids", () => {
    const localItems: ConversationItem[] = [
      {
        id: "shared-user",
        kind: "message",
        role: "user",
        text: "检查问题",
        turnId: "turn-1",
      },
      {
        id: "local-tool-id",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: npm test",
        detail: "",
        status: "completed",
        turnId: "turn-1",
      },
    ];

    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: null,
      localItems,
      localStatus: { isProcessing: false },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "shared-user",
                type: "userMessage",
                content: [{ type: "text", text: "检查问题" }],
              },
              {
                id: "server-tool-id",
                type: "commandExecution",
                command: ["npm", "test"],
                status: "completed",
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.mergedItems.map((item) => item.id)).toEqual([
      "shared-user",
      "server-tool-id",
    ]);
  });

  it("keeps rollout-enriched tools inside their original turns when resume is lossy", () => {
    const localItems: ConversationItem[] = [
      {
        id: "user-1",
        kind: "message",
        role: "user",
        text: "第一轮",
        turnId: "turn-1",
      },
      {
        id: "rollout-tool-1",
        kind: "tool",
        toolType: "dynamicToolCall",
        title: "Tool: functions / exec",
        detail: '{"cmd":"npm test"}',
        status: "completed",
        turnId: "turn-1",
      },
      {
        id: "assistant-1",
        kind: "message",
        role: "assistant",
        text: "第一轮完成",
        turnId: "turn-1",
      },
      {
        id: "user-2",
        kind: "message",
        role: "user",
        text: "第二轮",
        turnId: "turn-2",
      },
      {
        id: "rollout-tool-2",
        kind: "tool",
        toolType: "dynamicToolCall",
        title: "Tool: functions / exec",
        detail: '{"cmd":"npm run typecheck"}',
        status: "completed",
        turnId: "turn-2",
      },
      {
        id: "assistant-2",
        kind: "message",
        role: "assistant",
        text: "第二轮完成",
        turnId: "turn-2",
      },
    ];

    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: null,
      localItems,
      localStatus: { isProcessing: false },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "user-1",
                type: "userMessage",
                content: [{ type: "text", text: "第一轮" }],
              },
              { id: "assistant-1", type: "agentMessage", text: "第一轮完成" },
            ],
          },
          {
            id: "turn-2",
            status: "completed",
            items: [
              {
                id: "user-2",
                type: "userMessage",
                content: [{ type: "text", text: "第二轮" }],
              },
              { id: "assistant-2", type: "agentMessage", text: "第二轮完成" },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.mergedItems.map((item) => item.id)).toEqual([
      "user-1",
      "rollout-tool-1",
      "assistant-1",
      "user-2",
      "rollout-tool-2",
      "assistant-2",
    ]);
  });

  it("keeps the remote user echo authoritative when the local turn is not a stable superset", () => {
    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: "turn-1",
      localItems: [
        {
          id: "local-user-1",
          kind: "message",
          role: "user",
          text: "继续",
          turnId: "turn-1",
        },
        {
          id: "local-tool-1",
          kind: "tool",
          toolType: "dynamicToolCall",
          title: "Tool: functions / exec",
          detail: '{"cmd":"git status"}',
          status: "completed",
          turnId: "turn-1",
        },
      ],
      localStatus: { isProcessing: true },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: "inProgress",
            items: [
              {
                id: "server-user-1",
                type: "userMessage",
                content: [{ type: "text", text: "继续" }],
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.mergedItems.map((item) => item.id)).toEqual([
      "server-user-1",
      "local-tool-1",
    ]);
  });

  it("preserves unmatched local items from the active turn during resume", () => {
    const activeTool: ConversationItem = {
      id: "live-tool",
      kind: "tool",
      toolType: "commandExecution",
      title: "Command: npm test",
      detail: "",
      status: "in_progress",
      turnId: "turn-active",
    };

    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: "turn-active",
      localItems: [activeTool],
      localStatus: { isProcessing: false },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-active",
            status: "inProgress",
            items: [
              {
                id: "server-user",
                type: "userMessage",
                content: [{ type: "text", text: "运行测试" }],
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.mergedItems.map((item) => item.id)).toEqual([
      "server-user",
      "live-tool",
    ]);
  });

  it("preserves a local item from a turn missing in the resumed snapshot", () => {
    const pendingAssistant: ConversationItem = {
      id: "local-assistant",
      kind: "message",
      role: "assistant",
      text: "刚完成的回复",
      turnId: "turn-new",
    };

    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: null,
      localItems: [pendingAssistant],
      localStatus: { isProcessing: false },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-old",
            status: "completed",
            items: [
              {
                id: "old-assistant",
                type: "agentMessage",
                text: "旧回复",
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.mergedItems.map((item) => item.id)).toEqual([
      "old-assistant",
      "local-assistant",
    ]);
  });

  it("preserves an unmatched completed tool omitted from resumed history", () => {
    const omittedTool: ConversationItem = {
      id: "local-omitted-tool",
      kind: "tool",
      toolType: "dynamicToolCall",
      title: "Tool: functions / exec",
      detail: '{"cmd":"npm test"}',
      status: "completed",
      turnId: "turn-1",
    };

    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: null,
      localItems: [
        {
          id: "shared-user",
          kind: "message",
          role: "user",
          text: "运行测试",
          turnId: "turn-1",
        },
        omittedTool,
      ],
      localStatus: { isProcessing: false },
      replaceLocal: false,
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "shared-user",
                type: "userMessage",
                content: [{ type: "text", text: "运行测试" }],
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.mergedItems.map((item) => item.id)).toEqual([
      "shared-user",
      "local-omitted-tool",
    ]);
  });
});
