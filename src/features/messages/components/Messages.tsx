import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Search from "lucide-react/dist/esm/icons/search";
import X from "lucide-react/dist/esm/icons/x";
import type {
  ComposerSendShortcut,
  ConversationItem,
  MessageReadingStyle,
  OpenAppTarget,
  RequestUserInputRequest,
  RequestUserInputResponse,
  SendMessageResult,
  ThemePreference,
  TurnExecutionSummary,
} from "../../../types";
import { PlanReadyFollowupMessage } from "../../app/components/PlanReadyFollowupMessage";
import { RequestUserInputMessage } from "../../app/components/RequestUserInputMessage";
import { useFileLinkOpener } from "../hooks/useFileLinkOpener";
import {
  formatCount,
  countApplyPatchLineChanges,
  countDiffLineChanges,
  getConversationItemSearchText,
  parseReasoning,
  type MessageListBaseEntry,
  type MessageListEntry,
} from "../utils/messageRenderUtils";
import {
  toMarkdownQuote,
  type MessageReferenceAction,
} from "../utils/messageReferences";
import { useI18n } from "@/features/i18n/I18nProvider";
import {
  DiffRow,
  ExploreRow,
  MessageRow,
  ProcessMessageRow,
  ProcessRow,
  ReasoningRow,
  ReviewRow,
  SubagentCheckpointRow,
  ToolRow,
  UserInputRow,
  WorkingIndicator,
  type AssistantMessageMeta,
  type AssistantProcessDisclosure,
  type RepeatedErrorDisclosure,
} from "./MessageRows";
import { SubagentResultSummary } from "./SubagentResultSummary";
import { useMessagesViewState } from "./useMessagesViewState";
import type { SubagentResultSummary as SubagentResultSummaryData } from "../utils/subagentResults";
import { ConversationExportControls } from "../export/ConversationExportControls";
import { useConversationExport } from "../export/useConversationExport";
import type { ModelActivityState } from "@/features/models/components/ModelActivityCore";

type RepeatedErrorRun = {
  id: string;
  count: number;
  latestEntryIndex: number;
};

const EMPTY_REPEATED_ERROR_GROUPS = new Set<string>();

function getRepeatableErrorText(entry: MessageListEntry) {
  if (
    entry.kind !== "item" ||
    entry.item.kind !== "message" ||
    entry.item.role !== "assistant" ||
    (entry.item.images?.length ?? 0) > 0 ||
    (entry.item.attachments?.length ?? 0) > 0
  ) {
    return null;
  }
  const text = entry.item.text.trim();
  return text.startsWith("Turn failed") ? text : null;
}

function buildRepeatedErrorRuns(entries: MessageListEntry[]) {
  const runsByEntryIndex = new Map<number, RepeatedErrorRun>();
  let startIndex = 0;

  while (startIndex < entries.length) {
    const signature = getRepeatableErrorText(entries[startIndex]);
    if (!signature) {
      startIndex += 1;
      continue;
    }

    let endIndex = startIndex + 1;
    while (
      endIndex < entries.length &&
      getRepeatableErrorText(entries[endIndex]) === signature
    ) {
      endIndex += 1;
    }

    if (endIndex - startIndex > 1) {
      const firstEntry = entries[startIndex];
      const run: RepeatedErrorRun = {
        id:
          firstEntry.kind === "item"
            ? `repeated-error-${firstEntry.item.id}`
            : `repeated-error-${startIndex}`,
        count: endIndex - startIndex,
        latestEntryIndex: endIndex - 1,
      };
      for (let index = startIndex; index < endIndex; index += 1) {
        runsByEntryIndex.set(index, run);
      }
    }
    startIndex = endIndex;
  }

  return runsByEntryIndex;
}

function getSearchTargetForEntry(entry: MessageListEntry) {
  if (entry.kind === "processGroup") {
    return `process-group-${entry.group.id}`;
  }
  if (entry.kind === "toolGroup") {
    return `tool-group-${entry.group.id}`;
  }
  return `item-${entry.item.id}`;
}

function baseEntryContainsItem(entry: MessageListBaseEntry, itemId: string) {
  return entry.kind === "toolGroup"
    ? entry.group.items.some((item) => item.id === itemId)
    : entry.item.id === itemId;
}

function entryContainsTurn(
  entry: MessageListEntry,
  turnChain: Set<string>,
): boolean {
  if (entry.kind === "item") {
    return entry.item.turnId ? turnChain.has(entry.item.turnId) : false;
  }
  if (entry.kind === "toolGroup") {
    return entry.group.items.some(
      (item) => item.turnId && turnChain.has(item.turnId),
    );
  }
  return entry.group.entries.some((child) =>
    entryContainsTurn(child, turnChain),
  );
}

function coalesceDenseProcessToolGroups(
  entries: MessageListBaseEntry[],
  processGroupId: string,
): MessageListBaseEntry[] {
  const toolGroups = entries.filter(
    (entry): entry is Extract<MessageListBaseEntry, { kind: "toolGroup" }> =>
      entry.kind === "toolGroup",
  );
  const itemCount = toolGroups.reduce(
    (total, entry) => total + entry.group.items.length,
    0,
  );
  if (toolGroups.length < 2 || itemCount < 4) {
    return entries;
  }
  const firstToolGroupIndex = entries.findIndex(
    (entry) => entry.kind === "toolGroup",
  );
  const combinedGroup: MessageListBaseEntry = {
    kind: "toolGroup",
    group: {
      id: `combined-${processGroupId}`,
      items: toolGroups.flatMap((entry) => entry.group.items),
      toolCount: toolGroups.reduce(
        (total, entry) => total + entry.group.toolCount,
        0,
      ),
      messageCount: toolGroups.reduce(
        (total, entry) => total + entry.group.messageCount,
        0,
      ),
    },
  };
  return entries.flatMap<MessageListBaseEntry>(
    (entry, index): MessageListBaseEntry[] => {
      if (entry.kind !== "toolGroup") {
        return [entry];
      }
      return index === firstToolGroupIndex ? [combinedGroup] : [];
    },
  );
}

