import type { SubagentCheckpointSyncMode } from "@/types";
import { SUBAGENT_CHECKPOINT_MAX_TEXT_LENGTH } from "@utils/subagentCheckpointEnvelope";

export { SUBAGENT_CHECKPOINT_MAX_TEXT_LENGTH } from "@utils/subagentCheckpointEnvelope";

export type SubagentCheckpointKind = "progress" | "final";
export type SubagentCheckpointDeliveryState =
  | "pending"
  | "delivering"
  | "delivered"
  | "failed"
  | "suppressed";

export type SubagentCheckpoint = {
  id: string;
  workspaceId: string;
  parentThreadId: string;
  childThreadId: string;
  childTurnId: string | null;
  sourceItemId: string;
  kind: SubagentCheckpointKind;
  text: string;
  sequence: number;
  createdAt: number;
  deliveryState: SubagentCheckpointDeliveryState;
  deliveryMode: "steer" | "queued" | null;
  attempts: number;
  lastError: string | null;
};

/** Groups progress/final envelopes that describe the same child result item. */
export function checkpointResultKey(
  checkpoint: Pick<SubagentCheckpoint, "childThreadId" | "sourceItemId">,
) {
  return `${checkpoint.childThreadId}:${checkpoint.sourceItemId}`;
}

export function checkpointTextEquivalent(left: string, right: string) {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

export const SUBAGENT_CHECKPOINT_PROGRESS_LIMIT = 8;

export function checkpointThrottleMs(mode: SubagentCheckpointSyncMode) {
  if (mode === "continuous") {
    return 3_000;
  }
  if (mode === "checkpoints") {
    return 10_000;
  }
  return Number.POSITIVE_INFINITY;
}

export function shouldCreateCheckpoint({
  mode,
  kind,
  progressCount,
}: {
  mode: SubagentCheckpointSyncMode;
  kind: SubagentCheckpointKind;
  progressCount: number;
}) {
  if (mode === "off") return false;
  if (kind === "final") {
    return true;
  }
  return mode !== "finalOnly" && progressCount < SUBAGENT_CHECKPOINT_PROGRESS_LIMIT;
}

export function normalizeCheckpointText(text: string) {
  const normalized = text.trim();
  if (normalized.length <= SUBAGENT_CHECKPOINT_MAX_TEXT_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, SUBAGENT_CHECKPOINT_MAX_TEXT_LENGTH - 1)}…`;
}

function escapeXmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildCheckpointId({
  childThreadId,
  sourceItemId,
  kind,
}: Pick<SubagentCheckpoint, "childThreadId" | "sourceItemId" | "kind">) {
  return `${childThreadId}:${sourceItemId}:${kind}`;
}

export function buildCheckpointInjection(
  checkpoint: SubagentCheckpoint,
  childName?: string | null,
) {
  const attributes = [
    `checkpoint_id="${escapeXmlAttribute(checkpoint.id)}"`,
    `child_thread_id="${escapeXmlAttribute(checkpoint.childThreadId)}"`,
    `priority="${checkpoint.kind === "final" ? "final" : "normal"}"`,
    `sequence="${checkpoint.sequence}"`,
    `text_length="${checkpoint.text.length}"`,
  ];
  const normalizedName = childName?.trim();
  if (normalizedName) {
    attributes.splice(2, 0, `child_name="${escapeXmlAttribute(normalizedName)}"`);
  }
  return `<subagent_checkpoint ${attributes.join(" ")}>\n${checkpoint.text}\n</subagent_checkpoint>`;
}

export function createSubagentCheckpoint({
  workspaceId,
  parentThreadId,
  childThreadId,
  childTurnId,
  sourceItemId,
  kind,
  text,
  sequence,
  createdAt = Date.now(),
}: {
  workspaceId: string;
  parentThreadId: string;
  childThreadId: string;
  childTurnId: string | null;
  sourceItemId: string;
  kind: SubagentCheckpointKind;
  text: string;
  sequence: number;
  createdAt?: number;
}): SubagentCheckpoint | null {
  const normalizedText = normalizeCheckpointText(text);
  if (!workspaceId || !parentThreadId || !childThreadId || !sourceItemId || !normalizedText) {
    return null;
  }
  if (parentThreadId === childThreadId) {
    return null;
  }
  return {
    id: buildCheckpointId({ childThreadId, sourceItemId, kind }),
    workspaceId,
    parentThreadId,
    childThreadId,
    childTurnId,
    sourceItemId,
    kind,
    text: normalizedText,
    sequence,
    createdAt,
    deliveryState: "pending",
    deliveryMode: null,
    attempts: 0,
    lastError: null,
  };
}
