import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  CompositionEvent,
  CSSProperties,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SyntheticEvent,
} from "react";
import type { AutocompleteItem } from "../hooks/useComposerAutocomplete";
import Paperclip from "lucide-react/dist/esm/icons/paperclip";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import Mic from "lucide-react/dist/esm/icons/mic";
import Square from "lucide-react/dist/esm/icons/square";
import X from "lucide-react/dist/esm/icons/x";
import { useComposerImageDrop } from "../hooks/useComposerImageDrop";
import { ComposerMobileActionsMenu } from "./ComposerMobileActionsMenu";
import { ComposerSuggestionsPopover } from "./ComposerSuggestionsPopover";
import { ComposerAttachments } from "./ComposerAttachments";
import { DictationWaveform } from "../../dictation/components/DictationWaveform";
import { useI18n } from "@/features/i18n/I18nProvider";
import { useComposerDictationControls } from "../hooks/useComposerDictationControls";
import { useComposerInputLayout } from "../hooks/useComposerInputLayout";
import { useComposerMobileActions } from "../hooks/useComposerMobileActions";
import type { ReviewPromptState, ReviewPromptStep } from "../../threads/hooks/useReviewPrompt";

type ComposerInputProps = {
  text: string;
  disabled: boolean;
  sendLabel: string;
  canStop: boolean;
  canSend: boolean;
  isProcessing: boolean;
  onStop: () => void;
  onSend: () => void;
  dictationState?: "idle" | "listening" | "processing";
  dictationLevel?: number;
  dictationEnabled?: boolean;
  onToggleDictation?: () => void;
  onCancelDictation?: () => void;
  onOpenDictationSettings?: () => void;
  dictationError?: string | null;
  onDismissDictationError?: () => void;
  dictationHint?: string | null;
  onDismissDictationHint?: () => void;
  attachments?: string[];
  onAddAttachment?: () => void;
  onAttachImages?: (paths: string[]) => void;
  onPasteAttachments?: (paths: string[]) => void;
  onBeginPasteAttachments?: () => ((paths: string[]) => void) | null;
  onRemoveAttachment?: (path: string) => void;
  onRestoreTextAttachment?: (path: string, text: string) => void;
  onTextChange: (next: string, selectionStart: number | null) => void;
  onTextPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSelectionChange: (selectionStart: number | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  suggestionsOpen: boolean;
  suggestions: AutocompleteItem[];
  highlightIndex: number;
  onHighlightIndex: (index: number) => void;
  onSelectSuggestion: (item: AutocompleteItem) => void;
  suggestionsStyle?: React.CSSProperties;
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
  onReviewPromptSelectBranch?: (value: string) => void;
  onReviewPromptSelectBranchAtIndex?: (index: number) => void;
  onReviewPromptConfirmBranch?: () => Promise<void>;
  onReviewPromptSelectCommit?: (sha: string, title: string) => void;
  onReviewPromptSelectCommitAtIndex?: (index: number) => void;
  onReviewPromptConfirmCommit?: () => Promise<void>;
  onReviewPromptUpdateCustomInstructions?: (value: string) => void;
  onReviewPromptConfirmCustom?: () => Promise<void>;
  contextUsagePercent?: number | null;
  contextCompactionCount?: number;
  contextCompactionInProgress?: boolean;
};

export function ComposerInput({
  text,
  disabled,
  sendLabel,
  canStop,
  canSend,
  isProcessing,
  onStop,
  onSend,
  dictationState = "idle",
  dictationLevel = 0,
  dictationEnabled = false,
  onToggleDictation,
  onCancelDictation,
  onOpenDictationSettings,
  dictationError = null,
  onDismissDictationError,
  dictationHint = null,
  onDismissDictationHint,
  attachments = [],
  onAddAttachment,
  onAttachImages,
  onPasteAttachments,
  onBeginPasteAttachments,
  onRemoveAttachment,
  onRestoreTextAttachment,
  onTextChange,
  onTextPaste,
  onSelectionChange,
  onKeyDown,
  isExpanded = false,
  onToggleExpand,
  textareaRef,
  suggestionsOpen,
  suggestions,
  highlightIndex,
  onHighlightIndex,
  onSelectSuggestion,
  suggestionsStyle,
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
  onReviewPromptSelectBranch,
  onReviewPromptSelectBranchAtIndex,
  onReviewPromptConfirmBranch,
  onReviewPromptSelectCommit,
  onReviewPromptSelectCommitAtIndex,
  onReviewPromptConfirmCommit,
  onReviewPromptUpdateCustomInstructions,
  onReviewPromptConfirmCustom,
  contextUsagePercent = null,
  contextCompactionCount = 0,
  contextCompactionInProgress = false,
}: ComposerInputProps) {
  const { t } = useI18n();
  const suggestionListRef = useRef<HTMLDivElement | null>(null);
  const suggestionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const isComposingRef = useRef(false);
  const committedCompositionRef = useRef<string | null>(null);
  const [compositionText, setCompositionText] = useState<string | null>(null);
  const [manualTextareaHeight, setManualTextareaHeight] = useState<number | null>(null);
  const resizeDragRef = useRef<{
    startY: number;
    startHeight: number;
    minHeight: number;
    maxHeight: number;
  } | null>(null);
  const displayedText = compositionText ?? text;
  const {
    isPhoneLayout,
    isPhoneTallInput,
    textareaScrollable,
    textareaHeightBounds,
  } = useComposerInputLayout({
    isExpanded,
    text: displayedText,
    textareaRef,
    manualHeight: manualTextareaHeight,
  });
  const { mobileActionsOpen, mobileActionsRef, setMobileActionsOpen } =
    useComposerMobileActions({ disabled });
  const {
    dropTargetRef,
    isDragOver,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handlePaste,
  } = useComposerImageDrop({
    disabled,
    onAttachImages,
    onPasteImages: onPasteAttachments,
    onPasteStart: onBeginPasteAttachments,
  });
  const setInputAreaRef = useCallback(
    (node: HTMLDivElement | null) => {
      dropTargetRef.current = node;
    },
    [dropTargetRef],
  );
  const handleActionClick = useCallback(() => {
    if (canStop) {
      onStop();
      return;
    }
    onSend();
  }, [canStop, onSend, onStop]);
  const {
    handleMicClick,
    isDictating,
    isDictationBusy,
    isDictationProcessing,
    micAriaLabel,
    micDisabled,
    micTitle,
  } = useComposerDictationControls({
    disabled,
    dictationEnabled,
    dictationState,
    onToggleDictation,
    onCancelDictation,
    onOpenDictationSettings,
  });
  const boundedContextCyclePercent =
    contextUsagePercent === null
      ? null
      : Math.min(100, Math.max(0, Math.round(contextUsagePercent)));
  const contextStatus = useMemo(() => {
    if (boundedContextCyclePercent === null) {
      return {
        className: "is-context-unknown",
        color: "var(--cm-border-heavy)",
        label: t("composer.contextUsageEmpty"),
      };
    }
    const className =
      boundedContextCyclePercent >= 95
        ? "is-context-danger"
        : boundedContextCyclePercent >= 80
          ? "is-context-warning"
          : "is-context-ok";
    const color =
      boundedContextCyclePercent >= 95
        ? "var(--status-error)"
        : boundedContextCyclePercent >= 80
          ? "var(--status-warning)"
          : "var(--status-success)";
    return {
      className,
      color,
      label: contextCompactionInProgress
        ? t("composer.contextCompacting")
        : `${t("composer.contextUsagePrefix")} ${boundedContextCyclePercent}%`,
    };
  }, [boundedContextCyclePercent, contextCompactionInProgress, t]);
  const contextCompactionLabel = t("composer.contextCompactionsPrefix").replace(
    "{count}",
    String(contextCompactionCount),
  );
  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    event.preventDefault();
    resizeDragRef.current = {
      startY: event.clientY,
      startHeight: textarea.getBoundingClientRect().height,
      minHeight: textareaHeightBounds.min,
      maxHeight: textareaHeightBounds.max,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) {
        return;
      }
      const delta = drag.startY - moveEvent.clientY;
      const nextHeight = Math.min(
        Math.max(drag.startHeight + delta, drag.minHeight),
        drag.maxHeight,
      );
      setManualTextareaHeight(nextHeight);
    };

    const handlePointerUp = () => {
      resizeDragRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
  }, [textareaHeightBounds.max, textareaHeightBounds.min, textareaRef]);

  const handleTextareaChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      if (isComposingRef.current) {
        setCompositionText(next);
        return;
      }
      const committedComposition = committedCompositionRef.current;
      committedCompositionRef.current = null;
      if (committedComposition === next) {
        return;
      }
      onTextChange(next, event.target.selectionStart);
    },
    [onTextChange],
  );

  const handleTextareaSelect = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      if (isComposingRef.current) {
        return;
      }
      onSelectionChange((event.target as HTMLTextAreaElement).selectionStart);
    },
    [onSelectionChange],
  );

  const handleCompositionStart = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      isComposingRef.current = true;
      committedCompositionRef.current = null;
      setCompositionText(event.currentTarget.value);
    },
    [],
  );

  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      const next = event.currentTarget.value;
      const cursor = event.currentTarget.selectionStart;
      isComposingRef.current = false;
      committedCompositionRef.current = next;
      setCompositionText(null);
      onTextChange(next, cursor);
    },
    [onTextChange],
  );

  const handleTextareaPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      void handlePaste(event);
      if (!event.defaultPrevented) {
        onTextPaste?.(event);
      }
    },
    [handlePaste, onTextPaste],
  );

  const handleMobileAttachClick = useCallback(() => {
    if (disabled || !onAddAttachment) {
      return;
    }
    setMobileActionsOpen(false);
    onAddAttachment();
  }, [disabled, onAddAttachment, setMobileActionsOpen]);

  const handleMobileExpandClick = useCallback(() => {
    if (disabled || !onToggleExpand) {
      return;
    }
    setMobileActionsOpen(false);
    onToggleExpand();
  }, [disabled, onToggleExpand, setMobileActionsOpen]);

  const handleMobileDictationClick = useCallback(() => {
    setMobileActionsOpen(false);
    handleMicClick();
  }, [handleMicClick, setMobileActionsOpen]);

  return (
    <div className={`composer-input${isPhoneLayout && isPhoneTallInput ? " is-phone-tall" : ""}`}>
      <div
        className={`composer-input-area ${contextStatus.className}${
          contextCompactionInProgress ? " is-context-compacting" : ""
        }${isDragOver ? " is-drag-over" : ""}`}
        style={
          {
            "--composer-context-used": boundedContextCyclePercent ?? 0,
            "--composer-context-width": `${boundedContextCyclePercent ?? 0}%`,
            "--composer-context-color": contextStatus.color,
          } as CSSProperties
        }
        ref={setInputAreaRef}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <button
          type="button"
          className="composer-input-resize-handle"
          data-button-elevation="none"
          aria-label={t("composer.resizeInput")}
          title={t("composer.resizeInput")}
          onPointerDown={handleResizePointerDown}
          onDoubleClick={() => setManualTextareaHeight(null)}
        />
        <div className="composer-context-cycle-track" aria-hidden>
          <span
            className={contextCompactionInProgress ? "is-compacting" : undefined}
          />
        </div>
        <ComposerAttachments
          attachments={attachments}
          disabled={disabled}
          onRemoveAttachment={onRemoveAttachment}
          onRestoreTextAttachment={onRestoreTextAttachment}
        />
        <div className="composer-input-row">
          <button
            type="button"
            className="composer-attach"
            onClick={onAddAttachment}
            disabled={disabled || !onAddAttachment}
            aria-label={t("composer.addAttachment")}
            title={t("composer.addAttachment")}
          >
            <Paperclip size={14} aria-hidden />
          </button>
          <ComposerMobileActionsMenu
            disabled={disabled}
            handleMobileAttachClick={handleMobileAttachClick}
            handleMobileDictationClick={handleMobileDictationClick}
            handleMobileExpandClick={handleMobileExpandClick}
            isDictating={isDictating}
            isDictationProcessing={isDictationProcessing}
            isExpanded={isExpanded}
            micAriaLabel={micAriaLabel}
            micDisabled={micDisabled}
            mobileActionsOpen={mobileActionsOpen}
            mobileActionsRef={mobileActionsRef}
            onAddAttachment={onAddAttachment}
            onToggleExpand={onToggleExpand}
            setMobileActionsOpen={setMobileActionsOpen}
            showDictationAction={Boolean(
              onToggleDictation || onOpenDictationSettings || onCancelDictation,
            )}
          />
          <textarea
            ref={textareaRef}
            placeholder={
              disabled
                ? t("composer.reviewPlaceholder")
                : t("composer.placeholder")
            }
            className={textareaScrollable ? "is-scrollable" : undefined}
            value={displayedText}
            onChange={handleTextareaChange}
            onSelect={handleTextareaSelect}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            disabled={disabled}
            onKeyDown={onKeyDown}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onPaste={handleTextareaPaste}
          />
          <div className="composer-input-actions">
            <div
              className={`composer-context-count ds-tooltip-trigger${
                contextCompactionInProgress ? " is-compacting" : ""
              }`}
              data-tooltip={`${contextStatus.label} · ${contextCompactionLabel}`}
              data-tooltip-placement="bottom"
              data-tooltip-align="center"
              aria-label={`${contextStatus.label}; ${contextCompactionLabel}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                contextCompactionInProgress
                  ? undefined
                  : boundedContextCyclePercent ?? undefined
              }
            >
              <svg
                className="composer-context-progress"
                viewBox="0 0 32 32"
                aria-hidden
                focusable="false"
              >
                <circle className="composer-context-progress-track" cx="16" cy="16" r="13" />
                <circle
                  className="composer-context-progress-value"
                  cx="16"
                  cy="16"
                  r="13"
                  pathLength={boundedContextCyclePercent === null ? undefined : 100}
                />
              </svg>
              <span className="composer-context-count-value">{contextCompactionCount}</span>
            </div>
            {onToggleExpand && (
              <button
                className={`composer-action composer-action--expand${
                  isExpanded ? " is-active" : ""
                }`}
                onClick={onToggleExpand}
                disabled={disabled}
                aria-label={
                  isExpanded ? t("composer.collapseInput") : t("composer.expandInput")
                }
                title={
                  isExpanded ? t("composer.collapseInput") : t("composer.expandInput")
                }
              >
                {isExpanded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
              </button>
            )}
            <button
              className={`composer-action composer-action--mic${
                isDictationBusy ? " is-active" : ""
              }${isDictationProcessing ? " is-processing is-stop" : ""}${
                micDisabled ? " is-disabled" : ""
              }`}
              onClick={handleMicClick}
              disabled={micDisabled}
              aria-label={micAriaLabel}
              title={micTitle}
            >
              {isDictationProcessing ? (
                <X aria-hidden />
              ) : isDictating ? (
                <Square aria-hidden />
              ) : (
                <Mic aria-hidden />
              )}
            </button>
            <button
              className={`composer-action${canStop ? " is-stop" : " is-send"}${
                canStop && isProcessing ? " is-loading" : ""
              }`}
              onClick={handleActionClick}
              disabled={(disabled && !canStop) || isDictationBusy || (!canStop && !canSend)}
              aria-label={canStop ? t("composer.stop") : sendLabel}
              title={canStop ? t("composer.stop") : sendLabel}
            >
              {canStop ? (
                <>
                  <span className="composer-action-stop-square" aria-hidden />
                  {isProcessing && (
                    <span className="composer-action-spinner" aria-hidden />
                  )}
                </>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M12 5l6 6m-6-6L6 11m6-6v14"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
        {isDictationBusy && (
          <DictationWaveform
            active={isDictating}
            processing={dictationState === "processing"}
            level={dictationLevel}
          />
        )}
        {dictationError && (
          <div className="composer-dictation-error" role="status">
            <span>{dictationError}</span>
            <button
              type="button"
              className="ghost composer-dictation-error-dismiss"
              onClick={onDismissDictationError}
            >
              {t("composer.close")}
            </button>
          </div>
        )}
        {dictationHint && (
          <div className="composer-dictation-hint" role="status">
            <span>{dictationHint}</span>
            {onDismissDictationHint && (
              <button
                type="button"
                className="ghost composer-dictation-error-dismiss"
                onClick={onDismissDictationHint}
              >
                {t("composer.close")}
              </button>
            )}
          </div>
        )}
        <ComposerSuggestionsPopover
          highlightIndex={highlightIndex}
          highlightedBranchIndex={highlightedBranchIndex}
          highlightedCommitIndex={highlightedCommitIndex}
          highlightedPresetIndex={highlightedPresetIndex}
          onHighlightIndex={onHighlightIndex}
          onReviewPromptChoosePreset={onReviewPromptChoosePreset}
          onReviewPromptClose={onReviewPromptClose}
          onReviewPromptConfirmBranch={onReviewPromptConfirmBranch}
          onReviewPromptConfirmCommit={onReviewPromptConfirmCommit}
          onReviewPromptConfirmCustom={onReviewPromptConfirmCustom}
          onReviewPromptHighlightBranch={onReviewPromptHighlightBranch}
          onReviewPromptHighlightCommit={onReviewPromptHighlightCommit}
          onReviewPromptHighlightPreset={onReviewPromptHighlightPreset}
          onReviewPromptSelectBranch={onReviewPromptSelectBranch}
          onReviewPromptSelectBranchAtIndex={onReviewPromptSelectBranchAtIndex}
          onReviewPromptSelectCommit={onReviewPromptSelectCommit}
          onReviewPromptSelectCommitAtIndex={onReviewPromptSelectCommitAtIndex}
          onReviewPromptShowPreset={onReviewPromptShowPreset}
          onReviewPromptUpdateCustomInstructions={onReviewPromptUpdateCustomInstructions}
          onSelectSuggestion={onSelectSuggestion}
          reviewPrompt={reviewPrompt}
          suggestionListRef={suggestionListRef}
          suggestionRefs={suggestionRefs}
          suggestions={suggestions}
          suggestionsOpen={suggestionsOpen}
          suggestionsStyle={suggestionsStyle}
        />
      </div>
    </div>
  );
}
