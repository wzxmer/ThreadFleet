import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import type {
  AppMention,
  AppOption,
  ComposerTriggerMode,
  ComposerSendShortcut,
  ComposerSendIntent,
  ComposerEditorSettings,
  CustomPromptOption,
  DictationTranscript,
  ComposerReference,
  FollowUpMessageBehavior,
  QueuedMessage,
  ServiceTier,
  ThreadTokenUsage,
} from "../../../types";
import type {
  ReviewPromptState,
  ReviewPromptStep,
} from "../../threads/hooks/useReviewPrompt";
import {
  connectorMentionSlug,
  resolveBoundAppMentions,
  type AppMentionBinding,
} from "../../apps/utils/appMentions";
import {
  getFenceTriggerLine,
  getLineIndent,
  isCodeLikeSingleLine,
  isCursorInsideFence,
  normalizePastedText,
} from "../../../utils/composerText";
import { useComposerAutocompleteState } from "../hooks/useComposerAutocompleteState";
import { useComposerDraftEffects } from "../hooks/useComposerDraftEffects";
import { useComposerKeyDown } from "../hooks/useComposerKeyDown";
import { useComposerPasteUndo } from "../hooks/useComposerPasteUndo";
import { useComposerSuggestionStyle } from "../hooks/useComposerSuggestionStyle";
import { usePromptHistory } from "../hooks/usePromptHistory";
import { ComposerInput } from "./ComposerInput";
import { ComposerReferences } from "./ComposerReferences";
import { composeReferenceText } from "@/features/messages/utils/messageReferences";
import { ComposerMetaBar } from "./ComposerMetaBar";
import { ComposerQueue } from "./ComposerQueue";
import { useI18n } from "@/features/i18n/I18nProvider";
import { isMacPlatform } from "../../../utils/platformPaths";
import { isComposingEvent } from "../../../utils/keys";
import type { CodexArgsOption } from "../../threads/utils/codexArgsProfiles";
import type { WorkflowGateAdapterStatus } from "@/types";
import { getContextUsedPercent } from "@/features/threads/utils/contextUsage";
import {
  analyzeLargePaste,
  createPastedTextAttachment,
  normalizeLargePasteText,
} from "../utils/largePaste";
import {
  buildSkillInsertion,
  resolveSkillSuggestion,
} from "../utils/skillSuggestions";

