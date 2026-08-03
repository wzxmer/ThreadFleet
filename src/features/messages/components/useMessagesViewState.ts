import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConversationItem } from "../../../types";
import { isPlanReadyTaggedMessage } from "../../../utils/internalPlanReadyMessages";
import {
  SCROLL_THRESHOLD_PX,
  buildToolGroups,
  computePlanFollowupState,
  parseReasoning,
  scrollKeyForItems,
  type MessageListBaseEntry,
  type MessageListEntry,
} from "../utils/messageRenderUtils";
import { useMessageHistoryWindow } from "./useMessageHistoryWindow";
import { toMarkdownQuote } from "../utils/messageReferences";
import { dedupeSubagentCheckpointItems } from "../utils/subagentCheckpointDisplay";

const MAX_VISIBLE_TEXT_ONLY_COMMENTARY = 2;

function baseEntryContainsItem(entry: MessageListBaseEntry, itemId: string) {
  return entry.kind === "toolGroup"
    ? entry.group.items.some((item) => item.id === itemId)
    : entry.item.id === itemId;
}

type UseMessagesViewStateArgs = {
  items: ConversationItem[];
  threadId: string | null;
  activeTurnId?: string | null;
  isThinking: boolean;
  activeUserInputRequestId: string | number | null;
  hasVisibleUserInputRequest: boolean;
  defaultToolGroupsCollapsed?: boolean;
  chatHistoryScrollbackItems?: number | null;
  onPlanAccept?: () => void;
  onPlanSubmitChanges?: (changes: string) => void;
  onQuoteMessage?: (text: string) => void;
};

