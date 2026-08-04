import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { CHAT_SCROLLBACK_DEFAULT } from "@utils/chatScrollback";

const HISTORY_SCROLL_THRESHOLD_PX = 24;

type HistoryRange = {
  start: number;
  end: number;
};

type HistoryWindowState = {
  threadId: string | null;
  range: HistoryRange | null;
  totalItems: number;
  batchSize: number;
};

type ScrollRestore = {
  previousScrollHeight: number;
  previousScrollTop: number;
  anchor: HistoryAnchor | null;
};

type HistoryAnchor = {
  key: string;
  top: number;
};

function normalizeBatchSize(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return CHAT_SCROLLBACK_DEFAULT;
  }
  return Math.max(1, Math.floor(value));
}

function buildLatestRange(totalItems: number, batchSize: number): HistoryRange {
  return {
    start: Math.max(0, totalItems - batchSize),
    end: totalItems,
  };
}

function normalizeRange(
  range: HistoryRange,
  totalItems: number,
): HistoryRange {
  const end = Math.min(totalItems, Math.max(0, range.end));
  const start = Math.min(end, Math.max(0, range.start));
  return { start, end };
}

function findFirstVisibleHistoryAnchor(
  container: HTMLDivElement,
  selector: string,
) {
  const anchors = Array.from(
    container.querySelectorAll<HTMLElement>(selector),
  );
  const containerRect = container.getBoundingClientRect();
  if (containerRect.height <= 0) {
    return null;
  }
  return (
    anchors.find((anchor) => {
      const rect = anchor.getBoundingClientRect();
      return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    }) ?? anchors[0] ?? null
  );
}

function captureHistoryAnchor(
  container: HTMLDivElement,
  selector: string | undefined,
): HistoryAnchor | null {
  if (!selector) {
    return null;
  }
  const anchor = findFirstVisibleHistoryAnchor(container, selector);
  const key = anchor?.dataset.historyAnchor;
  return anchor && key
    ? { key, top: anchor.getBoundingClientRect().top }
    : null;
}

function findHistoryAnchorByKey(
  container: HTMLDivElement,
  selector: string,
  key: string,
) {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
    (anchor) => anchor.dataset.historyAnchor === key,
  );
}

