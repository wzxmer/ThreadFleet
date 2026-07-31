import type { ConversationItem, TurnExecutionStatus } from "@/types";
import type { ModelActivityState } from "../components/ModelActivityCore";

type ResolveModelActivityStateArgs = {
  items: ConversationItem[];
  isProcessing: boolean;
  hasPendingInteraction?: boolean;
  turnStatus?: TurnExecutionStatus | null;
  activeTurnIds?: string[];
};

const PROCESSING_STATUS = /(pending|running|processing|started|in[_\s-]?progress|exploring)/i;

const itemIsExecuting = (item: ConversationItem) => {
  if (item.kind === "explore") {
    return item.status === "exploring";
  }
  if (item.kind === "review") {
    return item.state === "started";
  }
  if (
    item.kind === "tool" ||
    item.kind === "process" ||
    item.kind === "diff"
  ) {
    return PROCESSING_STATUS.test(item.status ?? "");
  }
  return false;
};

export function resolveModelActivityState({
  items,
  isProcessing,
  hasPendingInteraction = false,
  turnStatus = null,
  activeTurnIds = [],
}: ResolveModelActivityStateArgs): ModelActivityState {
  if (!isProcessing) {
    if (turnStatus === "failed" || turnStatus === "interrupted") {
      return "failed";
    }
    if (turnStatus === "completed") {
      return "completed";
    }
    return "idle";
  }

  if (hasPendingInteraction) {
    return "waiting";
  }

  const activeTurnIdSet = new Set(activeTurnIds);
  const latestActiveItem = [...items]
    .reverse()
    .find(
      (item) =>
        activeTurnIdSet.size === 0 ||
        Boolean(item.turnId && activeTurnIdSet.has(item.turnId)),
    );

  return latestActiveItem && itemIsExecuting(latestActiveItem)
    ? "executing"
    : "thinking";
}