export function useMessagesViewState({
  items,
  threadId,
  activeTurnId = null,
  isThinking,
  activeUserInputRequestId,
  hasVisibleUserInputRequest,
  defaultToolGroupsCollapsed = false,
  chatHistoryScrollbackItems,
  onPlanAccept,
  onPlanSubmitChanges,
  onQuoteMessage,
}: UseMessagesViewStateArgs) {
  const displayItems = useMemo(
    () => dedupeSubagentCheckpointItems(items),
    [items],
  );
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const previousThreadIdRef = useRef(threadId);
  const resizeScrollFrameRef = useRef<number | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const manuallyToggledExpandedRef = useRef<Set<string>>(new Set());
  const manuallyToggledToolGroupsRef = useRef<Set<string>>(new Set());
  const finalMessageAutoCollapseRef = useRef<string | null>(null);
  const userDisabledAutoCollapseRef = useRef(false);
  const [isToolGroupsAutoCollapsed, setIsToolGroupsAutoCollapsed] = useState(
    defaultToolGroupsCollapsed,
  );

  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [collapsedToolGroups, setCollapsedToolGroups] = useState<Set<string>>(
    new Set(),
  );
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [dismissedPlanFollowupByThread, setDismissedPlanFollowupByThread] =
    useState<Record<string, string>>({});

  const {
    visibleItems: historyItems,
    hiddenBeforeCount,
    hiddenAfterCount,
    handleHistoryScroll,
    loadEarlier,
    loadLater,
    revealItemAtIndex,
    showLatest,
  } = useMessageHistoryWindow({
    items: displayItems,
    threadId,
    batchSize: chatHistoryScrollbackItems,
    containerRef,
  });

  const scrollKey = `${scrollKeyForItems(displayItems)}-${activeUserInputRequestId ?? "no-input"}`;

  const isNearBottom = useCallback(
    (node: HTMLDivElement) =>
      node.scrollHeight - node.scrollTop - node.clientHeight <=
      SCROLL_THRESHOLD_PX,
    [],
  );

  const updateAutoScroll = useCallback(() => {
    if (!containerRef.current) {
      return;
    }
    handleHistoryScroll(containerRef.current);
    const nearBottom = isNearBottom(containerRef.current);
    autoScrollRef.current = nearBottom;
    setShowScrollToLatest(!nearBottom);
  }, [handleHistoryScroll, isNearBottom]);

  const requestAutoScroll = useCallback(() => {
    const container = containerRef.current;
    const shouldScroll =
      autoScrollRef.current || (container ? isNearBottom(container) : true);
    if (!shouldScroll) {
      return;
    }
    if (container) {
      container.scrollTop = container.scrollHeight;
      setShowScrollToLatest(false);
      return;
    }
    bottomRef.current?.scrollIntoView({ block: "end" });
    setShowScrollToLatest(false);
  }, [isNearBottom]);

  const scrollToLatest = useCallback(() => {
    autoScrollRef.current = true;
    showLatest();
    const container = containerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    } else {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    setShowScrollToLatest(false);
  }, [showLatest]);

  useLayoutEffect(() => {
    const didThreadChange = previousThreadIdRef.current !== threadId;
    previousThreadIdRef.current = threadId;
    autoScrollRef.current = true;
    if (didThreadChange) {
      manuallyToggledExpandedRef.current = new Set();
      userDisabledAutoCollapseRef.current = false;
      setExpandedItems(new Set());
      setCollapsedToolGroups(new Set());
    }
    manuallyToggledToolGroupsRef.current = new Set();
    finalMessageAutoCollapseRef.current = null;
    setIsToolGroupsAutoCollapsed(defaultToolGroupsCollapsed);
  }, [defaultToolGroupsCollapsed, threadId]);

  useEffect(() => {
    setIsToolGroupsAutoCollapsed(defaultToolGroupsCollapsed);
  }, [defaultToolGroupsCollapsed]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const shouldScroll =
      autoScrollRef.current || (container ? isNearBottom(container) : true);
    if (!shouldScroll) {
      return;
    }
    if (container) {
      container.scrollTop = container.scrollHeight;
      setShowScrollToLatest(false);
      return;
    }
    bottomRef.current?.scrollIntoView({ block: "end" });
    setShowScrollToLatest(false);
  }, [scrollKey, isThinking, isNearBottom, threadId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = container?.querySelector<HTMLElement>(".messages-inner");
    if (!container || !content || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (!autoScrollRef.current) {
        return;
      }
      if (resizeScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeScrollFrameRef.current);
      }
      resizeScrollFrameRef.current = window.requestAnimationFrame(() => {
        resizeScrollFrameRef.current = null;
        if (!autoScrollRef.current || !containerRef.current) {
          return;
        }
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
        setShowScrollToLatest(false);
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (resizeScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeScrollFrameRef.current);
        resizeScrollFrameRef.current = null;
      }
    };
  }, [threadId]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    manuallyToggledExpandedRef.current.add(id);
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleToolGroup = useCallback((id: string) => {
    manuallyToggledToolGroupsRef.current.add(id);
    setCollapsedToolGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleCopyMessage = useCallback(
    async (item: Extract<ConversationItem, { kind: "message" }>) => {
      try {
        await navigator.clipboard.writeText(item.text);
        setCopiedMessageId(item.id);
        if (copyTimeoutRef.current) {
          window.clearTimeout(copyTimeoutRef.current);
        }
        copyTimeoutRef.current = window.setTimeout(() => {
          setCopiedMessageId(null);
        }, 1200);
      } catch {
        // No-op: clipboard errors can occur in restricted contexts.
      }
    },
    [],
  );

  const handleQuoteMessage = useCallback(
    (
      item: Extract<ConversationItem, { kind: "message" }>,
      selectedText?: string,
    ) => {
      if (!onQuoteMessage) {
        return;
      }
      const sourceText = selectedText?.trim().length ? selectedText : item.text;
      const quoteText = toMarkdownQuote(sourceText);
      if (!quoteText) {
        return;
      }
      onQuoteMessage(quoteText);
    },
    [onQuoteMessage],
  );

  const reasoningMetaById = useMemo(() => {
    const meta = new Map<string, ReturnType<typeof parseReasoning>>();
    historyItems.forEach((item) => {
      if (item.kind === "reasoning") {
        meta.set(item.id, parseReasoning(item));
      }
    });
    return meta;
  }, [historyItems]);

  const latestReasoningLabel = useMemo(() => {
    for (let index = historyItems.length - 1; index >= 0; index -= 1) {
      const item = historyItems[index];
      if (item.kind === "message") {
        break;
      }
      if (item.kind !== "reasoning") {
        continue;
      }
      const parsed = reasoningMetaById.get(item.id);
      if (parsed?.workingLabel) {
        return parsed.workingLabel;
      }
    }
    return null;
  }, [historyItems, reasoningMetaById]);

  const visibleItems = useMemo(
    () =>
      historyItems.filter((item) => {
        if (
          item.kind === "message" &&
          item.role === "user" &&
          isPlanReadyTaggedMessage(item.text)
        ) {
          return false;
        }
        if (item.kind !== "reasoning") {
          return true;
        }
        return reasoningMetaById.get(item.id)?.hasBody ?? false;
      }),
    [historyItems, reasoningMetaById],
  );

  useEffect(() => {
    for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
      const item = visibleItems[index];
      if (
        item.kind === "tool" &&
        item.toolType === "plan" &&
        (item.output ?? "").trim().length > 0
      ) {
        if (manuallyToggledExpandedRef.current.has(item.id)) {
          return;
        }
        setExpandedItems((prev) => {
          if (prev.has(item.id)) {
            return prev;
          }
          const next = new Set(prev);
          next.add(item.id);
          return next;
        });
        return;
      }
    }
  }, [visibleItems]);

  const baseGroupedItems = useMemo(
    () => buildToolGroups(visibleItems),
    [visibleItems],
  );

  const groupedItems = useMemo<MessageListEntry[]>(() => {
    const buildProcessGroup = (
      processEntries: MessageListBaseEntry[],
      finalEntry: MessageListBaseEntry,
    ): MessageListEntry | null => {
      if (processEntries.length === 0) {
        return null;
      }
      const firstEntry = processEntries[0];
      const firstId =
        firstEntry.kind === "toolGroup"
          ? firstEntry.group.id
          : firstEntry.item.id;
      const finalId = finalEntry.kind === "item" ? finalEntry.item.id : "final";
      const toolCount = processEntries.reduce((total, entry) => {
        if (entry.kind === "toolGroup") {
          return total + entry.group.toolCount;
        }
        return entry.item.kind === "tool" ? total + 1 : total;
      }, 0);
      const messageCount = processEntries.reduce((total, entry) => {
        if (entry.kind === "toolGroup") {
          return total + entry.group.messageCount;
        }
        return entry.item.kind === "message" || entry.item.kind === "reasoning"
          ? total + 1
          : total;
      }, 0);
      return {
        kind: "processGroup",
        group: {
          id: `process-${firstId}-${finalId}`,
          entries: processEntries,
          toolCount,
          messageCount,
        },
      };
    };
    const isProcessEntryBeforeFinal = (entry: MessageListBaseEntry) => {
      if (entry.kind === "toolGroup") {
        return true;
      }
      const { item } = entry;
      if (item.kind === "message") {
        return item.role === "assistant" && item.phase !== "final_answer";
      }
      return item.kind !== "subagentCheckpoint";
    };
    const isProcessEntryAfterFinal = (entry: MessageListBaseEntry) => {
      if (entry.kind === "toolGroup") {
        return true;
      }
      const { item } = entry;
      if (item.kind === "message") {
        return item.role === "assistant" && item.phase === "commentary";
      }
      return item.kind !== "subagentCheckpoint";
    };

    const result: MessageListEntry[] = [];
    let turnEntries: MessageListBaseEntry[] = [];
    let turnId: string | null = null;

    const entryTurnId = (entry: MessageListBaseEntry): string | null => {
      if (entry.kind === "item") {
        return entry.item.turnId ?? null;
      }
      return entry.group.items.find((item) => item.turnId)?.turnId ?? null;
    };

    const flushTurn = () => {
      if (turnEntries.length === 0) {
        return;
      }
      let finalAssistantIndex = -1;
      let fallbackAssistantIndex = -1;
      for (let index = turnEntries.length - 1; index >= 0; index -= 1) {
        const entry = turnEntries[index];
        if (
          entry.kind === "item" &&
          entry.item.kind === "message" &&
          entry.item.role === "assistant"
        ) {
          if (fallbackAssistantIndex < 0) {
            fallbackAssistantIndex = index;
          }
          if (entry.item.phase === "final_answer") {
            finalAssistantIndex = index;
            break;
          }
        }
      }
      finalAssistantIndex =
        activeTurnId && turnId === activeTurnId
          ? fallbackAssistantIndex
          : finalAssistantIndex;
      if (finalAssistantIndex < 0 || turnEntries.length <= 1) {
        result.push(...turnEntries);
        turnEntries = [];
        turnId = null;
        return;
      }
      const finalEntry = turnEntries[finalAssistantIndex];
      const finalItem = finalEntry.kind === "item" ? finalEntry.item : null;
      const canFoldTrailingProcessEntries =
        finalAssistantIndex === 0 ||
        (finalItem?.kind === "message" &&
          (finalItem.phase === "final_answer" ||
            (turnId !== null && finalItem.turnId === turnId)));
      const leadingEntries = turnEntries
        .slice(0, finalAssistantIndex)
        .filter((entry) => !isProcessEntryBeforeFinal(entry));
      const processEntries = [
        ...turnEntries
          .slice(0, finalAssistantIndex)
          .filter(isProcessEntryBeforeFinal),
        ...(canFoldTrailingProcessEntries
          ? turnEntries
              .slice(finalAssistantIndex + 1)
              .filter(isProcessEntryAfterFinal)
          : []),
      ];
      const trailingEntries = turnEntries
        .slice(finalAssistantIndex + 1)
        .filter(
          (entry) =>
            !canFoldTrailingProcessEntries || !isProcessEntryAfterFinal(entry),
        );
      const hasStructuredProcessActivity = processEntries.some(
        (entry) =>
          entry.kind === "toolGroup" ||
          entry.item.kind !== "message" ||
          entry.item.role !== "assistant",
      );
      const isExplicitTextOnlyTurn =
        turnId !== null &&
        finalEntry.kind === "item" &&
        finalEntry.item.kind === "message" &&
        finalEntry.item.phase === "final_answer" &&
        processEntries.every(
          (entry) =>
            entry.kind === "item" &&
            entry.item.kind === "message" &&
            entry.item.role === "assistant" &&
            entry.item.phase === "commentary",
        );
      if (
        !hasStructuredProcessActivity &&
        isExplicitTextOnlyTurn &&
        processEntries.length <= MAX_VISIBLE_TEXT_ONLY_COMMENTARY
      ) {
        result.push(...turnEntries);
        turnEntries = [];
        turnId = null;
        return;
      }
      const processGroup = buildProcessGroup(processEntries, finalEntry);
      if (processGroup) {
        result.push(
          ...leadingEntries,
          processGroup,
          finalEntry,
          ...trailingEntries,
        );
      } else {
        result.push(...turnEntries);
      }
      turnEntries = [];
      turnId = null;
    };

    baseGroupedItems.forEach((entry) => {
      const entryId = entryTurnId(entry);
      const startsUnscopedAssistantAfterCompletedTurn =
        entryId === null &&
        turnId !== null &&
        entry.kind === "item" &&
        entry.item.kind === "message" &&
        entry.item.role === "assistant" &&
        turnEntries.some(
          (candidate) =>
            candidate.kind === "item" &&
            candidate.item.kind === "message" &&
            candidate.item.role === "assistant" &&
            candidate.item.turnId === turnId,
        );
      if (
        turnEntries.length > 0 &&
        ((entryId && turnId && entryId !== turnId) ||
          startsUnscopedAssistantAfterCompletedTurn)
      ) {
        flushTurn();
      }
      if (
        entry.kind === "item" &&
        ((entry.item.kind === "message" && entry.item.role === "user") ||
          entry.item.kind === "subagentCheckpoint")
      ) {
        flushTurn();
        result.push(entry);
        return;
      }
      turnEntries.push(entry);
      turnId = turnId ?? entryId;
    });
    flushTurn();
    return result;
  }, [activeTurnId, baseGroupedItems]);

  const revealGroupedItem = useCallback(
    (itemId: string) => {
      const containingEntry = groupedItems.find((entry) => {
        if (entry.kind === "processGroup") {
          return entry.group.entries.some((processEntry) =>
            baseEntryContainsItem(processEntry, itemId),
          );
        }
        return baseEntryContainsItem(entry, itemId);
      });
      if (!containingEntry) {
        return;
      }
      if (
        containingEntry.kind === "toolGroup" ||
        containingEntry.kind === "processGroup"
      ) {
        const groupId = containingEntry.group.id;
        manuallyToggledToolGroupsRef.current.add(groupId);
        setCollapsedToolGroups((previous) => {
          if (!previous.has(groupId)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(groupId);
          return next;
        });
      }
      setExpandedItems((previous) => {
        if (previous.has(itemId)) {
          return previous;
        }
        const next = new Set(previous);
        next.add(itemId);
        return next;
      });
    },
    [groupedItems],
  );

  const finalAssistantCollapseTarget = useMemo(() => {
    let finalAssistantIndex = -1;
    let finalAssistantId: string | null = null;

    groupedItems.forEach((entry, index) => {
      if (
        entry.kind === "item" &&
        entry.item.kind === "message" &&
        entry.item.role === "assistant"
      ) {
        finalAssistantIndex = index;
        finalAssistantId = entry.item.id;
      }
    });

    if (finalAssistantIndex <= 0 || !finalAssistantId) {
      return {
        finalAssistantId: null,
        groupIds: [] as string[],
        itemIds: [] as string[],
      };
    }

    const groupIds = groupedItems
      .slice(0, finalAssistantIndex)
      .filter(
        (entry) => entry.kind === "toolGroup" || entry.kind === "processGroup",
      )
      .map((entry) => entry.group.id);

    const itemIds = groupedItems
      .slice(0, finalAssistantIndex)
      .flatMap((entry) =>
        entry.kind === "toolGroup"
          ? entry.group.items.map((item) => item.id)
          : entry.kind === "processGroup"
            ? entry.group.entries.flatMap((processEntry) =>
                processEntry.kind === "toolGroup"
                  ? processEntry.group.items.map((item) => item.id)
                  : processEntry.item.id,
              )
            : entry.item.kind === "tool" ||
                entry.item.kind === "reasoning" ||
                entry.item.kind === "userInput"
              ? [entry.item.id]
              : [],
      );

    return { finalAssistantId, groupIds, itemIds };
  }, [groupedItems]);

  const collapseAllToolGroups = useCallback(() => {
    const groupIds = groupedItems
      .filter(
        (entry) => entry.kind === "toolGroup" || entry.kind === "processGroup",
      )
      .map((entry) => entry.group.id);
    setIsToolGroupsAutoCollapsed(true);
    userDisabledAutoCollapseRef.current = false;
    manuallyToggledToolGroupsRef.current = new Set(groupIds);
    setCollapsedToolGroups(new Set(groupIds));
  }, [groupedItems]);

  const expandAllToolGroups = useCallback(() => {
    const groupIds = groupedItems
      .filter(
        (entry) => entry.kind === "toolGroup" || entry.kind === "processGroup",
      )
      .map((entry) => entry.group.id);
    setIsToolGroupsAutoCollapsed(false);
    userDisabledAutoCollapseRef.current = true;
    groupIds.forEach((id) => manuallyToggledToolGroupsRef.current.add(id));
    setCollapsedToolGroups((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const next = new Set(prev);
      groupIds.forEach((id) => next.delete(id));
      return next;
    });
  }, [groupedItems]);

  const setToolGroupsAutoCollapsed = useCallback(
    (collapsed: boolean) => {
      if (collapsed) {
        collapseAllToolGroups();
        return;
      }
      expandAllToolGroups();
    },
    [collapseAllToolGroups, expandAllToolGroups],
  );

  useEffect(() => {
    if (!isToolGroupsAutoCollapsed) {
      return;
    }
    const groupIds = groupedItems
      .filter(
        (entry) => entry.kind === "toolGroup" || entry.kind === "processGroup",
      )
      .map((entry) => entry.group.id)
      .filter((id) => !manuallyToggledToolGroupsRef.current.has(id));
    if (groupIds.length === 0) {
      return;
    }
    setCollapsedToolGroups((prev) => {
      let changed = false;
      const next = new Set(prev);
      groupIds.forEach((id) => {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [defaultToolGroupsCollapsed, groupedItems, isToolGroupsAutoCollapsed]);

  useEffect(() => {
    const { finalAssistantId, groupIds, itemIds } =
      finalAssistantCollapseTarget;
    if (
      !finalAssistantId ||
      (groupIds.length === 0 && itemIds.length === 0) ||
      isThinking ||
      userDisabledAutoCollapseRef.current
    ) {
      return;
    }
    const collapseKey = `${threadId ?? "no-thread"}:${finalAssistantId}:${[
      ...groupIds,
      ...itemIds,
    ].join("|")}`;
    if (finalMessageAutoCollapseRef.current === collapseKey) {
      return;
    }
    finalMessageAutoCollapseRef.current = collapseKey;

    const groupsToCollapse = groupIds;
    if (groupsToCollapse.length === 0) {
      setExpandedItems((prev) => {
        if (prev.size === 0) {
          return prev;
        }
        let changed = false;
        const next = new Set(prev);
        itemIds.forEach((id) => {
          if (next.delete(id)) {
            changed = true;
          }
        });
        return changed ? next : prev;
      });
      return;
    }

    setCollapsedToolGroups((prev) => {
      let changed = false;
      const next = new Set(prev);
      groupsToCollapse.forEach((id) => {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
    setExpandedItems((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      let changed = false;
      const next = new Set(prev);
      itemIds.forEach((id) => {
        if (next.delete(id)) {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [
    finalAssistantCollapseTarget,
    isThinking,
    threadId,
  ]);

  const planFollowup = useMemo(() => {
    if (!onPlanAccept || !onPlanSubmitChanges) {
      return { shouldShow: false, planItemId: null };
    }

    const candidate = computePlanFollowupState({
      threadId,
      items,
      isThinking,
      hasVisibleUserInputRequest,
    });

    if (threadId && candidate.planItemId) {
      if (dismissedPlanFollowupByThread[threadId] === candidate.planItemId) {
        return { ...candidate, shouldShow: false };
      }
    }

    return candidate;
  }, [
    dismissedPlanFollowupByThread,
    hasVisibleUserInputRequest,
    isThinking,
    items,
    onPlanAccept,
    onPlanSubmitChanges,
    threadId,
  ]);

  const dismissPlanFollowup = useCallback(() => {
    if (!threadId || !planFollowup.planItemId) {
      return;
    }
    setDismissedPlanFollowupByThread((prev) => ({
      ...prev,
      [threadId]: planFollowup.planItemId!,
    }));
  }, [planFollowup.planItemId, threadId]);

  return {
    bottomRef,
    containerRef,
    updateAutoScroll,
    requestAutoScroll,
    showScrollToLatest,
    scrollToLatest,
    hiddenBeforeCount,
    hiddenAfterCount,
    loadEarlierHistory: loadEarlier,
    loadLaterHistory: loadLater,
    revealHistoryItemAtIndex: revealItemAtIndex,
    revealGroupedItem,
    expandedItems,
    toggleExpanded,
    collapsedToolGroups: isToolGroupsAutoCollapsed
      ? new Set(
          groupedItems
            .filter(
              (entry) =>
                entry.kind === "toolGroup" || entry.kind === "processGroup",
            )
            .map((entry) => entry.group.id)
            .filter(
              (id) =>
                collapsedToolGroups.has(id) ||
                !manuallyToggledToolGroupsRef.current.has(id),
            ),
        )
      : collapsedToolGroups,
    toggleToolGroup,
    isToolGroupsAutoCollapsed,
    setToolGroupsAutoCollapsed,
    copiedMessageId,
    handleCopyMessage,
    handleQuoteMessage,
    reasoningMetaById,
    latestReasoningLabel,
    groupedItems,
    planFollowup,
    dismissPlanFollowup,
  };
}
