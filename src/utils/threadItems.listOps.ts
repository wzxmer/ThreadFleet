import type { ConversationItem } from "../types";
import {
  normalizeThreadTimestamp,
  sameMessageAttachments,
  sameMessageImages,
} from "./threadItems.shared";

function mergeUserInputQuestions(
  existing: Extract<ConversationItem, { kind: "userInput" }>["questions"],
  incoming: Extract<ConversationItem, { kind: "userInput" }>["questions"],
) {
  const existingById = new Map(existing.map((question) => [question.id, question]));
  const merged = incoming.map((question) => {
    const prior = existingById.get(question.id);
    if (!prior) {
      return question;
    }
    const incomingHasAnswers = question.answers.length > 0;
    return {
      ...prior,
      ...question,
      header: question.header.trim() ? question.header : prior.header,
      question: question.question.trim() ? question.question : prior.question,
      answers: incomingHasAnswers ? question.answers : prior.answers,
    };
  });
  const incomingIds = new Set(incoming.map((question) => question.id));
  const missingExisting = existing.filter((question) => !incomingIds.has(question.id));
  return [...merged, ...missingExisting];
}

function isMatchingLocalUserEcho(
  remote: ConversationItem,
  local: ConversationItem,
) {
  return (
    remote.kind === "message" &&
    remote.role === "user" &&
    local.kind === "message" &&
    local.role === "user" &&
    local.id.startsWith("local-user-") &&
    remote.text === local.text &&
    sameMessageImages(remote.images, local.images) &&
    sameMessageAttachments(remote.attachments, local.attachments)
  );
}

function isMatchingLiveLocalUserEcho(
  remote: ConversationItem,
  local: ConversationItem,
) {
  return (
    remote.kind === "message" &&
    remote.role === "user" &&
    local.kind === "message" &&
    local.role === "user" &&
    local.id.startsWith("local-user-") &&
    remote.text.trim() === local.text.trim()
  );
}

export function upsertItem(list: ConversationItem[], item: ConversationItem) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    if (item.kind === "message" && item.role === "user") {
      const localIndex = list.findIndex(
        (entry) => isMatchingLiveLocalUserEcho(item, entry),
      );
      if (localIndex >= 0) {
        const next = [...list];
        next[localIndex] = item;
        return next;
      }
    }
    return [...list, item];
  }
  const existing = list[index];
  const next = [...list];

  if (existing.kind !== item.kind) {
    next[index] = item;
    return next;
  }

  if (existing.kind === "message" && item.kind === "message") {
    const existingText = existing.text ?? "";
    const incomingText = item.text ?? "";
    next[index] = {
      ...existing,
      ...item,
      text: incomingText.length >= existingText.length ? incomingText : existingText,
      images: item.images?.length ? item.images : existing.images,
      attachments: item.attachments?.length ? item.attachments : existing.attachments,
    };
    return next;
  }

  if (existing.kind === "userInput" && item.kind === "userInput") {
    next[index] = {
      ...existing,
      ...item,
      questions: mergeUserInputQuestions(existing.questions, item.questions),
    };
    return next;
  }

  if (existing.kind === "reasoning" && item.kind === "reasoning") {
    const existingSummary = existing.summary ?? "";
    const incomingSummary = item.summary ?? "";
    const existingContent = existing.content ?? "";
    const incomingContent = item.content ?? "";
    next[index] = {
      ...existing,
      ...item,
      summary:
        incomingSummary.length >= existingSummary.length
          ? incomingSummary
          : existingSummary,
      content:
        incomingContent.length >= existingContent.length
          ? incomingContent
          : existingContent,
    };
    return next;
  }

  if (existing.kind === "tool" && item.kind === "tool") {
    const existingOutput = existing.output ?? "";
    const incomingOutput = item.output ?? "";
    const hasIncomingOutput = incomingOutput.trim().length > 0;
    const hasIncomingChanges = (item.changes?.length ?? 0) > 0;
    next[index] = {
      ...existing,
      ...item,
      title: item.title?.trim() ? item.title : existing.title,
      detail: item.detail?.trim() ? item.detail : existing.detail,
      status: item.status?.trim() ? item.status : existing.status,
      output: hasIncomingOutput ? incomingOutput : existingOutput,
      changes: hasIncomingChanges ? item.changes : existing.changes,
      lineChangeStats: item.lineChangeStats ?? existing.lineChangeStats,
      durationMs:
        typeof item.durationMs === "number" ? item.durationMs : existing.durationMs,
    };
    return next;
  }

  if (existing.kind === "diff" && item.kind === "diff") {
    const existingDiff = existing.diff ?? "";
    const incomingDiff = item.diff ?? "";
    next[index] = {
      ...existing,
      ...item,
      title: item.title?.trim() ? item.title : existing.title,
      status: item.status?.trim() ? item.status : existing.status,
      diff: incomingDiff.length >= existingDiff.length ? incomingDiff : existingDiff,
    };
    return next;
  }

  if (existing.kind === "review" && item.kind === "review") {
    const existingText = existing.text ?? "";
    const incomingText = item.text ?? "";
    next[index] = {
      ...existing,
      ...item,
      text: incomingText.length >= existingText.length ? incomingText : existingText,
    };
    return next;
  }

  next[index] = { ...existing, ...item };
  return next;
}

