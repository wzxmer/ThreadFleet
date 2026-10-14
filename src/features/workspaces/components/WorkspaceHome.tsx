import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type {
  AppOption,
  CustomPromptOption,
  DictationSessionState,
  DictationTranscript,
  ModelOption,
  SkillOption,
  WorkspaceInfo,
} from "../../../types";
import { ComposerInput } from "../../composer/components/ComposerInput";
import { useComposerImages } from "../../composer/hooks/useComposerImages";
import { useComposerPasteUndo } from "../../composer/hooks/useComposerPasteUndo";
import { useComposerAutocompleteState } from "../../composer/hooks/useComposerAutocompleteState";
import type { AgentEngine } from "@/types";
import { usePromptHistory } from "../../composer/hooks/usePromptHistory";
import type {
  WorkspaceHomeRun,
  WorkspaceHomeRunInstance,
  WorkspaceRunMode,
} from "../hooks/useWorkspaceHome";
import { computeDictationInsertion } from "../../../utils/dictation";
import { isComposingEvent } from "../../../utils/keys";
import { FileEditorCard } from "../../shared/components/FileEditorCard";
import { WorkspaceHomeRunControls } from "./WorkspaceHomeRunControls";
import { WorkspaceHomeHistory } from "./WorkspaceHomeHistory";
import { WorkspaceHomeGitInitBanner } from "./WorkspaceHomeGitInitBanner";
import { buildIconPath } from "./workspaceHomeHelpers";
import { useWorkspaceHomeSuggestionsStyle } from "../hooks/useWorkspaceHomeSuggestionsStyle";
import type { ThreadStatusById } from "../../../utils/threadStatus";