type ComposerProps = {
  inputBackgroundColor?: string;
  onSend: (
    text: string,
    images: string[],
    appMentions?: AppMention[],
    submitIntent?: ComposerSendIntent,
    references?: ComposerReference[],
  ) => void;
  onStop: () => void;
  canStop: boolean;
  disabled?: boolean;
  appsEnabled: boolean;
  isProcessing: boolean;
  autoReconnectEnabled?: boolean;
  autoReconnectPhase?: "idle" | "waiting" | "sending" | "running";
  autoReconnectAttempt?: number;
  onAutoReconnectChange?: (enabled: boolean) => void;
  steerAvailable: boolean;
  followUpMessageBehavior: FollowUpMessageBehavior;
  composerSendShortcut: ComposerSendShortcut;
  onSelectComposerSendShortcut?: (shortcut: ComposerSendShortcut) => void;
  composerTriggerMode?: ComposerTriggerMode;
  onSelectComposerTriggerMode?: (mode: ComposerTriggerMode) => void;
  collaborationModes: { id: string; label: string }[];
  selectedCollaborationModeId: string | null;
  onSelectCollaborationMode: (id: string | null) => void;
  models: { id: string; displayName: string; model: string }[];
  selectedModelId: string | null;
  onSelectModel: (id: string) => void;
  onRefreshModels?: () => void;
  isRefreshingModels?: boolean;
  reasoningOptions: string[];
  selectedEffort: string | null;
  onSelectEffort: (effort: string) => void;
  selectedServiceTier: ServiceTier | null;
  reasoningSupported: boolean;
  codexArgsOptions?: CodexArgsOption[];
  selectedCodexArgsOverride?: string | null;
  onSelectCodexArgsOverride?: (value: string | null) => void;
  selectedWorkflowGateId?: string | null;
  onSelectWorkflowGateId?: (workflowId: string | null) => void;
  onVerifyWorkflowGate?: (workflowId: string) => Promise<WorkflowGateAdapterStatus>;
  accessMode: "read-only" | "current" | "full-access";
  onSelectAccessMode: (mode: "read-only" | "current" | "full-access") => void;
  skills: { name: string; description?: string }[];
  apps: AppOption[];
  prompts: CustomPromptOption[];
  files: string[];
  contextUsage?: ThreadTokenUsage | null;
  contextCompactionCount?: number;
  contextCompactionInProgress?: boolean;
  queuedMessages?: QueuedMessage[];
  queuePausedReason?: string | null;
  canSteerQueued?: boolean;
  onSteerQueued?: (id: string) => void;
  onEditQueued?: (item: QueuedMessage) => void;
  onDeleteQueued?: (id: string) => void;
  sendLabel?: string;
  draftText?: string;
  onDraftChange?: (text: string) => void;
  historyKey?: string | null;
  pasteUndoKey?: string | null;
  attachedImages?: string[];
  onPickImages?: () => void;
  onAttachImages?: (paths: string[]) => void;
  onRemoveImage?: (path: string) => void;
  onReplaceImages?: (paths: string[]) => void;
  prefillDraft?: QueuedMessage | null;
  onPrefillHandled?: (id: string) => void;
  insertText?: QueuedMessage | null;
  onInsertHandled?: (id: string) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  editorSettings?: ComposerEditorSettings;
  editorExpanded?: boolean;
  onToggleEditorExpanded?: () => void;
  dictationEnabled?: boolean;
  dictationState?: "idle" | "listening" | "processing";
  dictationLevel?: number;
  onToggleDictation?: () => void;
  onCancelDictation?: () => void;
  onOpenDictationSettings?: () => void;
  dictationTranscript?: DictationTranscript | null;
  onDictationTranscriptHandled?: (id: string) => void;
  dictationError?: string | null;
  onDismissDictationError?: () => void;
  dictationHint?: string | null;
  onDismissDictationHint?: () => void;
  reviewPrompt?: ReviewPromptState;
  onReviewPromptClose?: () => void;
  onReviewPromptShowPreset?: () => void;
  onReviewPromptChoosePreset?: (
    preset: Exclude<ReviewPromptStep, "preset"> | "uncommitted",
  ) => void;
  highlightedPresetIndex?: number;
  onReviewPromptHighlightPreset?: (index: number) => void;
  highlightedBranchIndex?: number;
  onReviewPromptHighlightBranch?: (index: number) => void;
  highlightedCommitIndex?: number;
  onReviewPromptHighlightCommit?: (index: number) => void;
  onReviewPromptKeyDown?: (event: {
    key: string;
    shiftKey?: boolean;
    preventDefault: () => void;
  }) => boolean;
  onReviewPromptSelectBranch?: (value: string) => void;
  onReviewPromptSelectBranchAtIndex?: (index: number) => void;
  onReviewPromptConfirmBranch?: () => Promise<void>;
  onReviewPromptSelectCommit?: (sha: string, title: string) => void;
  onReviewPromptSelectCommitAtIndex?: (index: number) => void;
  onReviewPromptConfirmCommit?: () => Promise<void>;
  onReviewPromptUpdateCustomInstructions?: (value: string) => void;
  onReviewPromptConfirmCustom?: () => Promise<void>;
  onFileAutocompleteActiveChange?: (active: boolean) => void;
  contextActions?: {
    id: string;
    label: string;
    title?: string;
    disabled?: boolean;
    onSelect: () => void | Promise<void>;
  }[];
  references?: ComposerReference[];
  onToggleReference?: (id: string) => void;
  onRemoveReference?: (id: string) => void;
  onMoveReference?: (from: number, to: number) => void;
  onUndoReference?: () => boolean;
  onRedoReference?: () => boolean;
};

const DEFAULT_EDITOR_SETTINGS: ComposerEditorSettings = {
  preset: "default",
  expandFenceOnSpace: false,
  expandFenceOnEnter: false,
  fenceLanguageTags: false,
  fenceWrapSelection: false,
  autoWrapPasteMultiline: false,
  autoWrapPasteCodeLike: false,
  largePasteBehavior: "smart",
  continueListOnShiftEnter: false,
};