export function getThreadTimestamp(thread: Record<string, unknown>) {
  const raw =
    (thread.updatedAt ?? thread.updated_at ?? thread.createdAt ?? thread.created_at) ??
    0;
  return normalizeThreadTimestamp(raw);
}

export function getThreadCreatedTimestamp(thread: Record<string, unknown>) {
  const raw = (thread.createdAt ?? thread.created_at) ?? 0;
  return normalizeThreadTimestamp(raw);
}

export function previewThreadName(text: string, fallback: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed;
}

function chooseRicherItem(remote: ConversationItem, local: ConversationItem) {
  if (remote.kind !== local.kind) {
    return remote;
  }
  if (remote.kind === "message" && local.kind === "message") {
    const richer = local.text.length > remote.text.length ? local : remote;
    const phase = remote.phase ?? local.phase;
    const turnId = remote.turnId ?? local.turnId;
    return {
      ...richer,
      ...(phase ? { phase } : {}),
      ...(turnId ? { turnId } : {}),
    };
  }
  if (remote.kind === "userInput" && local.kind === "userInput") {
    const remoteScore = remote.questions.reduce(
      (total, question) =>
        total + question.question.length + question.answers.join("\n").length,
      0,
    );
    const localScore = local.questions.reduce(
      (total, question) =>
        total + question.question.length + question.answers.join("\n").length,
      0,
    );
    return localScore > remoteScore ? local : remote;
  }
  if (remote.kind === "reasoning" && local.kind === "reasoning") {
    const remoteLength = remote.summary.length + remote.content.length;
    const localLength = local.summary.length + local.content.length;
    return localLength > remoteLength ? local : remote;
  }
  if (remote.kind === "tool" && local.kind === "tool") {
    const remoteOutput = remote.output ?? "";
    const localOutput = local.output ?? "";
    const hasRemoteOutput = remoteOutput.trim().length > 0;
    const remoteStatus = remote.status?.trim();
    return {
      ...remote,
      status: remoteStatus ? remote.status : local.status,
      output: hasRemoteOutput ? remoteOutput : localOutput,
      changes: remote.changes ?? local.changes,
      lineChangeStats: remote.lineChangeStats ?? local.lineChangeStats,
      collabSender: remote.collabSender ?? local.collabSender,
      collabReceiver: remote.collabReceiver ?? local.collabReceiver,
      collabModel: remote.collabModel ?? local.collabModel,
      collabReasoningEffort:
        remote.collabReasoningEffort ?? local.collabReasoningEffort,
      collabReceivers:
        (remote.collabReceivers?.length ?? 0) > 0
          ? remote.collabReceivers
          : local.collabReceivers,
      collabStatuses:
        (remote.collabStatuses?.length ?? 0) > 0
          ? remote.collabStatuses
          : local.collabStatuses,
    };
  }
  if (remote.kind === "diff" && local.kind === "diff") {
    const useLocal = local.diff.length > remote.diff.length;
    const remoteStatus = remote.status?.trim();
    return {
      ...remote,
      diff: useLocal ? local.diff : remote.diff,
      status: remoteStatus ? remote.status : local.status,
    };
  }
  return remote;
}

export function mergeThreadItems(
  remoteItems: ConversationItem[],
  localItems: ConversationItem[],
) {
  if (!localItems.length) {
    return remoteItems;
  }
  const byId = new Map(remoteItems.map((item) => [item.id, item]));
  const localItemsById = new Map(localItems.map((item) => [item.id, item]));
  const merged = remoteItems.map((item) => {
    const local = localItemsById.get(item.id);
    return local ? chooseRicherItem(item, local) : item;
  });
  localItems.forEach((item) => {
    const hasRemoteEcho =
      item.kind === "message" &&
      item.role === "user" &&
      item.id.startsWith("local-user-") &&
      remoteItems.some((remote) => isMatchingLocalUserEcho(remote, item));
    if (!byId.has(item.id) && !hasRemoteEcho) {
      merged.push(item);
    }
  });
  return merged;
}
