import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import Bot from "lucide-react/dist/esm/icons/bot";
import Brain from "lucide-react/dist/esm/icons/brain";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Copy from "lucide-react/dist/esm/icons/copy";
import Diff from "lucide-react/dist/esm/icons/diff";
import FileDiffIcon from "lucide-react/dist/esm/icons/file-diff";
import FileText from "lucide-react/dist/esm/icons/file-text";
import FileOutput from "lucide-react/dist/esm/icons/file-output";
import Image from "lucide-react/dist/esm/icons/image";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Quote from "lucide-react/dist/esm/icons/quote";
import Search from "lucide-react/dist/esm/icons/search";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import Users from "lucide-react/dist/esm/icons/users";
import Wrench from "lucide-react/dist/esm/icons/wrench";
import X from "lucide-react/dist/esm/icons/x";
import { exportMarkdownFile } from "@services/tauri";
import { pushErrorToast } from "@services/toasts";
import { useI18n } from "@/features/i18n/I18nProvider";
import { ModelActivityCore } from "@/features/models/components/ModelActivityCore";
import type { ModelActivityState } from "@/features/models/components/ModelActivityCore";
import type { ConversationItem, SendMessageResult } from "../../../types";
import { attachmentDisplayName } from "../../../utils/attachments";
import type { ParsedFileLocation } from "../../../utils/fileLinks";
import { PierreDiffBlock } from "../../git/components/PierreDiffBlock";
import {
  MAX_COMMAND_OUTPUT_LINES,
  basename,
  buildToolSummary,
  exploreKindLabel,
  formatCount,
  formatDurationMs,
  formatToolStatusLabel,
  normalizeMessageImageSrc,
  stripAnsiControlCodes,
  toolNameFromTitle,
  toolStatusTone,
  type MessageImage,
  type ParsedReasoning,
  type StatusTone,
  type ToolSummary,
} from "../utils/messageRenderUtils";
import { Markdown } from "./Markdown";
import { isStandaloneMarkdownTable } from "./Markdown";
import { MessageReferenceMenu } from "./MessageReferenceMenu";
import {
  defaultReferenceMode,
  estimateReferenceTokens,
  type MessageReferenceAction,
  type MessageReferenceMode,
} from "../utils/messageReferences";

type MarkdownFileLinkProps = {
  showMessageFilePath?: boolean;
  workspacePath?: string | null;
  onOpenFileLink?: (path: ParsedFileLocation) => void;
  onOpenFileLinkMenu?: (event: MouseEvent, path: ParsedFileLocation) => void;
  onOpenThreadLink?: (threadId: string) => void;
};

type WorkingIndicatorProps = {
  isThinking: boolean;
  activityState?: ModelActivityState;
  processingStartedAt?: number | null;
  lastDurationMs?: number | null;
  hasItems: boolean;
  reasoningLabel?: string | null;
  showPollingFetchStatus?: boolean;
  pollingIntervalMs?: number;
  completionStatus?: "completed" | "interrupted" | "failed" | null;
  runningLabel?: string;
  completedLabel?: string;
  interruptedLabel?: string;
  failedLabel?: string;
};

type MessageRowProps = MarkdownFileLinkProps & {
  item: Extract<ConversationItem, { kind: "message" }>;
  isCopied: boolean;
  onCopy: (item: Extract<ConversationItem, { kind: "message" }>) => void;
  onReference?: (action: MessageReferenceAction) => void;
  onResendUserMessage?: (
    item: Extract<ConversationItem, { kind: "message" }>,
    text: string,
  ) => Promise<SendMessageResult>;
  assistantActivityState?: ModelActivityState;
  assistantMeta?: AssistantMessageMeta | null;
  assistantProcessDisclosure?: AssistantProcessDisclosure;
  assistantProcessContent?: ReactNode;
  interrupted?: { label: string } | null;
  codeBlockCopyUseModifier?: boolean;
  exportSelectionMode?: boolean;
  exportSelected?: boolean;
  onExportStart?: (messageId: string) => void;
  onExportToggle?: (messageId: string) => void;
};

export type AssistantMessageMeta = {
  name: string;
  toolCount: number;
  processMessageCount: number;
  additions: number | null;
  deletions: number | null;
};

export type AssistantProcessDisclosure = {
  toolCount: number;
  processMessageCount: number;
  additions: number | null;
  deletions: number | null;
  isExpanded: boolean;
  bodyId: string;
  onToggle: () => void;
};

type ProcessMessageRowProps = MarkdownFileLinkProps & {
  item: Extract<ConversationItem, { kind: "message" }>;
};

type SubagentCheckpointRowProps = MarkdownFileLinkProps & {
  item: Extract<ConversationItem, { kind: "subagentCheckpoint" }>;
};

type ReasoningRowProps = MarkdownFileLinkProps & {
  item: Extract<ConversationItem, { kind: "reasoning" }>;
  parsed: ParsedReasoning;
  isExpanded: boolean;
  onToggle: (id: string) => void;
};

type ReviewRowProps = MarkdownFileLinkProps & {
  item: Extract<ConversationItem, { kind: "review" }>;
};

type DiffRowProps = {
  item: Extract<ConversationItem, { kind: "diff" }>;
};

function InlineExpandIcon({ expanded }: { expanded: boolean }) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <span className="tool-inline-bar-toggle-icon" aria-hidden>
      <Icon size={14} strokeWidth={1.8} />
    </span>
  );
}

type UserInputRowProps = {
  item: Extract<ConversationItem, { kind: "userInput" }>;
  isExpanded: boolean;
  onToggle: (id: string) => void;
};