export function useMessageHistoryWindow<T>({
  items,
  threadId,
  batchSize: batchSizeValue,
  containerRef,
  historyAnchorSelector,
}: {
  items: T[];
  threadId: string | null;
  batchSize?: number | null;
  containerRef: RefObject<HTMLDivElement | null>;
  historyAnchorSelector?: string;
}) {
  const batchSize = normalizeBatchSize(batchSizeValue);
  const [windowState, setWindowState] = useState<HistoryWindowState>(() => ({
    threadId,
    range: buildLatestRange(items.length, batchSize),
    totalItems: items.length,
    batchSize,
  }));
  const pendingScrollRestoreRef = useRef<ScrollRestore | null>(null);
  const pendingScrollLatestRef = useRef(false);
  const windowUpdatePendingRef = useRef(false);

  const effectiveRange = useMemo(() => {
    if (windowState.threadId !== threadId || windowState.range === null) {
      return buildLatestRange(items.length, batchSize);
    }
    return normalizeRange(windowState.range, items.length);
  }, [batchSize, items.length, threadId, windowState]);

  useLayoutEffect(() => {
    setWindowState((previous) => {
      if (
        previous.threadId !== threadId ||
        previous.range === null ||
        previous.batchSize !== batchSize
      ) {
        return {
          threadId,
          range: buildLatestRange(items.length, batchSize),
          totalItems: items.length,
          batchSize,
        };
      }

      let range = normalizeRange(previous.range, items.length);
      if (items.length > previous.totalItems) {
        if (previous.totalItems === 0) {
          range = buildLatestRange(items.length, batchSize);
        } else if (range.end >= previous.totalItems) {
          range = {
            start: range.start,
            end: items.length,
          };
        }
      }
      if (
        previous.totalItems === items.length &&
        previous.range.start === range.start &&
        previous.range.end === range.end
      ) {
        return previous;
      }
      return {
        threadId,
        range,
        totalItems: items.length,
        batchSize,
      };
    });
  }, [batchSize, items.length, threadId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const restore = pendingScrollRestoreRef.current;
    if (container && restore) {
      if (restore.anchor && historyAnchorSelector) {
        const currentAnchor = findHistoryAnchorByKey(
          container,
          historyAnchorSelector,
          restore.anchor.key,
        );
        if (currentAnchor) {
          container.scrollTop =
            restore.previousScrollTop +
            currentAnchor.getBoundingClientRect().top -
              restore.anchor.top;
        }
      } else {
        container.scrollTop =
          container.scrollHeight -
          restore.previousScrollHeight +
          restore.previousScrollTop;
      }
      pendingScrollRestoreRef.current = null;
    }
    if (container && pendingScrollLatestRef.current) {
      container.scrollTop = container.scrollHeight;
      pendingScrollLatestRef.current = false;
    }
    windowUpdatePendingRef.current = false;
  }, [
    containerRef,
    effectiveRange.end,
    effectiveRange.start,
    historyAnchorSelector,
  ]);

  const loadEarlier = useCallback(() => {
    if (effectiveRange.start <= 0 || windowUpdatePendingRef.current) {
      return;
    }
    const container = containerRef.current;
    if (container) {
      pendingScrollRestoreRef.current = {
        previousScrollHeight: container.scrollHeight,
        previousScrollTop: container.scrollTop,
        anchor: captureHistoryAnchor(container, historyAnchorSelector),
      };
    }
    windowUpdatePendingRef.current = true;
    setWindowState({
      threadId,
      range: {
        start: Math.max(0, effectiveRange.start - batchSize),
        end: effectiveRange.end,
      },
      totalItems: items.length,
      batchSize,
    });
  }, [
    batchSize,
    containerRef,
    effectiveRange,
    historyAnchorSelector,
    items.length,
    threadId,
  ]);

  const loadLater = useCallback(() => {
    if (effectiveRange.end >= items.length || windowUpdatePendingRef.current) {
      return;
    }
    windowUpdatePendingRef.current = true;
    setWindowState({
      threadId,
      range: {
        start: effectiveRange.start,
        end: Math.min(items.length, effectiveRange.end + batchSize),
      },
      totalItems: items.length,
      batchSize,
    });
  }, [batchSize, effectiveRange, items.length, threadId]);

  const handleHistoryScroll = useCallback(
    (container: HTMLDivElement) => {
      if (
        effectiveRange.start > 0 &&
        container.scrollTop <= HISTORY_SCROLL_THRESHOLD_PX
      ) {
        loadEarlier();
        return;
      }
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (
        effectiveRange.end < items.length &&
        distanceFromBottom <= HISTORY_SCROLL_THRESHOLD_PX
      ) {
        loadLater();
      }
    },
    [effectiveRange.end, effectiveRange.start, items.length, loadEarlier, loadLater],
  );

  const revealItemAtIndex = useCallback(
    (itemIndex: number) => {
      if (
        itemIndex < 0 ||
        itemIndex >= items.length ||
        (itemIndex >= effectiveRange.start && itemIndex < effectiveRange.end)
      ) {
        return;
      }
      const halfBatch = Math.floor(batchSize / 2);
      const maxStart = Math.max(0, items.length - batchSize);
      const start = Math.min(maxStart, Math.max(0, itemIndex - halfBatch));
      windowUpdatePendingRef.current = true;
      setWindowState({
        threadId,
        range: {
          start,
          end: Math.min(items.length, start + batchSize),
        },
        totalItems: items.length,
        batchSize,
      });
    },
    [batchSize, effectiveRange.end, effectiveRange.start, items.length, threadId],
  );

  const showLatest = useCallback(() => {
    const latestRange = buildLatestRange(items.length, batchSize);
    pendingScrollLatestRef.current = true;
    windowUpdatePendingRef.current = true;
    setWindowState({
      threadId,
      range: latestRange,
      totalItems: items.length,
      batchSize,
    });
  }, [batchSize, items.length, threadId]);

  return {
    visibleItems: items.slice(effectiveRange.start, effectiveRange.end),
    hiddenBeforeCount: effectiveRange.start,
    hiddenAfterCount: items.length - effectiveRange.end,
    handleHistoryScroll,
    loadEarlier,
    loadLater,
    revealItemAtIndex,
    showLatest,
  };
}