function extractAssistantIdentity(content?: string | null) {
  const match = content?.match(
    /^(?:#{1,6}\s+)?Identity\s*:\s*(.+)$/im,
  );
  return match?.[1]?.replace(/[*_`]/g, "").trim() || null;
}

function resolveAssistantName(
  identity: string | null,
  modelId: string | null | undefined,
  modelOptions: AssistantModelOption[],
) {
  if (identity) {
    return identity;
  }
  const option = modelOptions.find(
    (candidate) => candidate.id === modelId || candidate.model === modelId,
  );
  const descriptor = [modelId, option?.model]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (descriptor.includes("claude") || descriptor.includes("anthropic")) {
    return "Claude";
  }
  if (
    descriptor.includes("gpt") ||
    descriptor.includes("codex") ||
    descriptor.includes("openai")
  ) {
    return "GPT";
  }
  return "Assistant";
}

type AssistantModelOption = {
  id: string;
  model: string;
  displayName: string;
};

function toolItemsForEntry(
  entry: MessageListEntry,
): Extract<ConversationItem, { kind: "tool" }>[] {
  if (entry.kind === "item") {
    return entry.item.kind === "tool" ? [entry.item] : [];
  }
  if (entry.kind === "toolGroup") {
    return entry.group.items.filter(
      (item): item is Extract<ConversationItem, { kind: "tool" }> =>
        item.kind === "tool",
    );
  }
  return entry.group.entries.flatMap((child) => toolItemsForEntry(child));
}

function addLineChangeStats(
  total: { additions: number; deletions: number },
  next: { additions: number; deletions: number } | null,
) {
  if (next) {
    total.additions += next.additions;
    total.deletions += next.deletions;
  }
}

function derivePersistedLineChangeStats(entry: MessageListEntry) {
  const tools = toolItemsForEntry(entry);
  const fileChangeStats = { additions: 0, deletions: 0 };
  let hasFileChangeDiff = false;
  tools.forEach((item) => {
    if (item.toolType !== "fileChange") {
      return;
    }
    const diffs =
      item.changes?.map((change) => change.diff ?? "").filter(Boolean) ?? [];
    const sourceDiffs =
      diffs.length > 0 ? diffs : item.output ? [item.output] : [];
    sourceDiffs.forEach((diff) => {
      const stats = countDiffLineChanges(diff);
      if (stats) {
        hasFileChangeDiff = true;
        addLineChangeStats(fileChangeStats, stats);
      }
    });
  });
  if (hasFileChangeDiff) {
    return fileChangeStats;
  }

  const patchStats = { additions: 0, deletions: 0 };
  let hasPatch = false;
  tools.forEach((item) => {
    if (item.toolType !== "dynamicToolCall") {
      return;
    }
    const stats =
      item.lineChangeStats ?? countApplyPatchLineChanges(item.detail);
    if (stats) {
      hasPatch = true;
      addLineChangeStats(patchStats, stats);
    }
  });
  return hasPatch ? patchStats : null;
}

function getSearchTargetForItem(entries: MessageListEntry[], itemId: string) {
  const entry = entries.find((candidate) => {
    if (candidate.kind === "processGroup") {
      return candidate.group.entries.some((processEntry) =>
        baseEntryContainsItem(processEntry, itemId),
      );
    }
    return baseEntryContainsItem(candidate, itemId);
  });
  return entry ? getSearchTargetForEntry(entry) : null;
}

const HISTORY_TOP_CONTINUED_SCROLL_THRESHOLD_PX = 24;

type MessagesProps = {
  items: ConversationItem[];
  threadId: string | null;
  workspaceId?: string | null;
  isThinking: boolean;
  activityState?: ModelActivityState;
  isLoadingMessages?: boolean;
  hasOlderHistory?: boolean;
  isLoadingOlderHistory?: boolean;
  onLoadOlderHistory?: () => Promise<boolean>;
  processingStartedAt?: number | null;
  lastDurationMs?: number | null;
  showPollingFetchStatus?: boolean;
  pollingIntervalMs?: number;
  workspacePath?: string | null;
  openTargets: OpenAppTarget[];
  selectedOpenAppId: string;
  codeBlockCopyUseModifier?: boolean;
  showMessageFilePath?: boolean;
  defaultToolGroupsCollapsed?: boolean;
  /** Legacy persisted setting. Runtime rendering is always native. */
  messageReadingStyle?: MessageReadingStyle;
  messageCanvasColor?: string;
  messageUserBubbleColor?: string;
  messageUserTextColor?: string;
  messageAssistantBubbleColor?: string;
  messageAssistantAccentColor?: string;
  messageAssistantTextColor?: string;
  assistantInstructionContent?: string | null;
  assistantFallbackModelId?: string | null;
  assistantModelOptions?: AssistantModelOption[];
  chatHistoryScrollbackItems?: number | null;
  interruptedStatus?: { timestamp: number } | null;
  activeTurnId?: string | null;
  activeTurnDiff?: string | null;
  turnExecutionSummary?: TurnExecutionSummary | null;
  turnExecutionSummaries?: TurnExecutionSummary[];
  onUpdateConversationStyle?: (next: {
    theme?: ThemePreference;
    messageReadingStyle?: MessageReadingStyle;
    messageCanvasColor?: string;
    messageUserBubbleColor?: string;
    messageUserTextColor?: string;
    messageAssistantBubbleColor?: string;
    messageAssistantAccentColor?: string;
    messageAssistantTextColor?: string;
    messageToolGroupsCollapsedByDefault?: boolean;
  }) => void;
  userInputRequests?: RequestUserInputRequest[];
  onUserInputSubmit?: (
    request: RequestUserInputRequest,
    response: RequestUserInputResponse,
  ) => void;
  onPlanAccept?: () => void;
  onPlanSubmitChanges?: (changes: string) => void;
  onOpenThreadLink?: (threadId: string, workspaceId?: string | null) => void;
  subagentResults?: SubagentResultSummaryData[];
  onQuoteMessage?: (text: string) => void;
  onReferenceMessage?: (action: MessageReferenceAction) => void;
  composerSendShortcut?: ComposerSendShortcut;
  onResendUserMessage?: (
    text: string,
    images?: string[],
    options?: { replaceMessageId?: string },
  ) => Promise<SendMessageResult>;
};

export function getRetryableUserMessageId(
  items: ConversationItem[],
  interruptedStatus?: { timestamp: number } | null,
) {
  let lastUserMessageId: string | null = null;
  for (const item of items) {
    if (item.kind !== "message") {
      continue;
    }
    if (item.role === "user") {
      lastUserMessageId = item.id;
    }
  }
  if (!lastUserMessageId) {
    return null;
  }
  if (interruptedStatus) {
    return lastUserMessageId;
  }
  const lastAssistantMessage = [...items]
    .reverse()
    .find(
      (item): item is Extract<ConversationItem, { kind: "message" }> =>
        item.kind === "message" && item.role === "assistant",
    );
  if (
    !lastAssistantMessage?.text.trim().startsWith("Turn failed") ||
    !lastAssistantMessage.turnId
  ) {
    return null;
  }
  const failedTurnUserMessage = [...items]
    .reverse()
    .find(
      (item): item is Extract<ConversationItem, { kind: "message" }> =>
        item.kind === "message" &&
        item.role === "user" &&
        item.turnId === lastAssistantMessage.turnId,
    );
  return failedTurnUserMessage?.id ?? null;
}

export const Messages = memo(function Messages({
  items,
  threadId,
  workspaceId = null,
  isThinking,
  activityState = "idle",
  isLoadingMessages = false,
  hasOlderHistory = false,
  isLoadingOlderHistory = false,
  onLoadOlderHistory,
  processingStartedAt = null,
  lastDurationMs = null,
  showPollingFetchStatus = false,
  pollingIntervalMs = 12000,
  workspacePath = null,
  openTargets,
  selectedOpenAppId,
  codeBlockCopyUseModifier = false,
  showMessageFilePath = true,
  defaultToolGroupsCollapsed = false,
  messageCanvasColor = "var(--surface-messages)",
  messageUserBubbleColor = "var(--surface-bubble-user)",
  messageUserTextColor = "var(--text-stronger)",
  messageAssistantBubbleColor = "var(--surface-card-strong)",
  messageAssistantAccentColor = "var(--border-accent-soft)",
  messageAssistantTextColor = "var(--text-stronger)",
  assistantInstructionContent = null,
  assistantFallbackModelId = null,
  assistantModelOptions = [],
  chatHistoryScrollbackItems = null,
  interruptedStatus = null,
  activeTurnId = null,
  activeTurnDiff = null,
  turnExecutionSummary = null,
  turnExecutionSummaries = [],
  onUpdateConversationStyle,
  userInputRequests = [],
  onUserInputSubmit,
  onPlanAccept,
  onPlanSubmitChanges,
  onOpenThreadLink,
  subagentResults = [],
  onQuoteMessage,
  onReferenceMessage,
  composerSendShortcut = "enter",
  onResendUserMessage,
}: MessagesProps) {
  const pendingOlderHistoryRestoreRef = useRef<{
    threadId: string | null;
    anchorKey: string;
    anchorTop: number;
    previousScrollTop: number;
  } | null>(null);
  const olderHistoryLoadInFlightRef = useRef(false);
  const olderHistoryRestoreFrameRef = useRef<number | null>(null);
  const currentThreadIdRef = useRef(threadId);
  currentThreadIdRef.current = threadId;
  const { t } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchThreadId, setSearchThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [searchNavigationVersion, setSearchNavigationVersion] = useState(0);
  const [repeatedErrorExpansion, setRepeatedErrorExpansion] = useState<{
    threadId: string | null;
    groupIds: Set<string>;
  }>(() => ({ threadId, groupIds: new Set() }));
  const expandedRepeatedErrorGroups =
    repeatedErrorExpansion.threadId === threadId
      ? repeatedErrorExpansion.groupIds
      : EMPTY_REPEATED_ERROR_GROUPS;
  const [resendViewSnapshot, setResendViewSnapshot] = useState<{
    threadId: string | null;
    messageId: string;
    items: ConversationItem[];
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchTargetRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const handledSearchNavigationVersionRef = useRef(0);
  const [headerToolsHost, setHeaderToolsHost] = useState<HTMLElement | null>(
    null,
  );
  const activeUserInputRequestId =
    threadId && userInputRequests.length
      ? (userInputRequests.find(
          (request) =>
            request.params.thread_id === threadId &&
            (!workspaceId || request.workspace_id === workspaceId),
        )?.request_id ?? null)
      : null;
  const { openFileLink, showFileLinkMenu } = useFileLinkOpener(
    workspacePath,
    openTargets,
    selectedOpenAppId,
  );
  const handleOpenThreadLink = useCallback(
    (threadId: string) => {
      onOpenThreadLink?.(threadId, workspaceId ?? null);
    },
    [onOpenThreadLink, workspaceId],
  );

  const resendViewItems =
    resendViewSnapshot?.threadId === threadId
      ? resendViewSnapshot.items
      : items;
  const handleResendUserMessage = useCallback(
    async (
      message: Extract<ConversationItem, { kind: "message" }>,
      text: string,
    ): Promise<SendMessageResult> => {
      if (!onResendUserMessage) {
        return { status: "blocked" };
      }
      setResendViewSnapshot({ threadId, messageId: message.id, items });
      try {
        return await onResendUserMessage(text, message.images ?? [], {
          replaceMessageId: message.id,
        });
      } finally {
        setResendViewSnapshot((current) =>
          current?.threadId === threadId && current.messageId === message.id
            ? null
            : current,
        );
      }
    },
    [items, onResendUserMessage, threadId],
  );

  const hasActiveUserInputRequest = activeUserInputRequestId !== null;
  const retryableUserMessageId = useMemo(
    () => getRetryableUserMessageId(resendViewItems, interruptedStatus),
    [interruptedStatus, resendViewItems],
  );
  const hasVisibleUserInputRequest =
    hasActiveUserInputRequest && Boolean(onUserInputSubmit);
  const userInputNode =
    hasActiveUserInputRequest && onUserInputSubmit ? (
      <RequestUserInputMessage
        requests={userInputRequests}
        activeThreadId={threadId}
        activeWorkspaceId={workspaceId}
        onSubmit={onUserInputSubmit}
      />
    ) : null;
  const {
    bottomRef,
    containerRef,
    updateAutoScroll,
    requestAutoScroll,
    showScrollToLatest,
    scrollToLatest,
    hiddenBeforeCount,
    hiddenAfterCount,
    loadEarlierHistory,
    loadLaterHistory,
    revealHistoryItemAtIndex,
    revealGroupedItem,
    expandedItems,
    toggleExpanded,
    collapsedToolGroups,
    toggleToolGroup,
    isToolGroupsAutoCollapsed,
    setToolGroupsAutoCollapsed,
    copiedMessageId,
    handleCopyMessage,
    reasoningMetaById,
    latestReasoningLabel,
    groupedItems,
    planFollowup,
    dismissPlanFollowup,
  } = useMessagesViewState({
    items: resendViewItems,
    threadId,
    activeTurnId,
    isThinking,
    activeUserInputRequestId,
    hasVisibleUserInputRequest,
    defaultToolGroupsCollapsed,
    chatHistoryScrollbackItems,
    onPlanAccept,
    onPlanSubmitChanges,
    onQuoteMessage,
  });
  const conversationExport = useConversationExport({
    items: resendViewItems,
    summaries: turnExecutionSummaries,
    threadId,
  });
  const repeatedErrorRunsByEntryIndex = useMemo(
    () => buildRepeatedErrorRuns(groupedItems),
    [groupedItems],
  );
  const toggleRepeatedErrorGroup = useCallback((groupId: string) => {
    setRepeatedErrorExpansion((current) => {
      const next = new Set(
        current.threadId === threadId ? current.groupIds : [],
      );
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return { threadId, groupIds: next };
    });
  }, [threadId]);
  useEffect(
    () => () => {
      if (olderHistoryRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(olderHistoryRestoreFrameRef.current);
      }
    },
    [],
  );
  const handleLoadOlderHistory = useCallback(async () => {
    if (
      !onLoadOlderHistory ||
      isLoadingOlderHistory ||
      olderHistoryLoadInFlightRef.current
    ) {
      return;
    }
    const container = containerRef.current;
    const anchor = container?.querySelector<HTMLElement>("[data-history-anchor]");
    const restore =
      container && anchor
        ? {
            threadId,
            anchorKey: anchor.dataset.historyAnchor ?? "",
            anchorTop: anchor.getBoundingClientRect().top,
            previousScrollTop: container.scrollTop,
          }
        : null;
    pendingOlderHistoryRestoreRef.current = restore;
    olderHistoryLoadInFlightRef.current = true;
    try {
      const loaded = await onLoadOlderHistory();
      if (!loaded) {
        if (pendingOlderHistoryRestoreRef.current === restore) {
          pendingOlderHistoryRestoreRef.current = null;
        }
        return;
      }
      if (
        !restore ||
        pendingOlderHistoryRestoreRef.current !== restore ||
        currentThreadIdRef.current !== restore.threadId
      ) {
        if (pendingOlderHistoryRestoreRef.current === restore) {
          pendingOlderHistoryRestoreRef.current = null;
        }
        return;
      }
      olderHistoryRestoreFrameRef.current = window.requestAnimationFrame(() => {
        olderHistoryRestoreFrameRef.current = null;
        const pendingRestore = pendingOlderHistoryRestoreRef.current;
        const currentContainer = containerRef.current;
        if (
          pendingRestore !== restore ||
          !currentContainer ||
          currentThreadIdRef.current !== restore.threadId ||
          Math.abs(currentContainer.scrollTop - restore.previousScrollTop) > 1
        ) {
          if (pendingRestore === restore) {
            pendingOlderHistoryRestoreRef.current = null;
          }
          return;
        }
        const currentAnchor = Array.from(
          currentContainer.querySelectorAll<HTMLElement>(
            "[data-history-anchor]",
          ),
        ).find((node) => node.dataset.historyAnchor === restore.anchorKey);
        if (!currentAnchor) {
          pendingOlderHistoryRestoreRef.current = null;
          return;
        }
        const anchorOffset =
          currentAnchor.getBoundingClientRect().top - restore.anchorTop;
        if (anchorOffset > 0) {
          currentContainer.scrollTop = restore.previousScrollTop + anchorOffset;
        }
        pendingOlderHistoryRestoreRef.current = null;
      });
    } finally {
      olderHistoryLoadInFlightRef.current = false;
    }
  }, [containerRef, isLoadingOlderHistory, onLoadOlderHistory, threadId]);
  const handleMessagesWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (event.deltaY >= 0) {
        return;
      }
      const container = containerRef.current;
      if (
        !container ||
        container.scrollTop > HISTORY_TOP_CONTINUED_SCROLL_THRESHOLD_PX
      ) {
        return;
      }
      if (hiddenBeforeCount > 0) {
        loadEarlierHistory();
        return;
      }
      if (hasOlderHistory) {
        void handleLoadOlderHistory();
      }
    },
    [
      containerRef,
      handleLoadOlderHistory,
      hasOlderHistory,
      hiddenBeforeCount,
      loadEarlierHistory,
    ],
  );
  const exportableMessageIds = useMemo(
    () =>
      new Set(
        resendViewItems.flatMap((item) =>
          item.kind === "message" &&
          (item.role === "user" || item.role === "assistant")
            ? [item.id]
            : [],
        ),
      ),
    [resendViewItems],
  );
  const handleReferenceMessage = useCallback(
    (action: MessageReferenceAction) => {
      if (onReferenceMessage) {
        onReferenceMessage(action);
        return;
      }
      if (action.destination === "current" && onQuoteMessage) {
        onQuoteMessage(
          toMarkdownQuote(action.selectedText ?? action.sourceText),
        );
      }
    },
    [onQuoteMessage, onReferenceMessage],
  );
  const isSearchActiveForThread = searchOpen && searchThreadId === threadId;
  const searchMatches = useMemo(() => {
    if (!isSearchActiveForThread) {
      return [];
    }
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return [];
    }
    return items.flatMap((item, itemIndex) =>
      getConversationItemSearchText(item).toLowerCase().includes(query)
        ? [{ itemId: item.id, itemIndex }]
        : [],
    );
  }, [isSearchActiveForThread, items, searchQuery]);
  const activeSearchMatch =
    searchMatches.length > 0
      ? searchMatches[Math.min(activeSearchIndex, searchMatches.length - 1)]
      : null;
  const activeSearchTargetId = activeSearchMatch
    ? getSearchTargetForItem(groupedItems, activeSearchMatch.itemId)
    : null;
  const activeSearchDisplayIndex =
    searchMatches.length > 0
      ? Math.min(activeSearchIndex, searchMatches.length - 1) + 1
      : 0;
  const assistantActivityStateByTurnId = useMemo(() => {
    const states = new Map<string, ModelActivityState>();
    const summaries =
      turnExecutionSummaries.length > 0
        ? turnExecutionSummaries
        : turnExecutionSummary
          ? [turnExecutionSummary]
          : [];
    summaries.forEach((summary) => {
      const state: ModelActivityState =
        summary.status === "active"
          ? activityState
          : summary.status === "completed"
            ? "completed"
            : "failed";
      summary.turnChain.forEach((turnId) => states.set(turnId, state));
      states.set(summary.turnId, state);
    });
    return states;
  }, [activityState, turnExecutionSummaries, turnExecutionSummary]);
  useEffect(() => {
    setSearchOpen(false);
    setSearchThreadId(null);
    setSearchQuery("");
    setActiveSearchIndex(0);
  }, [threadId]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [searchOpen]);

  useEffect(() => {
    const syncHeaderToolsHost = () => {
      setHeaderToolsHost(
        document.querySelector<HTMLElement>(".main-header-message-tools"),
      );
    };
    syncHeaderToolsHost();
    const frame = window.requestAnimationFrame(syncHeaderToolsHost);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!activeSearchMatch) {
      return;
    }
    revealHistoryItemAtIndex(activeSearchMatch.itemIndex);
    revealGroupedItem(activeSearchMatch.itemId);
  }, [activeSearchMatch, revealGroupedItem, revealHistoryItemAtIndex]);

  useEffect(() => {
    if (handledSearchNavigationVersionRef.current === searchNavigationVersion) {
      return;
    }
    if (!isSearchActiveForThread || !activeSearchTargetId) {
      return;
    }
    const node = searchTargetRefs.current[activeSearchTargetId];
    if (!node) {
      return;
    }
    handledSearchNavigationVersionRef.current = searchNavigationVersion;
    const frameId = window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeSearchTargetId, isSearchActiveForThread, searchNavigationVersion]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "f") {
        event.preventDefault();
        if (searchThreadId !== threadId) {
          setSearchThreadId(threadId);
          setSearchQuery("");
          setActiveSearchIndex(0);
        }
        setSearchOpen(true);
        return;
      }
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen, searchThreadId, threadId]);

  const registerSearchTarget = useCallback(
    (id: string) => (node: HTMLDivElement | null) => {
      if (node) {
        searchTargetRefs.current[id] = node;
      } else {
        delete searchTargetRefs.current[id];
      }
    },
    [],
  );

  const moveSearch = useCallback(
    (direction: 1 | -1) => {
      if (searchMatches.length === 0) {
        return;
      }
      setActiveSearchIndex(
        (current) =>
          (current + direction + searchMatches.length) % searchMatches.length,
      );
      setSearchNavigationVersion((current) => current + 1);
    },
    [searchMatches.length],
  );

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
    setActiveSearchIndex(0);
    setSearchNavigationVersion((current) => current + 1);
  }, []);

  const handleSearchInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        moveSearch(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setSearchOpen(false);
      }
    },
    [moveSearch],
  );
  const messagesStyle = useMemo(
    () =>
      ({
        "--conversation-canvas": messageCanvasColor,
        "--conversation-user-color": messageUserBubbleColor,
        "--conversation-user-text": messageUserTextColor,
        "--conversation-assistant-bg": messageAssistantBubbleColor,
        "--conversation-assistant-accent": messageAssistantAccentColor,
        "--conversation-assistant-text": messageAssistantTextColor,
      }) as CSSProperties,
    [
      messageAssistantAccentColor,
      messageAssistantBubbleColor,
      messageAssistantTextColor,
      messageCanvasColor,
      messageUserBubbleColor,
      messageUserTextColor,
    ],
  );

  const updateConversationStyle = useCallback(
    (next: Parameters<NonNullable<typeof onUpdateConversationStyle>>[0]) => {
      onUpdateConversationStyle?.(next);
    },
    [onUpdateConversationStyle],
  );

  const toggleToolAutoCollapse = useCallback(() => {
    const nextValue = !isToolGroupsAutoCollapsed;
    setToolGroupsAutoCollapsed(nextValue);
    updateConversationStyle({
      messageToolGroupsCollapsedByDefault: nextValue,
    });
  }, [
    isToolGroupsAutoCollapsed,
    setToolGroupsAutoCollapsed,
    updateConversationStyle,
  ]);

  const planFollowupNode =
    planFollowup.shouldShow && onPlanAccept && onPlanSubmitChanges ? (
      <PlanReadyFollowupMessage
        onAccept={() => {
          dismissPlanFollowup();
          onPlanAccept();
        }}
        onSubmitChanges={(changes) => {
          dismissPlanFollowup();
          onPlanSubmitChanges(changes);
        }}
      />
    ) : null;
  const stoppedAssistantMessageId = useMemo(() => {
    if (!interruptedStatus) {
      return null;
    }
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const candidate = items[index];
      if (candidate.kind === "message" && candidate.role === "assistant") {
        return candidate.id;
      }
    }
    return null;
  }, [interruptedStatus, items]);
  const toolAutoCollapseStatus = isToolGroupsAutoCollapsed
    ? t("messages.on")
    : t("messages.off");
  const activeTurnLineChangeStats = useMemo(
    () => countDiffLineChanges(activeTurnDiff),
    [activeTurnDiff],
  );
  const assistantMetaByMessageId = useMemo(() => {
    const summaries =
      turnExecutionSummaries.length > 0
        ? turnExecutionSummaries
        : turnExecutionSummary
          ? [turnExecutionSummary]
          : [];
    const summaryByTurnId = new Map<string, TurnExecutionSummary>();
    summaries.forEach((summary) => {
      summary.turnChain.forEach((turnId) =>
        summaryByTurnId.set(turnId, summary),
      );
      summaryByTurnId.set(summary.turnId, summary);
    });

    const finalAssistantIdByTurnId = new Map<string, string>();
    const explicitFinalTurnIds = new Set<string>();
    items.forEach((item) => {
      if (
        item.kind !== "message" ||
        item.role !== "assistant" ||
        !item.turnId
      ) {
        return;
      }
      if (item.phase === "final_answer") {
        finalAssistantIdByTurnId.set(item.turnId, item.id);
        explicitFinalTurnIds.add(item.turnId);
      } else if (!explicitFinalTurnIds.has(item.turnId)) {
        finalAssistantIdByTurnId.set(item.turnId, item.id);
      }
    });

    const activityByTurnId = new Map<
      string,
      { toolCount: number; processMessageCount: number }
    >();
    const activityFor = (turnId: string) => {
      const current = activityByTurnId.get(turnId) ?? {
        toolCount: 0,
        processMessageCount: 0,
      };
      activityByTurnId.set(turnId, current);
      return current;
    };
    items.forEach((item) => {
      if (!item.turnId) {
        return;
      }
      const activity = activityFor(item.turnId);
      if (item.kind === "tool") {
        activity.toolCount += 1;
      } else if (item.kind === "explore") {
        activity.toolCount += item.entries.length;
      } else if (item.kind === "reasoning" || item.kind === "userInput") {
        activity.processMessageCount += 1;
      } else if (
        item.kind === "message" &&
        item.role === "assistant" &&
        finalAssistantIdByTurnId.get(item.turnId) !== item.id
      ) {
        activity.processMessageCount += 1;
      }
    });

    const identity = extractAssistantIdentity(assistantInstructionContent);
    const result = new Map<string, AssistantMessageMeta>();
    items.forEach((item) => {
      if (item.kind !== "message" || item.role !== "assistant") {
        return;
      }
      const summary = item.turnId ? summaryByTurnId.get(item.turnId) : null;
      const activity = item.turnId ? activityByTurnId.get(item.turnId) : null;
      const activeLineChanges =
        summary?.status === "active" ? activeTurnLineChangeStats : null;
      const isFinalAssistantMessage =
        Boolean(item.turnId) &&
        finalAssistantIdByTurnId.get(item.turnId!) === item.id;
      result.set(item.id, {
        name: resolveAssistantName(
          identity,
          summary?.modelId ?? assistantFallbackModelId,
          assistantModelOptions,
        ),
        toolCount: isFinalAssistantMessage ? (activity?.toolCount ?? 0) : 0,
        processMessageCount: isFinalAssistantMessage
          ? (activity?.processMessageCount ?? 0)
          : 0,
        additions: isFinalAssistantMessage
          ? (activeLineChanges?.additions ?? summary?.addedLines ?? null)
          : null,
        deletions: isFinalAssistantMessage
          ? (activeLineChanges?.deletions ?? summary?.deletedLines ?? null)
          : null,
      });
    });
    return result;
  }, [
    activeTurnLineChangeStats,
    assistantFallbackModelId,
    assistantInstructionContent,
    assistantModelOptions,
    items,
    turnExecutionSummaries,
    turnExecutionSummary,
  ]);
  const lineChangeStatsByGroupId = useMemo(() => {
    const result = new Map<string, { additions: number; deletions: number }>();
    const summaries =
      turnExecutionSummaries.length > 0
        ? turnExecutionSummaries
        : turnExecutionSummary
          ? [turnExecutionSummary]
          : [];
    const findGroupId = (turnChain: string[]) => {
      const ids = new Set(turnChain);
      for (let index = groupedItems.length - 1; index >= 0; index -= 1) {
        const entry = groupedItems[index];
        if (
          (entry?.kind === "processGroup" || entry?.kind === "toolGroup") &&
          entryContainsTurn(entry, ids)
        ) {
          return entry.group.id;
        }
      }
      return null;
    };
    groupedItems.forEach((entry) => {
      if (entry.kind !== "processGroup" && entry.kind !== "toolGroup") {
        return;
      }
      const stats = derivePersistedLineChangeStats(entry);
      if (stats) {
        result.set(entry.group.id, stats);
      }
    });
    summaries.forEach((summary) => {
      const additions = summary.addedLines ?? 0;
      const deletions = summary.deletedLines ?? 0;
      if (summary.status === "active" || (additions === 0 && deletions === 0)) {
        return;
      }
      const groupId = findGroupId(summary.turnChain);
      if (groupId) {
        result.set(groupId, { additions, deletions });
      }
    });
    if (activeTurnLineChangeStats) {
      const activeSummary = summaries.find(
        (summary) => summary.status === "active",
      );
      const groupId = activeSummary
        ? findGroupId(activeSummary.turnChain)
        : [...groupedItems]
            .reverse()
            .find(
              (entry) =>
                entry.kind === "processGroup" || entry.kind === "toolGroup",
            )?.group.id;
      if (groupId) {
        result.set(groupId, activeTurnLineChangeStats);
      }
    }
    return result;
  }, [
    activeTurnLineChangeStats,
    groupedItems,
    turnExecutionSummaries,
    turnExecutionSummary,
  ]);
  const activeToolGroups = useMemo(() => {
    if (!isThinking) {
      return [];
    }

    let latestUserMessageIndex = -1;
    groupedItems.forEach((entry, index) => {
      if (
        entry.kind === "item" &&
        entry.item.kind === "message" &&
        entry.item.role === "user"
      ) {
        latestUserMessageIndex = index;
      }
    });

    return groupedItems.filter(
      (
        entry,
        index,
      ): entry is Extract<MessageListEntry, { kind: "toolGroup" }> => {
        if (entry.kind !== "toolGroup" || entry.group.toolCount === 0) {
          return false;
        }
        if (entry.group.items.some((item) => item.turnId === activeTurnId)) {
          return true;
        }
        return (
          index > latestUserMessageIndex &&
          entry.group.items.every(
            (item) => !item.turnId || item.turnId === activeTurnId,
          )
        );
      },
    );
  }, [activeTurnId, groupedItems, isThinking]);
  const activeToolGroupIds = useMemo(
    () => new Set(activeToolGroups.map(({ group }) => group.id)),
    [activeToolGroups],
  );
  const activeToolGroupStats = useMemo(() => {
    if (activeToolGroups.length === 0) {
      return null;
    }
    let toolCount = 0;
    let processMessageCount = 0;
    let additions = 0;
    let deletions = 0;
    let hasLineChanges = false;
    activeToolGroups.forEach(({ group }) => {
      toolCount += group.toolCount;
      processMessageCount += group.messageCount;
      const lineChanges = lineChangeStatsByGroupId.get(group.id);
      if (!lineChanges) {
        return;
      }
      additions += lineChanges.additions;
      deletions += lineChanges.deletions;
      hasLineChanges = true;
    });
    return {
      toolCount,
      processMessageCount,
      additions: hasLineChanges ? additions : null,
      deletions: hasLineChanges ? deletions : null,
    };
  }, [activeToolGroups, lineChangeStatsByGroupId]);
  const activeAssistantMeta = useMemo<AssistantMessageMeta | null>(() => {
    if (!activeToolGroupStats) {
      return null;
    }
    const summaries =
      turnExecutionSummaries.length > 0
        ? turnExecutionSummaries
        : turnExecutionSummary
          ? [turnExecutionSummary]
          : [];
    const activeSummary =
      summaries.find(
        (summary) =>
          summary.turnId === activeTurnId ||
          summary.turnChain.includes(activeTurnId ?? ""),
      ) ?? summaries.find((summary) => summary.status === "active");
    return {
      name: resolveAssistantName(
        extractAssistantIdentity(assistantInstructionContent),
        activeSummary?.modelId ?? assistantFallbackModelId,
        assistantModelOptions,
      ),
      ...activeToolGroupStats,
    };
  }, [
    activeToolGroupStats,
    activeTurnId,
    assistantFallbackModelId,
    assistantInstructionContent,
    assistantModelOptions,
    turnExecutionSummaries,
    turnExecutionSummary,
  ]);
  const activeToolGroupsExpanded = activeToolGroups.some(
    ({ group }) => !collapsedToolGroups.has(group.id),
  );
  const activeToolGroupBodyId = activeToolGroups.length
    ? `active-tool-groups-${activeToolGroups.map(({ group }) => group.id).join("-")}`
    : "";
  const toggleActiveToolGroups = useCallback(() => {
    const shouldExpand = activeToolGroups.every(({ group }) =>
      collapsedToolGroups.has(group.id),
    );
    activeToolGroups.forEach(({ group }) => {
      const isExpanded = !collapsedToolGroups.has(group.id);
      if (isExpanded !== shouldExpand) {
        toggleToolGroup(group.id);
      }
    });
  }, [activeToolGroups, collapsedToolGroups, toggleToolGroup]);
  const activeToolProcessDisclosure: AssistantProcessDisclosure | undefined =
    activeAssistantMeta
      ? {
          toolCount: activeAssistantMeta.toolCount,
          processMessageCount: activeAssistantMeta.processMessageCount,
          additions: activeAssistantMeta.additions,
          deletions: activeAssistantMeta.deletions,
          isExpanded: activeToolGroupsExpanded,
          bodyId: activeToolGroupBodyId,
          onToggle: toggleActiveToolGroups,
        }
      : undefined;
  const renderLineChangeStats = useCallback(
    (lineChangeStats?: { additions: number; deletions: number }) => {
      if (!lineChangeStats) {
        return null;
      }
      return (
        <span
          className="tool-group-line-change-stats"
          aria-label="Line changes"
        >
          {lineChangeStats.additions > 0 && (
            <span className="tool-group-line-change-stat tool-group-line-change-stat-add">
              +{lineChangeStats.additions}
            </span>
          )}
          {lineChangeStats.deletions > 0 && (
            <span className="tool-group-line-change-stat tool-group-line-change-stat-delete">
              -{lineChangeStats.deletions}
            </span>
          )}
        </span>
      );
    },
    [],
  );
  const statusSeparator = t("messages.statusSeparator");
  const renderItem = (
    item: ConversationItem,
    assistantProcessDisclosure?: AssistantProcessDisclosure,
    assistantProcessContent?: ReactNode,
    repeatedErrorDisclosure?: RepeatedErrorDisclosure,
  ) => {
    if (item.kind === "message") {
      const isCopied = copiedMessageId === item.id;
      return (
        <MessageRow
          key={item.id}
          item={item}
          isCopied={isCopied}
          onCopy={handleCopyMessage}
          onReference={
            onReferenceMessage || onQuoteMessage
              ? handleReferenceMessage
              : undefined
          }
          onResendUserMessage={
            onResendUserMessage && item.id === retryableUserMessageId
              ? handleResendUserMessage
              : undefined
          }
          composerSendShortcut={composerSendShortcut}
          assistantActivityState={
            item.role === "assistant" && item.turnId
              ? (assistantActivityStateByTurnId.get(item.turnId) ?? "idle")
              : "idle"
          }
          assistantMeta={
            item.role === "assistant"
              ? (assistantMetaByMessageId.get(item.id) ?? null)
              : null
          }
          assistantProcessDisclosure={
            item.role === "assistant" ? assistantProcessDisclosure : undefined
          }
          assistantProcessContent={
            item.role === "assistant" ? assistantProcessContent : undefined
          }
          repeatedErrorDisclosure={
            item.role === "assistant" ? repeatedErrorDisclosure : undefined
          }
          codeBlockCopyUseModifier={codeBlockCopyUseModifier}
          showMessageFilePath={showMessageFilePath}
          interrupted={
            stoppedAssistantMessageId === item.id
              ? {
                  label: t("messages.sessionStopped"),
                }
              : null
          }
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
          exportSelectionMode={
            conversationExport.selecting && exportableMessageIds.has(item.id)
          }
          exportSelected={conversationExport.selectedIds.has(item.id)}
          onExportStart={
            exportableMessageIds.has(item.id)
              ? conversationExport.startSelection
              : undefined
          }
          onExportToggle={
            exportableMessageIds.has(item.id)
              ? conversationExport.toggleSelection
              : undefined
          }
        />
      );
    }
    if (item.kind === "subagentCheckpoint") {
      return (
        <SubagentCheckpointRow
          key={item.id}
          item={item}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
        />
      );
    }
    if (item.kind === "reasoning") {
      const isExpanded = expandedItems.has(item.id);
      const parsed = reasoningMetaById.get(item.id) ?? parseReasoning(item);
      return (
        <ReasoningRow
          key={item.id}
          item={item}
          parsed={parsed}
          isExpanded={isExpanded}
          onToggle={toggleExpanded}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
        />
      );
    }
    if (item.kind === "review") {
      return (
        <ReviewRow
          key={item.id}
          item={item}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
        />
      );
    }
    if (item.kind === "userInput") {
      const isExpanded = expandedItems.has(item.id);
      return (
        <UserInputRow
          key={item.id}
          item={item}
          isExpanded={isExpanded}
          onToggle={toggleExpanded}
        />
      );
    }
    if (item.kind === "diff") {
      return <DiffRow key={item.id} item={item} />;
    }
    if (item.kind === "tool") {
      const isExpanded = expandedItems.has(item.id);
      return (
        <ToolRow
          key={item.id}
          item={item}
          isExpanded={isExpanded}
          onToggle={toggleExpanded}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
          onRequestAutoScroll={requestAutoScroll}
        />
      );
    }
    if (item.kind === "explore") {
      return <ExploreRow key={item.id} item={item} />;
    }
    if (item.kind === "process") {
      return <ProcessRow key={item.id} item={item} />;
    }
    return null;
  };
  const renderProcessGroupEntry = (processEntry: MessageListBaseEntry) => {
    if (processEntry.kind === "toolGroup") {
      const shouldCollapseNestedGroup = processEntry.group.items.length >= 4;
      if (!shouldCollapseNestedGroup) {
        return (
          <div
            key={`nested-tool-group-${processEntry.group.id}`}
            className="tool-group process-group-nested"
          >
            <div className="tool-group-body">
              {processEntry.group.items.map((nestedItem) =>
                renderItem(nestedItem),
              )}
            </div>
          </div>
        );
      }
      const nestedStateId = `nested-tool-group-${processEntry.group.id}`;
      const isExpanded = expandedItems.has(nestedStateId);
      const nestedBodyId = `${nestedStateId}-body`;
      const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;
      return (
        <div
          key={`nested-tool-group-${processEntry.group.id}`}
          className={`tool-group process-group-nested process-group-nested-collapsible${
            isExpanded ? "" : " tool-group-collapsed"
          }`}
        >
          <div className="tool-group-header">
            <button
              type="button"
              className="tool-group-toggle"
              data-button-elevation="none"
              onClick={() => toggleExpanded(nestedStateId)}
              aria-expanded={isExpanded}
              aria-controls={nestedBodyId}
              aria-label={
                isExpanded
                  ? t("messages.collapseTools")
                  : t("messages.expandTools")
              }
            >
              <span className="tool-group-chevron" aria-hidden>
                <ChevronIcon size={14} />
              </span>
              <span className="tool-group-summary">
                {formatCount(
                  processEntry.group.toolCount,
                  t("messages.toolCallSingular"),
                  t("messages.toolCallPlural"),
                )}
              </span>
            </button>
          </div>
          {isExpanded ? (
            <div className="tool-group-body" id={nestedBodyId}>
              {processEntry.group.items.map((nestedItem) =>
                renderItem(nestedItem),
              )}
            </div>
          ) : null}
        </div>
      );
    }
    if (
      processEntry.item.kind === "message" &&
      processEntry.item.role === "assistant"
    ) {
      return (
        <ProcessMessageRow
          key={processEntry.item.id}
          item={processEntry.item}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
        />
      );
    }
    return renderItem(processEntry.item);
  };

  const activeToolProcessContent =
    activeToolProcessDisclosure?.isExpanded ? (
      <div
        id={activeToolGroupBodyId}
        ref={(node) => {
          activeToolGroups.forEach(({ group }) => {
            registerSearchTarget(`tool-group-${group.id}`)(node);
          });
        }}
        data-history-anchor={activeToolGroups[0]?.group.id}
        className={`tool-group process-group process-group-inline messages-search-target${
          activeToolGroups.some(
            ({ group }) =>
              activeSearchTargetId === `tool-group-${group.id}`,
          )
            ? " is-active-search-match"
            : ""
        }`}
      >
        <div className="tool-group-body">
          {coalesceDenseProcessToolGroups(
            activeToolGroups,
            activeToolGroupBodyId,
          ).map((processEntry) => renderProcessGroupEntry(processEntry))}
        </div>
      </div>
    ) : undefined;

  const messageToolsNode = (
    <div
      className="messages-tool-controls"
      aria-label={t("messages.toolAutoCollapse")}
    >
      <button
        type="button"
        className={`ghost messages-toggle-pill${
          isToolGroupsAutoCollapsed ? " is-active" : ""
        }`}
        onClick={toggleToolAutoCollapse}
        aria-pressed={isToolGroupsAutoCollapsed}
        aria-label={`${t("messages.toolAutoCollapse")}${statusSeparator}${toolAutoCollapseStatus}`}
        title={`${t("messages.toolAutoCollapse")}${statusSeparator}${toolAutoCollapseStatus}`}
      >
        {t("messages.autoCollapse")}
        {statusSeparator}
        {toolAutoCollapseStatus}
      </button>
    </div>
  );

  return (
    <div
      className="messages-view messages-reading-native"
      style={messagesStyle}
    >
      {headerToolsHost ? createPortal(messageToolsNode, headerToolsHost) : null}
      {(isSearchActiveForThread || !headerToolsHost) && (
        <div className="messages-control-layer">
          <div className="messages-control-inner">
            {isSearchActiveForThread && (
              <div className="messages-session-search" role="search">
                <Search size={14} aria-hidden />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) =>
                    handleSearchQueryChange(event.target.value)
                  }
                  onKeyDown={handleSearchInputKeyDown}
                  aria-label={t("messages.searchCurrentSession")}
                  placeholder={t("messages.searchCurrentSession")}
                />
                <span
                  className="messages-session-search-count"
                  aria-live="polite"
                >
                  {searchQuery.trim()
                    ? t("messages.searchCount")
                        .replace("{current}", String(activeSearchDisplayIndex))
                        .replace("{total}", String(searchMatches.length))
                    : t("messages.searchHint")}
                </span>
                <button
                  type="button"
                  className="ghost messages-session-search-icon-button"
                  onClick={() => moveSearch(-1)}
                  disabled={searchMatches.length === 0}
                  aria-label={t("messages.searchPrevious")}
                  title={t("messages.searchPrevious")}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="ghost messages-session-search-icon-button"
                  onClick={() => moveSearch(1)}
                  disabled={searchMatches.length === 0}
                  aria-label={t("messages.searchNext")}
                  title={t("messages.searchNext")}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="ghost messages-session-search-icon-button"
                  onClick={() => setSearchOpen(false)}
                  aria-label={t("messages.searchClose")}
                  title={t("messages.searchClose")}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {!headerToolsHost ? messageToolsNode : null}
          </div>
        </div>
      )}
      <div
        className="messages messages-full"
        ref={containerRef}
        onScroll={updateAutoScroll}
        onWheel={handleMessagesWheel}
      >
        <div className="messages-inner">
          <SubagentResultSummary
            results={subagentResults}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            codeBlockCopyUseModifier={codeBlockCopyUseModifier}
            showMessageFilePath={showMessageFilePath}
            onOpenFileLink={openFileLink}
            onOpenThreadLink={onOpenThreadLink}
          />
          {hiddenBeforeCount > 0 && (
            <button
              type="button"
              className="messages-history-notice"
              onClick={loadEarlierHistory}
            >
              {t("messages.historyEarlierNotice").replace(
                "{count}",
                String(hiddenBeforeCount),
              )}
            </button>
          )}
          {hiddenBeforeCount === 0 && hasOlderHistory && (
            <button
              type="button"
              className="messages-history-notice"
              onClick={() => void handleLoadOlderHistory()}
              disabled={isLoadingOlderHistory}
            >
              {isLoadingOlderHistory
                ? t("messages.historyLoadingOlder")
                : t("messages.historyLoadOlder")}
            </button>
          )}
          {groupedItems.map((entry, entryIndex) => {
            const repeatedErrorRun =
              repeatedErrorRunsByEntryIndex.get(entryIndex);
            const showAllRepeatedErrors =
              isSearchActiveForThread || conversationExport.selecting;
            const isRepeatedErrorGroupExpanded = repeatedErrorRun
              ? expandedRepeatedErrorGroups.has(repeatedErrorRun.id)
              : false;
            if (
              repeatedErrorRun &&
              !showAllRepeatedErrors &&
              !isRepeatedErrorGroupExpanded &&
              entryIndex !== repeatedErrorRun.latestEntryIndex
            ) {
              return null;
            }
            const searchTarget = getSearchTargetForEntry(entry);
            const isActiveSearchMatch = activeSearchTargetId === searchTarget;
            const isUserMessageSearchTarget =
              entry.kind === "item" &&
              entry.item.kind === "message" &&
              entry.item.role === "user";
            const searchTargetClassName = `messages-search-target${
              isActiveSearchMatch ? " is-active-search-match" : ""
            }${isUserMessageSearchTarget ? " is-user-message-search-target" : ""}`;
            if (entry.kind === "processGroup") {
              return null;
            }
            if (entry.kind === "toolGroup") {
              const { group } = entry;
              if (activeToolGroupIds.has(group.id)) {
                return null;
              }
              const isCollapsed = collapsedToolGroups.has(group.id);
              const summaryParts = [];
              if (group.toolCount > 0) {
                summaryParts.push(
                  formatCount(
                    group.toolCount,
                    t("messages.toolCallSingular"),
                    t("messages.toolCallPlural"),
                  ),
                );
              }
              if (group.messageCount > 0) {
                summaryParts.push(
                  formatCount(
                    group.messageCount,
                    t("messages.messageSingular"),
                    t("messages.messagePlural"),
                  ),
                );
              }
              const summaryText =
                summaryParts.length > 0
                  ? summaryParts.join(", ")
                  : t("messages.processMessages");
              const groupBodyId = `tool-group-${group.id}`;
              const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;
              return (
                <div
                  key={`tool-group-${group.id}`}
                  ref={registerSearchTarget(searchTarget)}
                  data-history-anchor={group.id}
                  className={`tool-group ${searchTargetClassName} ${
                    isCollapsed ? "tool-group-collapsed" : ""
                  }`}
                >
                  <div className="tool-group-header">
                    <button
                      type="button"
                      className="tool-group-toggle"
                      data-button-elevation="none"
                      onClick={() => toggleToolGroup(group.id)}
                      aria-expanded={!isCollapsed}
                      aria-controls={groupBodyId}
                      aria-label={
                        isCollapsed
                          ? t("messages.expandTools")
                          : t("messages.collapseTools")
                      }
                    >
                      <span className="tool-group-chevron" aria-hidden>
                        <ChevronIcon size={14} />
                      </span>
                      <span className="tool-group-summary-content">
                        <span className="tool-group-summary">
                          {summaryText}
                        </span>
                        {renderLineChangeStats(
                          lineChangeStatsByGroupId.get(group.id),
                        )}
                      </span>
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="tool-group-body" id={groupBodyId}>
                      {group.items.map((item) => renderItem(item))}
                    </div>
                  )}
                </div>
              );
            }
            const precedingProcessEntry = groupedItems[entryIndex - 1];
            const processGroupEntry =
              entry.item.kind === "message" &&
              entry.item.role === "assistant" &&
              precedingProcessEntry?.kind === "processGroup"
                ? precedingProcessEntry
                : null;
            const processGroup = processGroupEntry?.group;
            const processSearchTarget = processGroupEntry
              ? getSearchTargetForEntry(processGroupEntry)
              : null;
            const processGroupCollapsed = processGroup
              ? collapsedToolGroups.has(processGroup.id)
              : true;
            const processGroupBodyId = processGroup
              ? `tool-group-${processGroup.id}`
              : "";
            const processLineChanges = processGroup
              ? lineChangeStatsByGroupId.get(processGroup.id)
              : undefined;
            const processDisclosure: AssistantProcessDisclosure | undefined =
              processGroup
                ? {
                    toolCount: processGroup.toolCount,
                    processMessageCount: processGroup.messageCount,
                    additions: processLineChanges?.additions ?? null,
                    deletions: processLineChanges?.deletions ?? null,
                    isExpanded: !processGroupCollapsed,
                    bodyId: processGroupBodyId,
                    onToggle: () => toggleToolGroup(processGroup.id),
                  }
                : undefined;
            const processContent =
              processGroup && processSearchTarget && !processGroupCollapsed ? (
                <div className="message-agent-process-content">
                  <div
                    ref={registerSearchTarget(processSearchTarget)}
                    className={`tool-group process-group process-group-inline messages-search-target${
                      activeSearchTargetId === processSearchTarget
                        ? " is-active-search-match"
                        : ""
                    }`}
                  >
                    <div className="tool-group-body" id={processGroupBodyId}>
                      {coalesceDenseProcessToolGroups(
                        processGroup.entries,
                        processGroup.id,
                      ).map((processEntry) =>
                        renderProcessGroupEntry(processEntry),
                      )}
                    </div>
                  </div>
                </div>
              ) : undefined;
            const repeatedErrorDisclosure:
              | RepeatedErrorDisclosure
              | undefined =
              repeatedErrorRun &&
              !showAllRepeatedErrors &&
              entryIndex === repeatedErrorRun.latestEntryIndex
                ? {
                    count: repeatedErrorRun.count,
                    isExpanded: isRepeatedErrorGroupExpanded,
                    label: t(
                      isRepeatedErrorGroupExpanded
                        ? "messages.collapseRepeatedErrors"
                        : "messages.expandRepeatedErrors",
                    ).replace("{count}", String(repeatedErrorRun.count)),
                    onToggle: () =>
                      toggleRepeatedErrorGroup(repeatedErrorRun.id),
                  }
                : undefined;
            return (
              <div
                key={`item-search-${entry.item.id}`}
                ref={registerSearchTarget(searchTarget)}
                data-history-anchor={entry.item.id}
                className={searchTargetClassName}
              >
                {renderItem(
                  entry.item,
                  processDisclosure,
                  processContent,
                  repeatedErrorDisclosure,
                )}
              </div>
            );
          })}
          {hiddenAfterCount > 0 && (
            <button
              type="button"
              className="messages-history-notice"
              onClick={loadLaterHistory}
            >
              {t("messages.historyLaterNotice").replace(
                "{count}",
                String(hiddenAfterCount),
              )}
            </button>
          )}
          {planFollowupNode}
          {userInputNode}
          <WorkingIndicator
            isThinking={isThinking}
            activityState={activityState}
            processingStartedAt={processingStartedAt}
            lastDurationMs={lastDurationMs}
            hasItems={items.length > 0}
            reasoningLabel={latestReasoningLabel}
            showPollingFetchStatus={showPollingFetchStatus}
            pollingIntervalMs={pollingIntervalMs}
            completionStatus={
              turnExecutionSummary?.status === "active"
                ? null
                : (turnExecutionSummary?.status ?? null)
            }
            completedLabel={
              turnExecutionSummary ? t("messages.completedIn") : undefined
            }
            interruptedLabel={
              turnExecutionSummary ? t("messages.interruptedIn") : undefined
            }
            failedLabel={
              turnExecutionSummary ? t("messages.failedIn") : undefined
            }
            pollingFetchLabel={t("messages.pollingFetchCountdown")}
            assistantMeta={activeAssistantMeta}
            assistantProcessDisclosure={activeToolProcessDisclosure}
            assistantProcessContent={activeToolProcessContent}
          />
          {!items.length &&
            !userInputNode &&
            !isThinking &&
            !isLoadingMessages && (
              <div className="empty messages-empty">
                {threadId
                  ? t("messages.emptyExistingThread")
                  : t("messages.emptyNewThread")}
              </div>
            )}
          {!items.length &&
            !userInputNode &&
            !isThinking &&
            isLoadingMessages && (
              <div className="empty messages-empty">
                <div
                  className="messages-loading-indicator"
                  role="status"
                  aria-live="polite"
                >
                  <span className="working-spinner" aria-hidden />
                  <span className="messages-loading-label">
                    {t("messages.loading")}
                  </span>
                </div>
              </div>
            )}
          <div ref={bottomRef} />
        </div>
        {showScrollToLatest && (
          <button
            type="button"
            className="messages-scroll-latest-button"
            onClick={scrollToLatest}
            aria-label={t("messages.scrollToLatest")}
            title={t("messages.scrollToLatest")}
          >
            <span aria-hidden>↓</span>
            <span>{t("messages.latest")}</span>
          </button>
        )}
      </div>
      <ConversationExportControls
        selecting={conversationExport.selecting}
        selectedCount={conversationExport.selectedCount}
        totalCount={conversationExport.totalCount}
        busy={conversationExport.busy}
        progress={conversationExport.progress}
        onSelectAll={conversationExport.selectAll}
        onCancelSelection={conversationExport.cancelSelection}
        onExport={conversationExport.exportConversation}
        onCancelExport={conversationExport.cancelExport}
        onDismissProgress={conversationExport.dismissProgress}
      />
    </div>
  );
});