type ToolRowProps = MarkdownFileLinkProps & {
  item: Extract<ConversationItem, { kind: "tool" }>;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  onRequestAutoScroll?: () => void;
};

type ExploreRowProps = {
  item: Extract<ConversationItem, { kind: "explore" }>;
};

type ProcessRowProps = {
  item: Extract<ConversationItem, { kind: "process" }>;
};

type CommandOutputProps = {
  output: string;
};

function extractTimestampFromMessageId(id: string) {
  const match = id.match(/\d{13}/);
  if (!match) {
    return null;
  }
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function formatMessageTimestamp(timestamp: number, includeDate = false) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return includeDate
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
    : time;
}

const MessageImageGrid = memo(function MessageImageGrid({
  images,
  onOpen,
  hasText,
}: {
  images: MessageImage[];
  onOpen: (index: number) => void;
  hasText: boolean;
}) {
  return (
    <div
      className={`message-image-grid${hasText ? " message-image-grid--with-text" : ""}`}
      role="list"
    >
      {images.map((image, index) => (
        <button
          key={`${image.src}-${index}`}
          type="button"
          className="message-image-thumb"
          onClick={() => onOpen(index)}
          aria-label={`Open image ${index + 1}`}
        >
          <img src={image.src} alt={image.label} loading="lazy" />
        </button>
      ))}
    </div>
  );
});

const ImageLightbox = memo(function ImageLightbox({
  images,
  activeIndex,
  onClose,
}: {
  images: MessageImage[];
  activeIndex: number;
  onClose: () => void;
}) {
  const activeImage = images[activeIndex];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!activeImage) {
    return null;
  }

  return createPortal(
    <div
      className="message-image-lightbox"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="message-image-lightbox-content"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="message-image-lightbox-close"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <X size={16} aria-hidden />
        </button>
        <img src={activeImage.src} alt={activeImage.label} />
      </div>
    </div>,
    document.body,
  );
});

const MessageAttachmentList = memo(function MessageAttachmentList({
  attachments,
}: {
  attachments: string[];
}) {
  const { t } = useI18n();
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="message-attachments" aria-label={t("messages.attachments")}>
      {attachments.map((attachment, index) => {
        const name = attachmentDisplayName(attachment);
        return (
          <span
            key={`${attachment}-${index}`}
            className="message-attachment"
            title={attachment}
          >
            <FileText size={14} aria-hidden />
            <span className="message-attachment-name">{name}</span>
          </span>
        );
      })}
    </div>
  );
});