type WorkspaceHomeProps = {
  agentEngine?: AgentEngine;
  workspace: WorkspaceInfo;
  showGitInitBanner: boolean;
  initGitRepoLoading: boolean;
  onInitGitRepo: () => void | Promise<void>;
  runs: WorkspaceHomeRun[];
  recentThreadInstances: WorkspaceHomeRunInstance[];
  recentThreadsUpdatedAt: number | null;
  prompt: string;
  onPromptChange: (value: string) => void;
  onStartRun: (images?: string[]) => Promise<boolean>;
  runMode: WorkspaceRunMode;
  onRunModeChange: (mode: WorkspaceRunMode) => void;
  models: ModelOption[];
  selectedModelId: string | null;
  onSelectModel: (modelId: string) => void;
  modelSelections: Record<string, number>;
  onToggleModel: (modelId: string) => void;
  onModelCountChange: (modelId: string, count: number) => void;
  collaborationModes: { id: string; label: string }[];
  selectedCollaborationModeId: string | null;
  onSelectCollaborationMode: (id: string | null) => void;
  reasoningOptions: string[];
  selectedEffort: string | null;
  onSelectEffort: (effort: string) => void;
  reasoningSupported: boolean;
  error: string | null;
  isSubmitting: boolean;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  threadStatusById: ThreadStatusById;
  onSelectInstance: (workspaceId: string, threadId: string) => void;
  skills: SkillOption[];
  appsEnabled: boolean;
  apps: AppOption[];
  prompts: CustomPromptOption[];
  files: string[];
  dictationEnabled: boolean;
  dictationState: DictationSessionState;
  dictationLevel: number;
  onToggleDictation: () => void;
  onCancelDictation?: () => void;
  onOpenDictationSettings: () => void;
  dictationError: string | null;
  onDismissDictationError: () => void;
  dictationHint: string | null;
  onDismissDictationHint: () => void;
  dictationTranscript: DictationTranscript | null;
  onDictationTranscriptHandled: (id: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onFileAutocompleteActiveChange?: (active: boolean) => void;
  agentMdContent: string;
  agentMdExists: boolean;
  agentMdTruncated: boolean;
  agentMdLoading: boolean;
  agentMdSaving: boolean;
  agentMdError: string | null;
  agentMdDirty: boolean;
  onAgentMdChange: (value: string) => void;
  onAgentMdRefresh: () => void;
  onAgentMdSave: () => void;
};

export function WorkspaceHome({
  agentEngine = "codex",
  workspace,
  showGitInitBanner,
  initGitRepoLoading,
  onInitGitRepo,
  runs,
  recentThreadInstances,
  recentThreadsUpdatedAt,
  prompt,
  onPromptChange,
  onStartRun,
  runMode,
  onRunModeChange,
  models,
  selectedModelId,
  onSelectModel,
  modelSelections,
  onToggleModel,
  onModelCountChange,
  collaborationModes,
  selectedCollaborationModeId,
  onSelectCollaborationMode,
  reasoningOptions,
  selectedEffort,
  onSelectEffort,
  reasoningSupported,
  error,
  isSubmitting,
  activeWorkspaceId,
  activeThreadId,
  threadStatusById,
  onSelectInstance,
  skills,
  appsEnabled,
  apps,
  prompts,
  files,
  dictationEnabled,
  dictationState,
  dictationLevel,
  onToggleDictation,
  onCancelDictation,
  onOpenDictationSettings,
  dictationError,
  onDismissDictationError,
  dictationHint,
  onDismissDictationHint,
  dictationTranscript,
  onDictationTranscriptHandled,
  textareaRef: textareaRefProp,
  onFileAutocompleteActiveChange,
  agentMdContent,
  agentMdExists,
  agentMdTruncated,
  agentMdLoading,
  agentMdSaving,
  agentMdError,
  agentMdDirty,
  onAgentMdChange,
  onAgentMdRefresh,
  onAgentMdSave,
}: WorkspaceHomeProps) {
  const [showIcon, setShowIcon] = useState(true);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const iconPath = useMemo(() => buildIconPath(workspace.path), [workspace.path]);
  const iconSrc = useMemo(() => convertFileSrc(iconPath), [iconPath]);
  const fallbackTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = textareaRefProp ?? fallbackTextareaRef;
  const {
    activeImages,
    attachImages,
    pickImages,
    removeImage,
    clearActiveImages,
    replaceActiveImages,
    activeImageDraftKey,
  } = useComposerImages({
    activeThreadId: null,
    activeWorkspaceId: workspace.id,
  });

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
    agentEngine,
    text: prompt,
    selectionStart,
    disabled: isSubmitting,
    appsEnabled,
    skills,
    apps,
    prompts,
    files,
    textareaRef,
    setText: onPromptChange,
    setSelectionStart,
  });

  const {
    beginPasteAttachments,
    clearPasteUndoHistory,
    handlePasteUndoKeyDown,
    markNativeHistoryChange,
    pasteAttachments,
  } = useComposerPasteUndo({
    text: prompt,
    attachments: activeImages,
    draftKey: activeImageDraftKey,
    textareaRef,
    onAttachImages: attachImages,
    onReplaceImages: replaceActiveImages,
    onSelectionChange: handleSelectionChange,
  });

  const suggestionsStyle = useWorkspaceHomeSuggestionsStyle({
    isAutocompleteOpen,
    autocompleteAnchorIndex,
    selectionStart,
    prompt,
    textareaRef,
  });

  useEffect(() => {
    onFileAutocompleteActiveChange?.(fileTriggerActive);
  }, [fileTriggerActive, onFileAutocompleteActiveChange]);

  const {
    handleHistoryKeyDown,
    handleHistoryTextChange,
    recordHistory,
    resetHistoryNavigation,
  } = usePromptHistory({
    historyKey: workspace.id,
    text: prompt,
    hasAttachments: activeImages.length > 0,
    disabled: isSubmitting,
    isAutocompleteOpen,
    textareaRef,
    setText: onPromptChange,
    setSelectionStart,
  });

  const handleTextChangeWithHistory = (next: string, cursor: number | null) => {
    markNativeHistoryChange();
    handleHistoryTextChange(next);
    handleTextChange(next, cursor);
  };

  const handleAttachImages = (paths: string[]) => {
    clearPasteUndoHistory();
    attachImages(paths);
  };

  const handlePasteAttachments = (paths: string[]) => {
    pasteAttachments(paths);
  };

  const handleRemoveImage = (path: string) => {
    clearPasteUndoHistory();
    removeImage(path);
  };

  const isDictationBusy = dictationState !== "idle";

  useEffect(() => {
    setShowIcon(true);
  }, [workspace.id]);

  useEffect(() => {
    if (!dictationTranscript) {
      return;
    }
    const textToInsert = dictationTranscript.text.trim();
    if (!textToInsert) {
      onDictationTranscriptHandled(dictationTranscript.id);
      return;
    }

    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? selectionStart ?? prompt.length;
    const end = textarea?.selectionEnd ?? start;
    const { nextText, nextCursor } = computeDictationInsertion(
      prompt,
      textToInsert,
      start,
      end,
    );

    clearPasteUndoHistory();
    onPromptChange(nextText);
    resetHistoryNavigation();

    requestAnimationFrame(() => {
      if (!textareaRef.current) {
        return;
      }
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(nextCursor, nextCursor);
      setSelectionStart(nextCursor);
    });

    onDictationTranscriptHandled(dictationTranscript.id);
  }, [
    dictationTranscript,
    clearPasteUndoHistory,
    onDictationTranscriptHandled,
    onPromptChange,
    prompt,
    resetHistoryNavigation,
    selectionStart,
    textareaRef,
  ]);

  const handleRunSubmit = async () => {
    if (!prompt.trim() && activeImages.length === 0) {
      return;
    }
    if (isDictationBusy) {
      return;
    }

    const trimmed = prompt.trim();
    const didStart = await onStartRun(activeImages);
    if (didStart) {
      if (trimmed) {
        recordHistory(trimmed);
      }
      resetHistoryNavigation();
      clearPasteUndoHistory();
      clearActiveImages();
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingEvent(event)) {
      return;
    }

    if (handlePasteUndoKeyDown(event)) {
      return;
    }

    handleHistoryKeyDown(event);
    if (event.defaultPrevented) {
      return;
    }

    handleInputKeyDown(event);
    if (event.defaultPrevented) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      if (isDictationBusy) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      void handleRunSubmit();
    }
  };

  const agentMdStatus = agentMdLoading
    ? "加载中..."
    : agentMdSaving
      ? "保存中..."
      : agentMdExists
        ? ""
        : "未找到";
  const agentMdMetaParts: string[] = [];
  if (agentMdStatus) {
    agentMdMetaParts.push(agentMdStatus);
  }
  if (agentMdTruncated) {
    agentMdMetaParts.push("已截断");
  }
  const agentMdMeta = agentMdMetaParts.join(" · ");
  const agentMdSaveLabel = agentMdExists ? "保存" : "创建";
  const agentMdSaveDisabled = agentMdLoading || agentMdSaving || !agentMdDirty;
  const agentMdRefreshDisabled = agentMdLoading || agentMdSaving;

  return (
    <div className="workspace-home">
      <div className="workspace-home-hero">
        {showIcon && (
          <img
            className="workspace-home-icon"
            src={iconSrc}
            alt=""
            onError={() => setShowIcon(false)}
          />
        )}
        <div>
          <div className="workspace-home-title">{workspace.name}</div>
          <div className="workspace-home-path">{workspace.path}</div>
        </div>
      </div>

      {showGitInitBanner && (
        <WorkspaceHomeGitInitBanner
          isLoading={initGitRepoLoading}
          onInitGitRepo={onInitGitRepo}
        />
      )}

      <div className="workspace-home-composer">
        <div className="composer">
          <ComposerInput
            agentEngine={agentEngine}
            text={prompt}
            disabled={isSubmitting}
            sendLabel="发送"
            canStop={false}
            canSend={prompt.trim().length > 0 || activeImages.length > 0}
            isProcessing={isSubmitting}
            onStop={() => {}}
            onSend={() => {
              void handleRunSubmit();
            }}
            dictationState={dictationState}
            dictationLevel={dictationLevel}
            dictationEnabled={dictationEnabled}
            onToggleDictation={onToggleDictation}
            onCancelDictation={onCancelDictation}
            onOpenDictationSettings={onOpenDictationSettings}
            dictationError={dictationError}
            onDismissDictationError={onDismissDictationError}
            dictationHint={dictationHint}
            onDismissDictationHint={onDismissDictationHint}
            attachments={activeImages}
            onAddAttachment={() => {
              clearPasteUndoHistory();
              void pickImages();
            }}
            onAttachImages={handleAttachImages}
            onPasteAttachments={handlePasteAttachments}
            onBeginPasteAttachments={beginPasteAttachments}
            onRemoveAttachment={handleRemoveImage}
            onTextChange={handleTextChangeWithHistory}
            onSelectionChange={handleSelectionChange}
            onKeyDown={handleComposerKeyDown}
            isExpanded={false}
            onToggleExpand={undefined}
            textareaRef={textareaRef}
            suggestionsOpen={isAutocompleteOpen}
            suggestions={autocompleteMatches}
            highlightIndex={highlightIndex}
            onHighlightIndex={setHighlightIndex}
            onSelectSuggestion={applyAutocomplete}
            suggestionsStyle={suggestionsStyle}
          />
        </div>
        {error && <div className="workspace-home-error">{error}</div>}
      </div>

      <WorkspaceHomeRunControls
        agentEngine={agentEngine}
        workspaceKind={workspace.kind}
        runMode={runMode}
        onRunModeChange={onRunModeChange}
        models={models}
        selectedModelId={selectedModelId}
        onSelectModel={onSelectModel}
        modelSelections={modelSelections}
        onToggleModel={onToggleModel}
        onModelCountChange={onModelCountChange}
        collaborationModes={collaborationModes}
        selectedCollaborationModeId={selectedCollaborationModeId}
        onSelectCollaborationMode={onSelectCollaborationMode}
        reasoningOptions={reasoningOptions}
        selectedEffort={selectedEffort}
        onSelectEffort={onSelectEffort}
        reasoningSupported={reasoningSupported}
        isSubmitting={isSubmitting}
      />

      <div className="workspace-home-agent">
        {agentMdTruncated && (
          <div className="workspace-home-agent-warning">
            文件较大，仅显示前半部分。
          </div>
        )}
        <FileEditorCard
          title="AGENTS.md"
          meta={agentMdMeta}
          error={agentMdError}
          value={agentMdContent}
          placeholder="添加这个项目给 Agent 的说明..."
          disabled={agentMdLoading}
          refreshDisabled={agentMdRefreshDisabled}
          saveDisabled={agentMdSaveDisabled}
          saveLabel={agentMdSaveLabel}
          onChange={onAgentMdChange}
          onRefresh={onAgentMdRefresh}
          onSave={onAgentMdSave}
          classNames={{
            container: "workspace-home-agent-card",
            header: "workspace-home-section-header",
            title: "workspace-home-section-title",
            actions: "workspace-home-section-actions",
            meta: "workspace-home-section-meta",
            iconButton: "ghost workspace-home-icon-button",
            error: "workspace-home-error",
            textarea: "workspace-home-agent-textarea",
            help: "workspace-home-section-meta",
          }}
        />
      </div>

      <WorkspaceHomeHistory
        runs={runs}
        recentThreadInstances={recentThreadInstances}
        recentThreadsUpdatedAt={recentThreadsUpdatedAt}
        activeWorkspaceId={activeWorkspaceId}
        activeThreadId={activeThreadId}
        threadStatusById={threadStatusById}
        onSelectInstance={onSelectInstance}
      />
    </div>
  );
}
