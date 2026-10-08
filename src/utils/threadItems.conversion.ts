import type { ConversationItem } from "../types";
import { parseSubagentCheckpointEnvelopes } from "./subagentCheckpointEnvelope";
import { extractAttachedFilesFromText, isImageAttachment } from "./attachments";
import { parseCollabToolCallItem } from "./threadItems.collab";
import { asNumber, asString } from "./threadItems.shared";

function extractCreatedAt(item: Record<string, unknown>) {
  const raw =
    item.createdAt ??
    item.created_at ??
    item.timestamp ??
    item.time ??
    item.created;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 0 && raw < 10_000_000_000 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const parsedNumber = Number(raw);
    if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
      return parsedNumber < 10_000_000_000 ? parsedNumber * 1000 : parsedNumber;
    }
    const parsedDate = Date.parse(raw);
    if (Number.isFinite(parsedDate)) {
      return parsedDate;
    }
  }
  return undefined;
}

function extractImageInputValue(input: Record<string, unknown>) {
  const value =
    asString(input.url ?? "") ||
    asString(input.path ?? "") ||
    asString(input.value ?? "") ||
    asString(input.data ?? "") ||
    asString(input.source ?? "");
  return value.trim();
}

function readNestedRecord(
  item: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = item[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function firstNonEmptyString(
  item: Record<string, unknown>,
  keys: string[],
) {
  for (const key of keys) {
    const value = asString(item[key] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function formatAgentLabel(source: Record<string, unknown>) {
  const name = firstNonEmptyString(source, [
    "name",
    "agentName",
    "agent_name",
    "nickname",
    "agentNickname",
    "agent_nickname",
    "id",
    "agentId",
    "agent_id",
  ]);
  const role = firstNonEmptyString(source, [
    "role",
    "agentRole",
    "agent_role",
    "description",
  ]);
  if (name && role) {
    return `${name} [${role}]`;
  }
  return name || role;
}

function buildProcessItem(
  item: Record<string, unknown>,
  processType: Extract<ConversationItem, { kind: "process" }>["processType"],
): Extract<ConversationItem, { kind: "process" }> | null {
  const id = asString(item.id);
  if (!id) {
    return null;
  }

  const skill = readNestedRecord(item, ["skill", "skillTrigger", "skill_trigger"]);
  const agent = readNestedRecord(item, ["agent", "subAgent", "sub_agent", "subagent"]);
  const source = processType === "skillTriggered" ? skill ?? item : agent ?? item;
  const explicitLabel = firstNonEmptyString(item, ["label", "title", "message"]);
  const label =
    processType === "skillTriggered"
      ? firstNonEmptyString(source, ["name", "skillName", "skill_name", "id"])
      : formatAgentLabel(source);
  const detail = firstNonEmptyString(item, [
    "detail",
    "reason",
    "trigger",
    "description",
  ]);

  if (!label && !explicitLabel) {
    return null;
  }

  return {
    id,
    kind: "process",
    processType,
    label: label || explicitLabel,
    detail: detail || undefined,
    status: firstNonEmptyString(item, ["status", "state"]) || undefined,
  };
}

function processTypeFromItemType(
  type: string,
): Extract<ConversationItem, { kind: "process" }>["processType"] | null {
  const normalized = type.replace(/[_\s-]/g, "").toLowerCase();
  if (
    normalized === "skilltriggered" ||
    normalized === "skillselected" ||
    normalized === "skilluse" ||
    normalized === "skillused"
  ) {
    return "skillTriggered";
  }
  if (
    normalized === "agentselected" ||
    normalized === "agentswitched" ||
    normalized === "agentassigned"
  ) {
    return "agentSelected";
  }
  if (
    normalized === "agentspawned" ||
    normalized === "subagentspawned" ||
    normalized === "agentstarted" ||
    normalized === "subagentstarted"
  ) {
    return "agentSpawned";
  }
  return null;
}

function parseUserInputs(inputs: Array<Record<string, unknown>>) {
  const textParts: string[] = [];
  const images: string[] = [];
  const attachments: string[] = [];
  inputs.forEach((input) => {
    const type = asString(input.type);
    if (type === "text") {
      const text = asString(input.text);
      if (text) {
        const parsed = extractAttachedFilesFromText(text);
        if (parsed.text) {
          textParts.push(parsed.text);
        }
        attachments.push(...parsed.attachments.map((attachment) => attachment.source ?? attachment.name));
      }
      return;
    }
    if (type === "skill") {
      const name = asString(input.name);
      if (name) {
        textParts.push(`$${name}`);
      }
      return;
    }
    if (type === "image" || type === "localImage") {
      const value = extractImageInputValue(input);
      if (value) {
        if (isImageAttachment(value)) {
          images.push(value);
        } else {
          attachments.push(value);
        }
      }
    }
  });
  return { text: textParts.join(" ").trim(), images, attachments };
}

function buildUserConversationItem(
  item: Record<string, unknown>,
  id: string,
): ConversationItem {
  const content = Array.isArray(item.content) ? item.content : [];
  const { text, images, attachments } = parseUserInputs(
    content as Array<Record<string, unknown>>,
  );
  const onlyInput = content.length === 1 ? content[0] : null;
  const checkpointText =
    onlyInput && asString((onlyInput as Record<string, unknown>).type) === "text"
      ? asString((onlyInput as Record<string, unknown>).text)
      : "";
  const checkpoints = checkpointText
    ? parseSubagentCheckpointEnvelopes(checkpointText)
    : null;
  if (checkpoints) {
    return {
      id,
      kind: "subagentCheckpoint",
      createdAt: extractCreatedAt(item),
      checkpoints,
    };
  }
  return {
    id,
    kind: "message",
    role: "user",
    text,
    createdAt: extractCreatedAt(item),
    images: images.length > 0 ? images : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

export function buildConversationItem(
  item: Record<string, unknown>,
): ConversationItem | null {
  const type = asString(item.type);
  const id = asString(item.id);
  if (!id || !type) {
    return null;
  }
  if (type === "agentMessage") {
    return null;
  }
  const processType = processTypeFromItemType(type);
  if (processType) {
    return buildProcessItem(item, processType);
  }
  if (type === "userMessage") {
    return buildUserConversationItem(item, id);
  }
  if (type === "reasoning") {
    const summary = asString(item.summary ?? "");
    const content = Array.isArray(item.content)
      ? item.content.map((entry) => asString(entry)).join("\n")
      : asString(item.content ?? "");
    return { id, kind: "reasoning", summary, content };
  }
  if (type === "plan") {
    return {
      id,
      kind: "tool",
      toolType: "plan",
      title: "Plan",
      detail: asString(item.status ?? ""),
      status: asString(item.status ?? ""),
      output: asString(item.text ?? ""),
    };
  }
  if (type === "commandExecution") {
    const command = Array.isArray(item.command)
      ? item.command.map((part) => asString(part)).join(" ")
      : asString(item.command ?? "");
    const durationMs = asNumber(item.durationMs ?? item.duration_ms);
    return {
      id,
      kind: "tool",
      toolType: type,
      title: command ? `Command: ${command}` : "Command",
      detail: asString(item.cwd ?? ""),
      status: asString(item.status ?? ""),
      output: asString(item.aggregatedOutput ?? ""),
      durationMs,
    };
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const normalizedChanges = changes
      .map((change) => {
        const path = asString(change?.path ?? "");
        const kind = change?.kind as Record<string, unknown> | string | undefined;
        const kindType =
          typeof kind === "string"
            ? kind
            : typeof kind === "object" && kind
              ? asString((kind as Record<string, unknown>).type ?? "")
              : "";
        const normalizedKind = kindType ? kindType.toLowerCase() : "";
        const diff = asString(change?.diff ?? "");
        return { path, kind: normalizedKind || undefined, diff: diff || undefined };
      })
      .filter((change) => change.path);
    const formattedChanges = normalizedChanges
      .map((change) => {
        const prefix =
          change.kind === "add"
            ? "A"
            : change.kind === "delete"
              ? "D"
              : change.kind
                ? "M"
                : "";
        return [prefix, change.path].filter(Boolean).join(" ");
      })
      .filter(Boolean);
    const paths = formattedChanges.join(", ");
    const diffOutput = normalizedChanges
      .map((change) => change.diff ?? "")
      .filter(Boolean)
      .join("\n\n");
    return {
      id,
      kind: "tool",
      toolType: type,
      title: "File changes",
      detail: paths || "Pending changes",
      status: asString(item.status ?? ""),
      output: diffOutput,
      changes: normalizedChanges,
    };
  }
  if (type === "mcpToolCall") {
    const server = asString(item.server ?? "");
    const tool = asString(item.tool ?? "");
    const args = item.arguments ? JSON.stringify(item.arguments, null, 2) : "";
    return {
      id,
      kind: "tool",
      toolType: type,
      title: `Tool: ${server}${tool ? ` / ${tool}` : ""}`,
      detail: args,
      status: asString(item.status ?? ""),
      output: asString(item.result ?? item.error ?? ""),
    };
  }
  if (type === "dynamicToolCall") {
    const namespace = asString(item.namespace ?? "").trim();
    const tool = asString(item.tool ?? "").trim();
    const args =
      typeof item.arguments === "string"
        ? item.arguments
        : item.arguments !== undefined
          ? JSON.stringify(item.arguments, null, 2)
          : "";
    const contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
    const output = contentItems
      .map((contentItem) => {
        const content = contentItem as Record<string, unknown>;
        if (asString(content.type) === "inputText") {
          return asString(content.text);
        }
        if (asString(content.type) === "inputImage") {
          return asString(content.imageUrl);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    const rawLineChangeStats = item.lineChangeStats as
      | Record<string, unknown>
      | undefined;
    const additions = asNumber(rawLineChangeStats?.additions);
    const deletions = asNumber(rawLineChangeStats?.deletions);
    const lineChangeStats =
      additions !== null && deletions !== null && (additions > 0 || deletions > 0)
        ? { additions, deletions }
        : undefined;
    return {
      id,
      kind: "tool",
      toolType: type,
      title: `Tool: ${[namespace, tool].filter(Boolean).join(" / ") || "custom"}`,
      detail: args,
      status: asString(item.status ?? ""),
      output,
      durationMs: asNumber(item.durationMs ?? item.duration_ms),
      ...(lineChangeStats ? { lineChangeStats } : {}),
    };
  }
  if (type === "collabToolCall" || type === "collabAgentToolCall") {
    return parseCollabToolCallItem(item);
  }
  if (type === "webSearch") {
    const status = asString(item.status ?? "").trim();
    return {
      id,
      kind: "tool",
      toolType: type,
      title: "Web search",
      detail: asString(item.query ?? ""),
      status: status || "completed",
      output: "",
    };
  }
  if (type === "imageView") {
    return {
      id,
      kind: "tool",
      toolType: type,
      title: "Image view",
      detail: asString(item.path ?? ""),
      status: "",
      output: "",
    };
  }
  if (type === "contextCompaction") {
    const status = asString(item.status ?? "").trim();
    return {
      id,
      kind: "tool",
      toolType: type,
      title: "Context compaction",
      detail: "Compacting conversation context to fit token limits.",
      status: status || "completed",
      output: "",
    };
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return {
      id,
      kind: "review",
      state: type === "enteredReviewMode" ? "started" : "completed",
      text: asString(item.review ?? ""),
    };
  }
  return null;
}

export function buildConversationItemFromThreadItem(
  item: Record<string, unknown>,
): ConversationItem | null {
  const type = asString(item.type);
  const id = asString(item.id);
  if (!id || !type) {
    return null;
  }
  if (type === "userMessage") {
    return buildUserConversationItem(item, id);
  }
  if (type === "agentMessage") {
    const phase = asString(item.phase).trim();
    return {
      id,
      kind: "message",
      role: "assistant",
      text: asString(item.text),
      ...(phase ? { phase } : {}),
      createdAt: extractCreatedAt(item),
    };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((entry) => asString(entry)).join("\n")
      : asString(item.summary ?? "");
    const content = Array.isArray(item.content)
      ? item.content.map((entry) => asString(entry)).join("\n")
      : asString(item.content ?? "");
    return { id, kind: "reasoning", summary, content };
  }
  return buildConversationItem(item);
}

export function buildItemsFromThread(thread: Record<string, unknown>) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const items: ConversationItem[] = [];
  turns.forEach((turn) => {
    const turnRecord = turn as Record<string, unknown>;
    const turnId = asString(turnRecord.id).trim() || undefined;
    const turnStartedAt = extractCreatedAt({ timestamp: turnRecord.startedAt });
    const turnCompletedAt = extractCreatedAt({ timestamp: turnRecord.completedAt });
    const turnItems = Array.isArray(turnRecord.items)
      ? (turnRecord.items as Record<string, unknown>[])
      : [];
    turnItems.forEach((item) => {
      const converted = buildConversationItemFromThreadItem(item);
      if (converted) {
        const fallbackCreatedAt =
          converted.kind === "message" && converted.createdAt === undefined
            ? converted.role === "user"
              ? turnStartedAt
              : asString(item.phase) === "final_answer"
                ? turnCompletedAt
                : undefined
            : undefined;
        items.push({
          ...converted,
          ...(fallbackCreatedAt !== undefined
            ? { createdAt: fallbackCreatedAt }
            : {}),
          turnId,
        });
      }
    });
  });
  return items;
}

export function isReviewingFromThread(thread: Record<string, unknown>) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  let reviewing = false;
  turns.forEach((turn) => {
    const turnRecord = turn as Record<string, unknown>;
    const turnItems = Array.isArray(turnRecord.items)
      ? (turnRecord.items as Record<string, unknown>[])
      : [];
    turnItems.forEach((item) => {
      const type = asString(item?.type ?? "");
      if (type === "enteredReviewMode") {
        reviewing = true;
      } else if (type === "exitedReviewMode") {
        reviewing = false;
      }
    });
  });
  return reviewing;
}