const CommandOutput = memo(function CommandOutput({
  output,
}: CommandOutputProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const outputTail = useMemo(() => {
    let start = output.length;
    let remainingLines = MAX_COMMAND_OUTPUT_LINES;
    while (start > 0 && remainingLines > 0) {
      const newline = output.lastIndexOf("\n", start - 1);
      if (newline < 0) {
        start = 0;
        break;
      }
      start = newline;
      remainingLines -= 1;
    }
    const contentStart = start > 0 ? start + 1 : 0;
    return { contentStart, text: output.slice(contentStart) };
  }, [output]);
  const lines = useMemo(() => {
    if (!outputTail.text) {
      return [];
    }
    return stripAnsiControlCodes(outputTail.text).split(/\r?\n/);
  }, [outputTail]);

  const handleScroll = useCallback(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const threshold = 6;
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    setIsPinned(distanceFromBottom <= threshold);
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || !isPinned) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [lines, isPinned]);

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="tool-inline-terminal" role="log" aria-live="polite">
      <div
        className="tool-inline-terminal-lines"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {lines.map((line, index) => (
          <div
            key={`${outputTail.contentStart}-${index}-${line}`}
            className="tool-inline-terminal-line"
          >
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
});

function toolIconForSummary(
  item: Extract<ConversationItem, { kind: "tool" }>,
  summary: ToolSummary,
) {
  if (item.toolType === "commandExecution") {
    return Terminal;
  }
  if (item.toolType === "fileChange") {
    return FileDiffIcon;
  }
  if (item.toolType === "webSearch") {
    return Search;
  }
  if (item.toolType === "imageView") {
    return Image;
  }
  if (item.toolType === "collabToolCall") {
    return Users;
  }

  const label = summary.label.toLowerCase();
  if (label === "read") {
    return FileText;
  }
  if (label === "searched" || label === "searching") {
    return Search;
  }

  const toolName = toolNameFromTitle(item.title).toLowerCase();
  const title = item.title.toLowerCase();
  if (toolName.includes("diff") || title.includes("diff")) {
    return Diff;
  }

  return Wrench;
}

function buildPlanExportFileName(itemId: string) {
  const normalized = itemId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!normalized) {
    return "plan.md";
  }
  return normalized.startsWith("plan-")
    ? `${normalized}.md`
    : `plan-${normalized}.md`;
}

export const WorkingIndicator = memo(function WorkingIndicator({
  isThinking,
  activityState = "thinking",
  processingStartedAt = null,
  lastDurationMs = null,
  hasItems,
  reasoningLabel = null,
  showPollingFetchStatus = false,
  pollingIntervalMs = 12000,
  completionStatus = null,
  runningLabel = "RUNNING",
  completedLabel = "Done in",
  interruptedLabel = "Interrupted in",
  failedLabel = "Failed in",
}: WorkingIndicatorProps) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const localStartedAtRef = useRef<number | null>(null);
  const [pollCountdownSeconds, setPollCountdownSeconds] = useState(() =>
    Math.max(1, Math.ceil(pollingIntervalMs / 1000)),
  );

  useEffect(() => {
    if (!isThinking) {
      localStartedAtRef.current = null;
      setElapsedMs(0);
      return undefined;
    }
    if (localStartedAtRef.current === null) {
      localStartedAtRef.current = Date.now();
    }
    const startedAt = processingStartedAt ?? localStartedAtRef.current;
    setElapsedMs(Date.now() - startedAt);
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isThinking, processingStartedAt]);

  useEffect(() => {
    if (!showPollingFetchStatus || isThinking) {
      return undefined;
    }
    const intervalSeconds = Math.max(1, Math.ceil(pollingIntervalMs / 1000));
    setPollCountdownSeconds(intervalSeconds);
    const timer = window.setInterval(() => {
      setPollCountdownSeconds((previous) =>
        previous <= 1 ? intervalSeconds : previous - 1,
      );
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isThinking, pollingIntervalMs, showPollingFetchStatus]);

  return (
    <>
      {isThinking && (
        <div className="working">
          <span className="working-agent-avatar" aria-hidden>
            <ModelActivityCore state={activityState} size={22} />
          </span>
          <div className="working-main">
            <div className="working-meta">
              <span className="working-spinner" aria-hidden />
              <span className="working-status">{runningLabel}</span>
              <div className="working-timer">
                <span className="working-timer-clock">
                  {formatDurationMs(elapsedMs)}
                </span>
              </div>
            </div>
            {reasoningLabel ? (
              <span className="working-text">{reasoningLabel}</span>
            ) : null}
          </div>
        </div>
      )}
      {!isThinking && lastDurationMs !== null && hasItems && (
        <div className="turn-complete" aria-live="polite">
          <span className="turn-complete-line" aria-hidden />
          <span className="turn-complete-label">
            {showPollingFetchStatus
              ? `New message will be fetched in ${pollCountdownSeconds} seconds`
              : `${
                  completionStatus === "interrupted"
                    ? interruptedLabel
                    : completionStatus === "failed"
                      ? failedLabel
                      : completedLabel
                } ${formatDurationMs(lastDurationMs)}`}
          </span>
          <span className="turn-complete-line" aria-hidden />
        </div>
      )}
    </>
  );
});

export const MessageRow = memo(function MessageRow({
  item,
  isCopied,
  onCopy,
  onReference,
  onResendUserMessage,
  assistantActivityState = "idle",
  assistantMeta = null,
  assistantProcessDisclosure,
  assistantProcessContent,
  interrupted,
  codeBlockCopyUseModifier,
  showMessageFilePath,
  workspacePath,
  onOpenFileLink,
  onOpenFileLinkMenu,
  onOpenThreadLink,
  exportSelectionMode = false,
  exportSelected = false,
  onExportStart,
  onExportToggle,
}: MessageRowProps) {
  const { t } = useI18n();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [editText, setEditText] = useState(item.text);
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const [referenceMode, setReferenceMode] =
    useState<MessageReferenceMode>("full");
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resendInFlightRef = useRef(false);
  const selectionSnapshotRef = useRef<string | null>(null);
  const hasText = item.text.trim().length > 0;
  const attachments = item.attachments ?? [];
  const imageItems = useMemo(() => {
    if (!item.images || item.images.length === 0) {
      return [];
    }
    return item.images
      .map((image, index) => {
        const src = normalizeMessageImageSrc(image);
        if (!src) {
          return null;
        }
        return { src, label: `Image ${index + 1}` };
      })
      .filter(Boolean) as MessageImage[];
  }, [item.images]);
  const isTableOnlyAssistantMessage =
    item.role === "assistant" &&
    hasText &&
    imageItems.length === 0 &&
    attachments.length === 0 &&
    isStandaloneMarkdownTable(item.text);
  const isLongUserMessage =
    item.role === "user" &&
    (item.text.trim().length > 180 ||
      imageItems.length > 0 ||
      attachments.length > 0);
  const canEditUserMessage =
    item.role === "user" && Boolean(onResendUserMessage);
  const messageTimestamp = useMemo(() => {
    const timestamp = item.createdAt ?? extractTimestampFromMessageId(item.id);
    if (timestamp === null || timestamp === undefined) {
      return null;
    }
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
      return null;
    }
    return {
      clock: formatMessageTimestamp(timestamp),
      dateTime: formatMessageTimestamp(timestamp, true),
      iso: date.toISOString(),
    };
  }, [item.createdAt, item.id]);

  useEffect(() => {
    setIsEditing(false);
    setEditText(item.text);
  }, [item.id, item.text]);

  const getSelectedMessageText = useCallback(() => {
    const bubble = bubbleRef.current;
    const selection = window.getSelection();
    if (
      !bubble ||
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      return null;
    }
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!bubble.contains(range.commonAncestorContainer)) {
      return null;
    }

    const isWithinMessageControls = (node: Node | null) => {
      if (!node) {
        return false;
      }
      const element = node instanceof Element ? node : node.parentElement;
      return Boolean(
        element?.closest(
          ".message-quote-button, .message-copy-button, .message-edit-button, .message-export-button",
        ),
      );
    };

    if (
      isWithinMessageControls(selection.anchorNode) ||
      isWithinMessageControls(selection.focusNode)
    ) {
      return null;
    }
    return selectedText;
  }, []);

  const handleReferenceMenuToggle = useCallback(() => {
    if (!onReference) {
      return;
    }
    const selectedText =
      getSelectedMessageText() ?? selectionSnapshotRef.current;
    selectionSnapshotRef.current = selectedText;
    setReferenceMode(defaultReferenceMode(selectedText ?? item.text));
    setReferenceMenuOpen((open) => !open);
  }, [getSelectedMessageText, item.text, onReference]);

  const handleReferenceChoose = useCallback(
    (destination: MessageReferenceAction["destination"]) => {
      if (!onReference) {
        return;
      }
      onReference({
        messageId: item.id,
        sourceRole: item.role,
        sourceText: item.text,
        selectedText: selectionSnapshotRef.current,
        mode: referenceMode,
        destination,
      });
      selectionSnapshotRef.current = null;
      setReferenceMenuOpen(false);
    },
    [item.id, item.role, item.text, onReference, referenceMode],
  );

  const referenceText = selectionSnapshotRef.current ?? item.text;
  const referenceCharacterCount = Array.from(referenceText.trim()).length;
  const referenceEstimatedTokens = estimateReferenceTokens(referenceText);

  const startEdit = useCallback(() => {
    setEditText(item.text);
    setIsEditing(true);
    requestAnimationFrame(() => {
      const textarea = editTextareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [item.text]);

  const cancelEdit = useCallback(() => {
    setEditText(item.text);
    setIsEditing(false);
  }, [item.text]);

  const submitEdit = useCallback(async () => {
    const trimmed = editText.trim();
    if (!trimmed || !onResendUserMessage || resendInFlightRef.current) {
      return;
    }
    resendInFlightRef.current = true;
    setIsResending(true);
    try {
      const result = await onResendUserMessage(item, trimmed);
      if (result.status === "sent") {
        setIsEditing(false);
      }
    } catch {
      // The messaging owner reports failures; keep the draft available for retry.
    } finally {
      resendInFlightRef.current = false;
      setIsResending(false);
    }
  }, [editText, item, onResendUserMessage]);

  return (
    <div
      className={`message ${item.role}${isLongUserMessage ? " message-long" : ""}${
        exportSelected ? " is-export-selected" : ""
      }`}
    >
      <div
        ref={bubbleRef}
        className={`bubble message-bubble${
          isTableOnlyAssistantMessage ? " message-bubble-table-only" : ""
        }`}
      >
        {item.role === "assistant" ? (
          <div className="message-agent-meta">
            <span className="message-agent-avatar" aria-hidden>
              <ModelActivityCore
                state={assistantActivityState}
                size={18}
              />
            </span>
            <span className="message-agent-name" title={assistantMeta?.name}>
              {assistantMeta?.name ?? "Assistant"}
            </span>
            {messageTimestamp?.dateTime ? (
              <time
                className="message-agent-time"
                dateTime={messageTimestamp.iso}
              >
                {messageTimestamp.dateTime}
              </time>
            ) : null}
            {(() => {
              const toolCount =
                assistantProcessDisclosure?.toolCount ??
                assistantMeta?.toolCount ??
                0;
              const processMessageCount =
                assistantProcessDisclosure?.processMessageCount ??
                assistantMeta?.processMessageCount ??
                0;
              const additions =
                assistantProcessDisclosure?.additions ??
                assistantMeta?.additions ??
                null;
              const deletions =
                assistantProcessDisclosure?.deletions ??
                assistantMeta?.deletions ??
                null;
              if (
                toolCount === 0 &&
                processMessageCount === 0 &&
                (additions ?? 0) === 0 &&
                (deletions ?? 0) === 0
              ) {
                return null;
              }
              return (
                <span className="message-agent-stats">
                  {assistantProcessDisclosure ? (
                    <button
                      type="button"
                      className="message-agent-process-toggle"
                      data-button-elevation="none"
                      onClick={assistantProcessDisclosure.onToggle}
                      aria-expanded={assistantProcessDisclosure.isExpanded}
                      aria-controls={assistantProcessDisclosure.bodyId}
                      aria-label={
                        assistantProcessDisclosure.isExpanded
                          ? t("messages.collapseProcess")
                          : t("messages.expandProcess")
                      }
                      title={
                        assistantProcessDisclosure.isExpanded
                          ? t("messages.collapseProcess")
                          : t("messages.expandProcess")
                      }
                    >
                      <span
                        className="message-agent-process-chevron"
                        aria-hidden
                      >
                        {assistantProcessDisclosure.isExpanded ? (
                          <ChevronDown size={13} />
                        ) : (
                          <ChevronRight size={13} />
                        )}
                      </span>
                      {toolCount > 0 ? (
                        <span className="message-agent-stat">
                          {formatCount(
                            toolCount,
                            t("messages.toolCallSingular"),
                            t("messages.toolCallPlural"),
                          )}
                        </span>
                      ) : null}
                      {processMessageCount > 0 ? (
                        <span className="message-agent-stat">
                          {formatCount(
                            processMessageCount,
                            t("messages.processMessageSingular"),
                            t("messages.processMessagePlural"),
                          )}
                        </span>
                      ) : null}
                    </button>
                  ) : null}
                  {!assistantProcessDisclosure && toolCount > 0 ? (
                    <span className="message-agent-stat">
                      {formatCount(
                        toolCount,
                        t("messages.toolCallSingular"),
                        t("messages.toolCallPlural"),
                      )}
                    </span>
                  ) : null}
                  {!assistantProcessDisclosure && processMessageCount > 0 ? (
                    <span className="message-agent-stat">
                      {formatCount(
                        processMessageCount,
                        t("messages.processMessageSingular"),
                        t("messages.processMessagePlural"),
                      )}
                    </span>
                  ) : null}
                  {(additions ?? 0) > 0 ? (
                    <span className="message-agent-stat message-agent-stat-add">
                      +{additions}
                    </span>
                  ) : null}
                  {(deletions ?? 0) > 0 ? (
                    <span className="message-agent-stat message-agent-stat-delete">
                      -{deletions}
                    </span>
                  ) : null}
                </span>
              );
            })()}
          </div>
        ) : null}
        {assistantProcessContent}
        {item.role === "user" && messageTimestamp?.clock ? (
          <div className="message-user-meta">
            <span className="message-user-time">{messageTimestamp.clock}</span>
          </div>
        ) : null}
        {interrupted && (
          <span
            className="message-interrupted-status"
            title={interrupted.label}
          >
            <TriangleAlert size={13} aria-hidden />
            <span>{interrupted.label}</span>
          </span>
        )}
        {imageItems.length > 0 && (
          <MessageImageGrid
            images={imageItems}
            onOpen={setLightboxIndex}
            hasText={hasText}
          />
        )}
        <MessageAttachmentList attachments={attachments} />
        {isEditing ? (
          <div className="message-edit-form">
            <textarea
              ref={editTextareaRef}
              className="message-edit-textarea"
              value={editText}
              rows={Math.min(8, Math.max(2, editText.split(/\r?\n/).length))}
              disabled={isResending}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEdit();
                  return;
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submitEdit();
                }
              }}
              aria-label={t("messages.editMessage")}
            />
            <div className="message-edit-actions">
              <button
                type="button"
                className="ghost"
                onClick={cancelEdit}
                disabled={isResending}
              >
                {t("messages.cancel")}
              </button>
              <button
                type="button"
                className="primary message-edit-resend-button"
                onClick={() => void submitEdit()}
                disabled={!editText.trim() || isResending}
                aria-busy={isResending}
              >
                {isResending && (
                  <span
                    className="working-spinner message-edit-resend-spinner"
                    aria-hidden
                  />
                )}
                {t(isResending ? "messages.resending" : "messages.resend")}
              </button>
            </div>
          </div>
        ) : hasText ? (
          <Markdown
            value={item.text}
            className="markdown"
            codeBlockStyle="message"
            codeBlockCopyUseModifier={codeBlockCopyUseModifier}
            showFilePath={showMessageFilePath}
            workspacePath={workspacePath}
            onOpenFileLink={onOpenFileLink}
            onOpenFileLinkMenu={onOpenFileLinkMenu}
            onOpenThreadLink={onOpenThreadLink}
          />
        ) : null}
        {lightboxIndex !== null && imageItems.length > 0 && (
          <ImageLightbox
            images={imageItems}
            activeIndex={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
          />
        )}
        {exportSelectionMode && onExportToggle ? (
          <label
            className="message-export-checkbox"
            title={t("messages.export")}
          >
            <input
              type="checkbox"
              checked={exportSelected}
              onChange={() => onExportToggle(item.id)}
              aria-label={t("messages.export")}
            />
          </label>
        ) : null}
        {!exportSelectionMode && (
          <div className="message-actions">
            {onReference && hasText && (
              <div className="message-reference-control">
                <button
                  type="button"
                  className={`ghost message-quote-button${referenceMenuOpen ? " is-active" : ""}`}
                  data-button-elevation="none"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    selectionSnapshotRef.current = getSelectedMessageText();
                  }}
                  onClick={handleReferenceMenuToggle}
                  aria-label={t("messages.referenceAction")}
                  title={t("messages.referenceAction")}
                  aria-haspopup="menu"
                  aria-expanded={referenceMenuOpen}
                >
                  <Quote size={14} aria-hidden />
                </button>
                {referenceMenuOpen && (
                  <MessageReferenceMenu
                    mode={referenceMode}
                    characterCount={referenceCharacterCount}
                    estimatedTokens={referenceEstimatedTokens}
                    hasSelection={Boolean(selectionSnapshotRef.current)}
                    onModeChange={setReferenceMode}
                    onChoose={handleReferenceChoose}
                    onClose={() => setReferenceMenuOpen(false)}
                  />
                )}
              </div>
            )}
            {canEditUserMessage && hasText && !isEditing && (
              <button
                type="button"
                className="ghost message-edit-button"
                data-button-elevation="none"
                onClick={startEdit}
                aria-label={t("messages.editAndResend")}
                title={t("messages.editAndResend")}
              >
                <Pencil size={14} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className={`ghost message-copy-button${isCopied ? " is-copied" : ""}`}
              data-button-elevation="none"
              onClick={() => onCopy(item)}
              aria-label="Copy message"
              title="Copy message"
            >
              <span className="message-copy-icon" aria-hidden>
                <Copy className="message-copy-icon-copy" size={14} />
                <Check className="message-copy-icon-check" size={14} />
              </span>
            </button>
            {onExportStart ? (
              <button
                type="button"
                className="ghost message-export-button"
                data-button-elevation="none"
                onClick={() => onExportStart(item.id)}
                aria-label={t("messages.export")}
                title={t("messages.export")}
              >
                <FileOutput size={14} aria-hidden />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
});

export const ProcessMessageRow = memo(function ProcessMessageRow({
  item,
  showMessageFilePath,
  workspacePath,
  onOpenFileLink,
  onOpenFileLinkMenu,
  onOpenThreadLink,
}: ProcessMessageRowProps) {
  return (
    <div className="tool-inline process-message-inline">
      <div className="tool-inline-bar-toggle" aria-hidden />
      <div className="tool-inline-content">
        <div className="process-inline-summary">
          <Bot className="tool-inline-icon completed" size={14} aria-hidden />
          <Markdown
            value={item.text}
            className="tool-inline-detail markdown process-message-inline-text"
            showFilePath={showMessageFilePath}
            workspacePath={workspacePath}
            onOpenFileLink={onOpenFileLink}
            onOpenFileLinkMenu={onOpenFileLinkMenu}
            onOpenThreadLink={onOpenThreadLink}
          />
        </div>
      </div>
    </div>
  );
});

export const ReasoningRow = memo(function ReasoningRow({
  item,
  parsed,
  isExpanded,
  onToggle,
  showMessageFilePath,
  workspacePath,
  onOpenFileLink,
  onOpenFileLinkMenu,
  onOpenThreadLink,
}: ReasoningRowProps) {
  const { summaryTitle, bodyText, hasBody } = parsed;
  const reasoningTone: StatusTone = hasBody ? "completed" : "processing";
  return (
    <div
      className={`tool-inline reasoning-inline ${isExpanded ? "tool-inline-expanded" : ""}`}
    >
      <button
        type="button"
        className="tool-inline-bar-toggle"
        onClick={() => onToggle(item.id)}
        aria-expanded={isExpanded}
        aria-label="Toggle reasoning details"
      >
        <InlineExpandIcon expanded={isExpanded} />
      </button>
      <div className="tool-inline-content">
        <button
          type="button"
          className="tool-inline-summary tool-inline-toggle"
          onClick={() => onToggle(item.id)}
          aria-expanded={isExpanded}
        >
          <Brain
            className={`tool-inline-icon ${reasoningTone}`}
            size={14}
            aria-hidden
          />
          <span className="tool-inline-value">{summaryTitle}</span>
        </button>
        {hasBody && (
          <Markdown
            value={bodyText}
            className={`reasoning-inline-detail markdown ${
              isExpanded ? "" : "tool-inline-clamp"
            }`}
            showFilePath={showMessageFilePath}
            workspacePath={workspacePath}
            onOpenFileLink={onOpenFileLink}
            onOpenFileLinkMenu={onOpenFileLinkMenu}
            onOpenThreadLink={onOpenThreadLink}
          />
        )}
      </div>
    </div>
  );
});

export const ReviewRow = memo(function ReviewRow({
  item,
  showMessageFilePath,
  workspacePath,
  onOpenFileLink,
  onOpenFileLinkMenu,
  onOpenThreadLink,
}: ReviewRowProps) {
  const title =
    item.state === "started" ? "Review started" : "Review completed";
  return (
    <div className="item-card review">
      <div className="review-header">
        <span className="review-title">{title}</span>
        <span
          className={`review-badge ${item.state === "started" ? "active" : "done"}`}
        >
          Review
        </span>
      </div>
      {item.text && (
        <Markdown
          value={item.text}
          className="item-text markdown"
          showFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={onOpenFileLink}
          onOpenFileLinkMenu={onOpenFileLinkMenu}
          onOpenThreadLink={onOpenThreadLink}
        />
      )}
    </div>
  );
});

export const DiffRow = memo(function DiffRow({ item }: DiffRowProps) {
  return (
    <div className="item-card diff">
      <div className="diff-header">
        <span className="diff-title">{item.title}</span>
        {item.status && <span className="item-status">{item.status}</span>}
      </div>
      <div className="diff-viewer-output">
        <PierreDiffBlock diff={item.diff} displayPath={item.title} />
      </div>
    </div>
  );
});

export const UserInputRow = memo(function UserInputRow({
  item,
  isExpanded,
  onToggle,
}: UserInputRowProps) {
  const first = item.questions[0];
  const previewQuestion =
    first?.question?.trim() || first?.header?.trim() || "Input requested";
  const firstAnswer = first?.answers[0]?.trim() || "No answer provided";
  const previewAnswer =
    first && first.answers.length > 1
      ? `${firstAnswer} +${first.answers.length - 1}`
      : firstAnswer;
  const extraQuestions = Math.max(0, item.questions.length - 1);

  return (
    <div
      className={`tool-inline user-input-inline ${isExpanded ? "tool-inline-expanded" : ""}`}
    >
      <button
        type="button"
        className="tool-inline-bar-toggle"
        onClick={() => onToggle(item.id)}
        aria-expanded={isExpanded}
        aria-label="Toggle answered input details"
      >
        <InlineExpandIcon expanded={isExpanded} />
      </button>
      <div className="tool-inline-content">
        <button
          type="button"
          className="tool-inline-summary tool-inline-toggle"
          onClick={() => onToggle(item.id)}
          aria-expanded={isExpanded}
        >
          <Check className="tool-inline-icon completed" size={14} aria-hidden />
          <span className="tool-inline-label">answered:</span>
          <span className="tool-inline-value user-input-inline-preview">
            {previewQuestion}: {previewAnswer}
            {extraQuestions > 0 ? ` +${extraQuestions} more` : ""}
          </span>
        </button>
        {isExpanded && (
          <div className="user-input-inline-details">
            {item.questions.map((question, index) => {
              const title =
                question.question || question.header || `Question ${index + 1}`;
              return (
                <div
                  key={`${question.id}-${index}`}
                  className="user-input-inline-entry"
                >
                  <div className="user-input-inline-question">{title}</div>
                  {question.answers.length > 0 ? (
                    <div className="user-input-inline-answers">
                      {question.answers.map((answer, answerIndex) => (
                        <div
                          key={`${question.id}-answer-${answerIndex}`}
                          className="user-input-inline-answer"
                        >
                          {answer}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="user-input-inline-empty-answer">
                      No answer provided.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

function processSummary(item: Extract<ConversationItem, { kind: "process" }>) {
  if (item.processType === "skillTriggered") {
    return { icon: Brain, label: "Using skill" };
  }
  if (item.processType === "agentSpawned") {
    return { icon: Users, label: "Spawned agent" };
  }
  return { icon: Users, label: "Using agent" };
}

const SUBAGENT_CHECKPOINT_PREVIEW_LENGTH = 360;

type SubagentCheckpointContentProps = MarkdownFileLinkProps & {
  text: string;
};

function SubagentCheckpointContent({
  text,
  showMessageFilePath,
  workspacePath,
  onOpenFileLink,
  onOpenFileLinkMenu,
  onOpenThreadLink,
}: SubagentCheckpointContentProps) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const isLong = text.length > SUBAGENT_CHECKPOINT_PREVIEW_LENGTH;
  if (!isLong || isExpanded) {
    return (
      <Markdown
        value={text}
        className="tool-inline-detail markdown"
        showFilePath={showMessageFilePath}
        workspacePath={workspacePath}
        onOpenFileLink={onOpenFileLink}
        onOpenFileLinkMenu={onOpenFileLinkMenu}
        onOpenThreadLink={onOpenThreadLink}
      />
    );
  }

  const preview = text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUBAGENT_CHECKPOINT_PREVIEW_LENGTH);
  return (
    <div className="tool-inline-detail subagent-checkpoint-preview">
      <span>{preview}...</span>
      <button
        type="button"
        className="ghost icon-button"
        onClick={() => setIsExpanded(true)}
        aria-label={t("common.show")}
        title={t("common.show")}
      >
        <ChevronRight size={14} aria-hidden />
      </button>
    </div>
  );
}

export const ProcessRow = memo(function ProcessRow({ item }: ProcessRowProps) {
  const summary = processSummary(item);
  const Icon = summary.icon;
  return (
    <div className="tool-inline process-inline">
      <div className="tool-inline-bar-toggle" aria-hidden />
      <div className="tool-inline-content">
        <div className="process-inline-summary">
          <Icon className="tool-inline-icon completed" size={14} aria-hidden />
          <span className="tool-inline-label">{summary.label}:</span>
          <span className="tool-inline-value">{item.label}</span>
          {item.status && (
            <span className="tool-inline-status">{item.status}</span>
          )}
        </div>
        {item.detail && <div className="tool-inline-detail">{item.detail}</div>}
      </div>
    </div>
  );
});

export const SubagentCheckpointRow = memo(function SubagentCheckpointRow({
  item,
  showMessageFilePath,
  workspacePath,
  onOpenFileLink,
  onOpenFileLinkMenu,
  onOpenThreadLink,
}: SubagentCheckpointRowProps) {
  const { t } = useI18n();

  return (
    <>
      {item.checkpoints.map((checkpoint) => {
        const label =
          checkpoint.priority === "final"
            ? t("messages.subagentCheckpointFinal")
            : t("messages.subagentCheckpointProgress");
        const childLabel =
          checkpoint.childName || checkpoint.childThreadId.slice(0, 8);
        return (
          <div
            key={`${item.id}-${checkpoint.checkpointId}`}
            className="tool-inline process-inline subagent-checkpoint-inline"
            role="note"
            aria-label={`${label}: ${childLabel}`}
          >
            <div className="tool-inline-bar-toggle" aria-hidden />
            <div className="tool-inline-content">
              <div className="process-inline-summary">
                <Users
                  className="tool-inline-icon completed"
                  size={14}
                  aria-hidden
                />
                <span className="tool-inline-label">{label}:</span>
                <span
                  className="tool-inline-value"
                  title={checkpoint.childThreadId}
                >
                  {childLabel}
                </span>
                <span className="tool-inline-status">
                  #{checkpoint.sequence}
                </span>
              </div>
              <SubagentCheckpointContent
                text={checkpoint.text}
                showMessageFilePath={showMessageFilePath}
                workspacePath={workspacePath}
                onOpenFileLink={onOpenFileLink}
                onOpenFileLinkMenu={onOpenFileLinkMenu}
                onOpenThreadLink={onOpenThreadLink}
              />
            </div>
          </div>
        );
      })}
    </>
  );
});

export const ToolRow = memo(function ToolRow({
  item,
  isExpanded,
  onToggle,
  showMessageFilePath,
  workspacePath,
  onOpenFileLink,
  onOpenFileLinkMenu,
  onOpenThreadLink,
  onRequestAutoScroll,
}: ToolRowProps) {
  const isFileChange = item.toolType === "fileChange";
  const isCommand = item.toolType === "commandExecution";
  const isPlan = item.toolType === "plan";
  const commandText = isCommand
    ? item.title.replace(/^Command:\s*/i, "").trim()
    : "";
  const summary = buildToolSummary(item, commandText);
  const changeNames = (item.changes ?? [])
    .map((change) => basename(change.path))
    .filter(Boolean);
  const hasChanges = changeNames.length > 0;
  const tone = toolStatusTone(item, hasChanges);
  const ToolIcon = toolIconForSummary(item, summary);
  const summaryLabel = isFileChange
    ? changeNames.length > 1
      ? "files edited"
      : "file edited"
    : isCommand
      ? ""
      : summary.label;
  const inlineStatus = formatToolStatusLabel(item);
  const summaryValue = isFileChange
    ? changeNames.length > 1
      ? `${changeNames[0]} +${changeNames.length - 1}`
      : changeNames[0] || "changes"
    : summary.value;
  const shouldFadeCommand =
    isCommand && !isExpanded && (summaryValue?.length ?? 0) > 80;
  const showToolOutput = isExpanded && (!isFileChange || !hasChanges);
  const normalizedStatus = (item.status ?? "").toLowerCase();
  const isCommandRunning =
    isCommand && /in[_\s-]*progress|running|started/.test(normalizedStatus);
  const [showLiveOutput, setShowLiveOutput] = useState(false);
  const [isExportingPlan, setIsExportingPlan] = useState(false);

  useEffect(() => {
    if (!isCommandRunning) {
      setShowLiveOutput(false);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setShowLiveOutput(true);
    }, 600);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isCommandRunning]);

  const showCommandOutput =
    isCommand &&
    summary.output &&
    (isExpanded || (isCommandRunning && showLiveOutput));

  useEffect(() => {
    if (showCommandOutput && isCommandRunning && showLiveOutput) {
      onRequestAutoScroll?.();
    }
  }, [
    isCommandRunning,
    onRequestAutoScroll,
    showCommandOutput,
    showLiveOutput,
  ]);

  const handlePlanExport = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const output = (summary.output ?? "").trim();
      if (!output) {
        return;
      }
      setIsExportingPlan(true);
      try {
        await exportMarkdownFile(output, buildPlanExportFileName(item.id));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to export plan.";
        pushErrorToast({
          title: "Plan export failed",
          message,
        });
      } finally {
        setIsExportingPlan(false);
      }
    },
    [item.id, summary.output],
  );

  return (
    <div
      className={`tool-inline tool-inline-row ${isExpanded ? "tool-inline-expanded" : ""}`}
    >
      <button
        type="button"
        className="tool-inline-bar-toggle"
        onClick={() => onToggle(item.id)}
        aria-expanded={isExpanded}
        aria-label="Toggle tool details"
      >
        <InlineExpandIcon expanded={isExpanded} />
      </button>
      <div className="tool-inline-content">
        <button
          type="button"
          className="tool-inline-summary tool-inline-toggle"
          onClick={() => onToggle(item.id)}
          aria-expanded={isExpanded}
        >
          <ToolIcon
            className={`tool-inline-icon ${tone}`}
            size={14}
            aria-hidden
          />
          {summaryLabel && (
            <span className="tool-inline-label">{summaryLabel}:</span>
          )}
          {summaryValue && (
            <span
              className={`tool-inline-value ${isCommand ? "tool-inline-command" : ""} ${
                isCommand && isExpanded ? "tool-inline-command-full" : ""
              }`}
            >
              {isCommand ? (
                <span
                  className={`tool-inline-command-text ${
                    shouldFadeCommand ? "tool-inline-command-fade" : ""
                  }`}
                >
                  {summaryValue}
                </span>
              ) : (
                summaryValue
              )}
            </span>
          )}
          {inlineStatus && (
            <span className="tool-inline-status">{inlineStatus}</span>
          )}
        </button>
        {isExpanded && summary.detail && !isFileChange && (
          <div className="tool-inline-detail">{summary.detail}</div>
        )}
        {isExpanded && isCommand && item.detail && (
          <div className="tool-inline-detail tool-inline-muted">
            cwd: {item.detail}
          </div>
        )}
        {isExpanded && isFileChange && hasChanges && (
          <div className="tool-inline-change-list">
            {item.changes?.map((change, index) => (
              <div
                key={`${change.path}-${index}`}
                className="tool-inline-change"
              >
                <div className="tool-inline-change-header">
                  {change.kind && (
                    <span className="tool-inline-change-kind">
                      {change.kind.toUpperCase()}
                    </span>
                  )}
                  <span className="tool-inline-change-path">
                    {basename(change.path)}
                  </span>
                </div>
                {change.diff && (
                  <div className="diff-viewer-output">
                    <PierreDiffBlock
                      diff={change.diff}
                      displayPath={change.path}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {isExpanded && isFileChange && !hasChanges && item.detail && (
          <Markdown
            value={item.detail}
            className="item-text markdown"
            showFilePath={showMessageFilePath}
            workspacePath={workspacePath}
            onOpenFileLink={onOpenFileLink}
            onOpenFileLinkMenu={onOpenFileLinkMenu}
            onOpenThreadLink={onOpenThreadLink}
          />
        )}
        {showCommandOutput && <CommandOutput output={summary.output ?? ""} />}
        {showToolOutput && summary.output && !isCommand && (
          <Markdown
            value={stripAnsiControlCodes(summary.output)}
            className="tool-inline-output markdown"
            codeBlock={item.toolType !== "plan"}
            showFilePath={showMessageFilePath}
            workspacePath={workspacePath}
            onOpenFileLink={onOpenFileLink}
            onOpenFileLinkMenu={onOpenFileLinkMenu}
            onOpenThreadLink={onOpenThreadLink}
          />
        )}
        {showToolOutput && isPlan && (summary.output ?? "").trim() && (
          <div className="tool-inline-actions">
            <button
              type="button"
              className="ghost tool-inline-action"
              onClick={handlePlanExport}
              disabled={isExportingPlan}
            >
              {isExportingPlan ? "Exporting..." : "Export .md"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

export const ExploreRow = memo(function ExploreRow({ item }: ExploreRowProps) {
  const title = item.status === "exploring" ? "Exploring" : "Explored";
  return (
    <div className="tool-inline explore-inline">
      <div className="tool-inline-bar-toggle" aria-hidden />
      <div className="tool-inline-content">
        <div className="explore-inline-header">
          <Terminal
            className={`tool-inline-icon ${
              item.status === "exploring" ? "processing" : "completed"
            }`}
            size={14}
            aria-hidden
          />
          <span className="explore-inline-title">{title}</span>
        </div>
        <div className="explore-inline-list">
          {item.entries.map((entry, index) => (
            <div
              key={`${entry.kind}-${entry.label}-${index}`}
              className="explore-inline-item"
            >
              <span className="explore-inline-kind">
                {exploreKindLabel(entry.kind)}
              </span>
              <span className="explore-inline-label">{entry.label}</span>
              {entry.detail && entry.detail !== entry.label && (
                <span className="explore-inline-detail">{entry.detail}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