export const Composer = memo(function Composer({
  inputBackgroundColor,
  onSend,
  onStop,
  canStop,
  disabled = false,
  appsEnabled,
  isProcessing,
  autoReconnectEnabled = false,
  autoReconnectPhase = "idle",
  autoReconnectAttempt = 0,
  onAutoReconnectChange,
  steerAvailable,
  followUpMessageBehavior,
  composerSendShortcut,
  onSelectComposerSendShortcut,
  composerTriggerMode = "default",
  onSelectComposerTriggerMode,
  collaborationModes,
  selectedCollaborationModeId,
  onSelectCollaborationMode,
  models,
  selectedModelId,
  onSelectModel,
  onRefreshModels,
  isRefreshingModels = false,
  reasoningOptions,
  selectedEffort,
  onSelectEffort,
  selectedServiceTier,
  reasoningSupported,
  codexArgsOptions = [],
  selectedCodexArgsOverride = null,
  onSelectCodexArgsOverride,
  selectedWorkflowGateId = null,
  onSelectWorkflowGateId,
  onVerifyWorkflowGate,
  accessMode,
  onSelectAccessMode,
  skills,
  apps,
  prompts,
  files,
  contextUsage = null,
  contextCompactionCount = 0,
  contextCompactionInProgress = false,
  queuedMessages = [],
  queuePausedReason = null,
  canSteerQueued = false,
  onSteerQueued,
  onEditQueued,
  onDeleteQueued,
  sendLabel = "",
  draftText = "",
  onDraftChange,
  historyKey = null,
  pasteUndoKey = null,
  attachedImages = [],
  onPickImages,
  onAttachImages,
  onRemoveImage,
  onReplaceImages,
  prefillDraft = null,
  onPrefillHandled,
  insertText = null,
  onInsertHandled,
  textareaRef: externalTextareaRef,
  editorSettings: editorSettingsProp,
  editorExpanded = false,
  onToggleEditorExpanded,
  dictationEnabled = false,
  dictationState = "idle",
  dictationLevel = 0,
  onToggleDictation,
  onCancelDictation,
  onOpenDictationSettings,
  dictationTranscript = null,
  onDictationTranscriptHandled,
  dictationError = null,
  onDismissDictationError,
  dictationHint = null,
  onDismissDictationHint,
  reviewPrompt,
  onReviewPromptClose,
  onReviewPromptShowPreset,
  onReviewPromptChoosePreset,
  highlightedPresetIndex,
  onReviewPromptHighlightPreset,
  highlightedBranchIndex,
  onReviewPromptHighlightBranch,
  highlightedCommitIndex,
  onReviewPromptHighlightCommit,
  onReviewPromptKeyDown,
  onReviewPromptSelectBranch,
  onReviewPromptSelectBranchAtIndex,
  onReviewPromptConfirmBranch,
  onReviewPromptSelectCommit,
  onReviewPromptSelectCommitAtIndex,
  onReviewPromptConfirmCommit,
  onReviewPromptUpdateCustomInstructions,
  onReviewPromptConfirmCustom,
  onFileAutocompleteActiveChange,
  contextActions = [],
  references = [],
  onToggleReference,
  onRemoveReference,
  onMoveReference,
  onUndoReference,
  onRedoReference,
}: ComposerProps) {
  const { t } = useI18n();
  const contextUsagePercent = contextCompactionInProgress
    ? 100
    : getContextUsedPercent(contextUsage);
  const [text, setText] = useState(draftText);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [appMentionBindings, setAppMentionBindings] = useState<AppMentionBinding[]>([]);
  const [headerComposerToolsHost, setHeaderComposerToolsHost] =
    useState<HTMLElement | null>(null);
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = externalTextareaRef ?? internalRef;
  const editorSettings = editorSettingsProp ?? DEFAULT_EDITOR_SETTINGS;
  const isDictationBusy = dictationState !== "idle";
  const canSend = text.trim().length > 0 || attachedImages.length > 0 || references.length > 0;
  const isMac = isMacPlatform();
  const effectiveFollowUpBehavior: FollowUpMessageBehavior =
    followUpMessageBehavior === "steer" && steerAvailable ? "steer" : "queue";
  const oppositeFollowUpIntent: ComposerSendIntent =
    effectiveFollowUpBehavior === "queue" ? "steer" : "queue";
  const defaultSubmitIntent: ComposerSendIntent = isProcessing
    ? effectiveFollowUpBehavior
    : "default";
  const oppositeSubmitIntent: ComposerSendIntent = isProcessing
    ? oppositeFollowUpIntent
    : "default";
  const effectiveSendLabel = isProcessing
    ? effectiveFollowUpBehavior === "steer"
      ? t("composer.steer")
      : t("composer.queue")
    : sendLabel || t("composer.send");
  const {
    expandFenceOnSpace,
    expandFenceOnEnter,
    fenceLanguageTags,
    fenceWrapSelection,
    autoWrapPasteMultiline,
    autoWrapPasteCodeLike,
    largePasteBehavior = "smart",
    continueListOnShiftEnter,
  } = editorSettings;

  const setComposerText = useCallback(
    (next: string) => {
      setText(next);
      onDraftChange?.(next);
    },
    [onDraftChange],
  );
  const syncDraftText = useCallback((next: string) => {
    setText((prev) => (prev === next ? prev : next));
  }, []);

  const bindingsFromMentions = useCallback(
    (mentions?: AppMention[]) =>
      (mentions ?? []).map((mention) => ({
        slug: connectorMentionSlug(mention.name),
        mention,
      })),
    [],
  );

  const {
    isAutocompleteOpen,
    autocompleteMatches,
    autocompleteAnchorIndex,
    highlightIndex,
    setHighlightIndex,
    applyAutocomplete,
    handleInputKeyDown,
    handleTextChange,
    handleSelectionChange,
    fileTriggerActive,
  } = useComposerAutocompleteState({
    text,
    selectionStart,
    disabled,
    appsEnabled,
    skills,
    apps,
    prompts,
    files,
    composerTriggerMode,
    textareaRef,
    setText: setComposerText,
    setSelectionStart,
    onItemApplied: (item, context) => {
      if (context.triggerChar !== "$" || item.group !== "Apps" || !item.mentionPath) {
        return;
      }
      const slug = context.insertedText.trim().toLowerCase();
      if (!slug) {
        return;
      }
      const nextBinding: AppMentionBinding = {
        slug,
        mention: {
          name: item.label,
          path: item.mentionPath,
        },
      };
      setAppMentionBindings((prev) => {
        const filtered = prev.filter(
          (binding) =>
            !(
              binding.slug === nextBinding.slug &&
              binding.mention.path === nextBinding.mention.path
            ),
        );
        return [...filtered, nextBinding];
      });
    },
  });

  useEffect(() => {
    const syncHeaderComposerToolsHost = () => {
      setHeaderComposerToolsHost(
        document.querySelector<HTMLElement>(".main-header-composer-tools"),
      );
    };
    syncHeaderComposerToolsHost();
    const frame = window.requestAnimationFrame(syncHeaderComposerToolsHost);
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    onFileAutocompleteActiveChange?.(fileTriggerActive);
  }, [fileTriggerActive, onFileAutocompleteActiveChange]);
  const reviewPromptOpen = Boolean(reviewPrompt);
  const suggestionsOpen = reviewPromptOpen || isAutocompleteOpen;
  const suggestions = reviewPromptOpen ? [] : autocompleteMatches;
  const suggestionsStyle = useComposerSuggestionStyle({
    isAutocompleteOpen,
    autocompleteAnchorIndex,
    selectionStart,
    text,
    textareaRef,
  });

  const {
    handleHistoryKeyDown,
    handleHistoryTextChange,
    recordHistory,
    resetHistoryNavigation,
  } = usePromptHistory({
    historyKey,
    text,
    hasAttachments: attachedImages.length > 0,
    disabled,
    isAutocompleteOpen: suggestionsOpen,
    textareaRef,
    setText: setComposerText,
    setSelectionStart,
  });

  const {
    beginPasteAttachments,
    clearPasteUndoHistory,
    handlePasteUndoKeyDown,
    markNativeHistoryChange,
    pasteAttachments,
  } = useComposerPasteUndo({
    text,
    attachments: attachedImages,
    draftKey: pasteUndoKey,
    textareaRef,
    onAttachImages,
    onReplaceImages,
    onSelectionChange: handleSelectionChange,
  });

  const handleTextChangeWithHistory = useCallback(
    (next: string, cursor: number | null) => {
      markNativeHistoryChange();
      handleHistoryTextChange(next);
      handleTextChange(next, cursor);
    },
    [handleHistoryTextChange, handleTextChange, markNativeHistoryChange],
  );

  const skillSuggestion = useMemo(
    () => resolveSkillSuggestion(text, skills),
    [skills, text],
  );

  const handleSend = useCallback((submitIntent: ComposerSendIntent = "default") => {
    if (disabled) {
      return;
    }
    const trimmed = text.trim();
    const submittedText = composeReferenceText(
      references.map((reference) => reference.prompt),
      trimmed,
    );
    if (!submittedText && attachedImages.length === 0) {
      return;
    }
    if (trimmed) {
      recordHistory(trimmed);
    }
    const resolvedMentions = resolveBoundAppMentions(trimmed, appMentionBindings);
    if (resolvedMentions.length > 0) {
      if (references.length > 0) {
        onSend(submittedText, attachedImages, resolvedMentions, submitIntent, references);
      } else {
        onSend(trimmed, attachedImages, resolvedMentions, submitIntent);
      }
    } else {
      if (references.length > 0) {
        onSend(submittedText, attachedImages, undefined, submitIntent, references);
      } else {
        onSend(trimmed, attachedImages, undefined, submitIntent);
      }
    }
    clearPasteUndoHistory();
    resetHistoryNavigation();
    setComposerText("");
    setAppMentionBindings([]);
  }, [
    appMentionBindings,
    attachedImages,
    clearPasteUndoHistory,
    disabled,
    onSend,
    recordHistory,
    references,
    resetHistoryNavigation,
    setComposerText,
    text,
  ]);

  useComposerDraftEffects({
    draftText,
    historyKey,
    prefillDraft,
    onPrefillHandled,
    insertText,
    onInsertHandled,
    dictationTranscript,
    onDictationTranscriptHandled,
    textareaRef,
    selectionStart,
    syncDraftText,
    text,
    setComposerText,
    setAppMentionBindings,
    bindingsFromMentions,
    resetHistoryNavigation,
    handleSelectionChange,
    onProgrammaticDraftChange: clearPasteUndoHistory,
  });

  const applyTextInsertion = useCallback(
    (nextText: string, nextCursor: number) => {
      clearPasteUndoHistory();
      setComposerText(nextText);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
        handleSelectionChange(nextCursor);
      });
    },
    [clearPasteUndoHistory, handleSelectionChange, setComposerText, textareaRef],
  );

  const handleSelectSuggestion = useCallback(
    (item: Parameters<typeof applyAutocomplete>[0]) => {
      clearPasteUndoHistory();
      applyAutocomplete(item);
    },
    [applyAutocomplete, clearPasteUndoHistory],
  );

  const handleAttachImages = useCallback(
    (paths: string[]) => {
      clearPasteUndoHistory();
      onAttachImages?.(paths);
    },
    [clearPasteUndoHistory, onAttachImages],
  );

  const handlePasteAttachments = useCallback(
    (paths: string[]) => {
      pasteAttachments(paths);
    },
    [pasteAttachments],
  );

  const handlePickImages = useCallback(() => {
    clearPasteUndoHistory();
    onPickImages?.();
  }, [clearPasteUndoHistory, onPickImages]);

  const handleRemoveImage = useCallback(
    (path: string) => {
      clearPasteUndoHistory();
      onRemoveImage?.(path);
    },
    [clearPasteUndoHistory, onRemoveImage],
  );

  const applyNativePasteInsertion = useCallback(
    (insertedText: string, start: number, end: number) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return false;
      }
      textarea.focus();
      textarea.setSelectionRange(start, end);
      const insertedNatively =
        typeof document.execCommand === "function" &&
        document.execCommand("insertText", false, insertedText);
      const nextCursor = start + insertedText.length;
      if (!insertedNatively) {
        const nextText = `${text.slice(0, start)}${insertedText}${text.slice(end)}`;
        applyTextInsertion(nextText, nextCursor);
        return false;
      }
      requestAnimationFrame(() => {
        const currentTextarea = textareaRef.current;
        if (!currentTextarea) {
          return;
        }
        currentTextarea.setSelectionRange(nextCursor, nextCursor);
        handleSelectionChange(nextCursor);
      });
      return true;
    },
    [applyTextInsertion, handleSelectionChange, text, textareaRef],
  );

  const handleInsertSkillSuggestion = useCallback(() => {
    if (!skillSuggestion || disabled) {
      return;
    }
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? selectionStart ?? text.length;
    const next = buildSkillInsertion(text, cursor, skillSuggestion.name);
    applyTextInsertion(next.text, next.cursor);
  }, [
    applyTextInsertion,
    disabled,
    selectionStart,
    skillSuggestion,
    text,
    textareaRef,
  ]);

  const handleTextPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) {
        return;
      }
      const pasted = event.clipboardData?.getData("text/plain") ?? "";
      if (!pasted) {
        return;
      }
      const normalized = normalizeLargePasteText(pasted);
      const largePaste = analyzeLargePaste(normalized);
      if (
        largePasteBehavior === "smart" &&
        largePaste.shouldAttach &&
        onAttachImages
      ) {
        event.preventDefault();
        handlePasteAttachments([createPastedTextAttachment(normalized)]);
        return;
      }
      if (!autoWrapPasteMultiline && !autoWrapPasteCodeLike) {
        return;
      }
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      const start = textarea.selectionStart ?? text.length;
      const end = textarea.selectionEnd ?? start;
      if (isCursorInsideFence(text, start)) {
        return;
      }
      const normalizedForFence = normalizePastedText(pasted);
      if (!normalizedForFence) {
        return;
      }
      const isMultiline = normalizedForFence.includes("\n");
      if (isMultiline && !autoWrapPasteMultiline) {
        return;
      }
      if (
        !isMultiline &&
        !(autoWrapPasteCodeLike && isCodeLikeSingleLine(normalizedForFence))
      ) {
        return;
      }
      event.preventDefault();
      const indent = getLineIndent(text, start);
      const content = indent
        ? normalizedForFence
            .split("\n")
            .map((line) => `${indent}${line}`)
            .join("\n")
        : normalizedForFence;
      const block = `${indent}\`\`\`\n${content}\n${indent}\`\`\``;
      applyNativePasteInsertion(block, start, end);
    },
    [
      applyNativePasteInsertion,
      autoWrapPasteCodeLike,
      autoWrapPasteMultiline,
      largePasteBehavior,
      handlePasteAttachments,
      onAttachImages,
      disabled,
      text,
      textareaRef,
    ],
  );

  const handleRestoreTextAttachment = useCallback(
    (path: string, restoredText: string) => {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? text.length;
      const end = textarea?.selectionEnd ?? start;
      const nextText = `${text.slice(0, start)}${restoredText}${text.slice(end)}`;
      clearPasteUndoHistory();
      applyTextInsertion(nextText, start + restoredText.length);
      onRemoveImage?.(path);
    },
    [
      applyTextInsertion,
      clearPasteUndoHistory,
      onRemoveImage,
      text,
      textareaRef,
    ],
  );
  const tryExpandFence = useCallback(
    (start: number, end: number) => {
      if (start !== end && !fenceWrapSelection) {
        return false;
      }
      const fence = getFenceTriggerLine(text, start, fenceLanguageTags);
      if (!fence) {
        return false;
      }
      const before = text.slice(0, fence.lineStart);
      const after = text.slice(fence.lineEnd);
      const openFence = `${fence.indent}\`\`\`${fence.tag}`;
      const closeFence = `${fence.indent}\`\`\``;
      if (fenceWrapSelection && start !== end) {
        const selection = normalizePastedText(text.slice(start, end));
        const content = fence.indent
          ? selection
              .split("\n")
              .map((line) => `${fence.indent}${line}`)
              .join("\n")
          : selection;
        const block = `${openFence}\n${content}\n${closeFence}`;
        const nextText = `${before}${block}${after}`;
        const nextCursor = before.length + block.length;
        applyTextInsertion(nextText, nextCursor);
        return true;
      }
      const block = `${openFence}\n${fence.indent}\n${closeFence}`;
      const nextText = `${before}${block}${after}`;
      const nextCursor =
        before.length + openFence.length + 1 + fence.indent.length;
      applyTextInsertion(nextText, nextCursor);
      return true;
    },
    [applyTextInsertion, fenceLanguageTags, fenceWrapSelection, text],
  );
  const baseHandleKeyDown = useComposerKeyDown({
    applyTextInsertion,
    canSend,
    composerSendShortcut,
    continueListOnShiftEnter,
    defaultSubmitIntent,
    expandFenceOnEnter,
    expandFenceOnSpace,
    handleHistoryKeyDown,
    handleInputKeyDown,
    handleSend,
    isDictationBusy,
    isMac,
    onReviewPromptKeyDown,
    oppositeSubmitIntent,
    reviewPromptOpen,
    steerAvailable,
    suggestionsOpen,
    text,
    textareaRef,
    tryExpandFence,
  });
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposingEvent(event)) {
        return;
      }
      if (handlePasteUndoKeyDown(event)) {
        return;
      }
      const isReferenceHistory =
        event.key.toLowerCase() === "z" &&
        !event.altKey &&
        (event.ctrlKey || event.metaKey);
      if (isReferenceHistory) {
        const handled = event.shiftKey ? onRedoReference?.() : onUndoReference?.();
        if (handled) {
          event.preventDefault();
          return;
        }
      }
      baseHandleKeyDown(event);
    },
    [baseHandleKeyDown, handlePasteUndoKeyDown, onRedoReference, onUndoReference],
  );


  return (
    <footer
      className={`composer${disabled ? " is-disabled" : ""}`}
      style={
        inputBackgroundColor
          ? ({ "--composer-input-background": inputBackgroundColor } as CSSProperties)
          : undefined
      }
    >
      <ComposerQueue
        queuedMessages={queuedMessages}
        pausedReason={queuePausedReason}
        canSteerQueued={canSteerQueued}
        onSteerQueued={onSteerQueued}
        onEditQueued={onEditQueued}
        onDeleteQueued={onDeleteQueued}
      />
      {contextActions.length > 0 ? (
        <div className="composer-context-actions" role="toolbar" aria-label="Review tools">
          {contextActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="ghost composer-context-action"
              title={action.title}
              disabled={disabled || Boolean(action.disabled)}
              onClick={() => {
                void action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {skillSuggestion ? (
        <div className="composer-skill-suggestion">
          <span>
            {t("composer.skillSuggestion").replace(
              "{skill}",
              `$${skillSuggestion.name}`,
            )}
          </span>
          <button
            type="button"
            className="ghost composer-skill-suggestion-button"
            disabled={disabled}
            onClick={handleInsertSkillSuggestion}
          >
            {t("composer.insert")}
          </button>
        </div>
      ) : null}
      <ComposerReferences references={references} onToggle={onToggleReference ?? (() => undefined)} onRemove={onRemoveReference ?? (() => undefined)} onMove={onMoveReference ?? (() => undefined)} />
      <div className="composer-surface">
      <ComposerInput
        text={text}
        disabled={disabled}
        sendLabel={effectiveSendLabel}
        canStop={canStop}
        canSend={canSend}
        isProcessing={isProcessing}
        onStop={onStop}
        onSend={() => handleSend(defaultSubmitIntent)}
        dictationEnabled={dictationEnabled}
        dictationState={dictationState}
        dictationLevel={dictationLevel}
        onToggleDictation={onToggleDictation}
        onCancelDictation={onCancelDictation}
        onOpenDictationSettings={onOpenDictationSettings}
        dictationError={dictationError}
        onDismissDictationError={onDismissDictationError}
        dictationHint={dictationHint}
        onDismissDictationHint={onDismissDictationHint}
        attachments={attachedImages}
        onAddAttachment={handlePickImages}
        onAttachImages={handleAttachImages}
        onPasteAttachments={handlePasteAttachments}
        onBeginPasteAttachments={beginPasteAttachments}
        onRemoveAttachment={handleRemoveImage}
        onRestoreTextAttachment={handleRestoreTextAttachment}
        onTextChange={handleTextChangeWithHistory}
        onSelectionChange={handleSelectionChange}
        onTextPaste={handleTextPaste}
        isExpanded={editorExpanded}
        onToggleExpand={onToggleEditorExpanded}
        onKeyDown={handleKeyDown}
        textareaRef={textareaRef}
        suggestionsOpen={suggestionsOpen}
        suggestions={suggestions}
        highlightIndex={highlightIndex}
        onHighlightIndex={setHighlightIndex}
        onSelectSuggestion={handleSelectSuggestion}
        suggestionsStyle={suggestionsStyle}
        reviewPrompt={reviewPrompt}
        onReviewPromptClose={onReviewPromptClose}
        onReviewPromptShowPreset={onReviewPromptShowPreset}
        onReviewPromptChoosePreset={onReviewPromptChoosePreset}
        highlightedPresetIndex={highlightedPresetIndex}
        onReviewPromptHighlightPreset={onReviewPromptHighlightPreset}
        highlightedBranchIndex={highlightedBranchIndex}
        onReviewPromptHighlightBranch={onReviewPromptHighlightBranch}
        highlightedCommitIndex={highlightedCommitIndex}
        onReviewPromptHighlightCommit={onReviewPromptHighlightCommit}
        onReviewPromptSelectBranch={onReviewPromptSelectBranch}
        onReviewPromptSelectBranchAtIndex={onReviewPromptSelectBranchAtIndex}
        onReviewPromptConfirmBranch={onReviewPromptConfirmBranch}
        onReviewPromptSelectCommit={onReviewPromptSelectCommit}
        onReviewPromptSelectCommitAtIndex={onReviewPromptSelectCommitAtIndex}
        onReviewPromptConfirmCommit={onReviewPromptConfirmCommit}
        onReviewPromptUpdateCustomInstructions={onReviewPromptUpdateCustomInstructions}
        onReviewPromptConfirmCustom={onReviewPromptConfirmCustom}
        contextUsagePercent={contextUsagePercent}
        contextCompactionCount={contextCompactionCount}
        contextCompactionInProgress={contextCompactionInProgress}
      />
      <ComposerMetaBar
        disabled={disabled}
        collaborationModes={collaborationModes}
        selectedCollaborationModeId={selectedCollaborationModeId}
        onSelectCollaborationMode={onSelectCollaborationMode}
        models={models}
        selectedModelId={selectedModelId}
        onSelectModel={onSelectModel}
        onRefreshModels={onRefreshModels}
        isRefreshingModels={isRefreshingModels}
        reasoningOptions={reasoningOptions}
        selectedEffort={selectedEffort}
        onSelectEffort={onSelectEffort}
        selectedServiceTier={selectedServiceTier}
        reasoningSupported={reasoningSupported}
        codexArgsOptions={codexArgsOptions}
        selectedCodexArgsOverride={selectedCodexArgsOverride}
        onSelectCodexArgsOverride={onSelectCodexArgsOverride}
        selectedWorkflowGateId={selectedWorkflowGateId}
        onSelectWorkflowGateId={onSelectWorkflowGateId}
        onVerifyWorkflowGate={onVerifyWorkflowGate}
        accessMode={accessMode}
        onSelectAccessMode={onSelectAccessMode}
        composerSendShortcut={composerSendShortcut}
        onSelectComposerSendShortcut={onSelectComposerSendShortcut}
        composerTriggerMode={composerTriggerMode}
        onSelectComposerTriggerMode={onSelectComposerTriggerMode}
        autoReconnectEnabled={autoReconnectEnabled}
        autoReconnectPhase={autoReconnectPhase}
        autoReconnectAttempt={autoReconnectAttempt}
        onAutoReconnectChange={onAutoReconnectChange}
        inputToolsHost={headerComposerToolsHost}
      />
      </div>
    </footer>
  );
});

Composer.displayName = "Composer";
