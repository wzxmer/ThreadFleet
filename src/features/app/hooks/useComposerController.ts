import { useCallback, useRef, useState } from "react";
import type {
  AppMention,
  ComposerSendIntent,
  ComposerSubmission,
  ComposerTriggerMode,
  FollowUpMessageBehavior,
  QueuedMessage,
  SendMessageResult,
  WorkspaceInfo,
  ComposerReference,
} from "../../../types";
import { useComposerImages } from "../../composer/hooks/useComposerImages";
import { useQueuedSend } from "../../threads/hooks/useQueuedSend";
import {
  stripReferenceText,
} from "../../messages/utils/messageReferences";

export function useComposerController({
  activeThreadId,
  activeTurnId,
  activeWorkspaceId,
  activeWorkspace,
  isProcessing,
  isReviewing,
  queueFlushPaused = false,
  steerEnabled,
  followUpMessageBehavior,
  composerTriggerMode,
  appsEnabled,
  connectWorkspace,
  startThreadForWorkspace,
  sendUserMessage,
  sendUserMessageToThread,
  startFork,
  startReview,
  startResume,
  startCompact,
  startApps,
  startMcp,
  startFast,
  startStatus,
}: {
  activeThreadId: string | null;
  activeTurnId: string | null;
  activeWorkspaceId: string | null;
  activeWorkspace: WorkspaceInfo | null;
  isProcessing: boolean;
  isReviewing: boolean;
  queueFlushPaused?: boolean;
  steerEnabled: boolean;
  followUpMessageBehavior: FollowUpMessageBehavior;
  composerTriggerMode?: ComposerTriggerMode;
  appsEnabled: boolean;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  startThreadForWorkspace: (
    workspaceId: string,
    options?: { activate?: boolean },
  ) => Promise<string | null>;
  sendUserMessage: (
    text: string,
    images?: string[],
    appMentions?: AppMention[],
    options?: {
      sendIntent?: ComposerSendIntent;
      replaceMessageId?: string;
      submission?: ComposerSubmission;
    },
  ) => Promise<{ status: "sent" | "blocked" | "steer_failed" }>;
  sendUserMessageToThread: (
    workspace: WorkspaceInfo,
    threadId: string,
    text: string,
    images?: string[],
  ) => Promise<void | SendMessageResult>;
  startFork: (text: string) => Promise<void>;
  startReview: (text: string) => Promise<void>;
  startResume: (text: string) => Promise<void>;
  startCompact: (text: string) => Promise<void>;
  startApps: (text: string) => Promise<void>;
  startMcp: (text: string) => Promise<void>;
  startFast: (text: string) => Promise<void>;
  startStatus: (text: string) => Promise<void>;
}) {
  const composerDraftsByThreadRef = useRef<Record<string, string>>({});
  const [, setDraftRevision] = useState(0);
  const [prefillDraft, setPrefillDraft] = useState<QueuedMessage | null>(null);
  const [composerInsert, setComposerInsert] = useState<QueuedMessage | null>(
    null,
  );
  const [composerReferencesByDraft, setComposerReferencesByDraft] = useState<Record<string, ComposerReference[]>>({});
  const referenceUndoRef = useRef<Record<string, Array<{ text: string; references: ComposerReference[] }>>>({});
  const referenceRedoRef = useRef<Record<string, Array<{ text: string; references: ComposerReference[] }>>>({});
  const draftKey = activeThreadId ?? activeWorkspaceId;
  const {
    activeImageDraftKey,
    activeImages,
    attachImages,
    pickImages,
    removeImage,
    clearActiveImages,
    replaceActiveImages,
    transferActiveImages,
    restoreImagesForDraft,
    setImagesForThread,
    removeImagesForThread,
  } = useComposerImages({ activeThreadId, activeWorkspaceId });

  const {
    activeQueue,
    handleSend: handleQueuedSend,
    queueMessage,
    removeQueuedMessage,
    clearQueuedMessages,
    steerQueuedMessage,
  } = useQueuedSend({
    activeThreadId,
    activeTurnId,
    isProcessing,
    isReviewing,
    queueFlushPaused,
    steerEnabled,
    followUpMessageBehavior,
    composerTriggerMode,
    appsEnabled,
    activeWorkspace,
    connectWorkspace,
    startThreadForWorkspace,
    sendUserMessage,
    sendUserMessageToThread,
    startFork,
    startReview,
    startResume,
    startCompact,
    startApps,
    startMcp,
    startFast,
    startStatus,
    clearActiveImages,
    transferActiveImages,
    restoreImagesForDraft,
    onReferencesAccepted: (acceptedReferences) => {
      if (!draftKey || acceptedReferences.length === 0) return;
      const acceptedIds = new Set(acceptedReferences.map((reference) => reference.id));
      setComposerReferencesByDraft((prev) => {
        const references = prev[draftKey] ?? [];
        const remaining = references.filter((reference) => !acceptedIds.has(reference.id));
        if (remaining.length === references.length) return prev;
        const next = { ...prev };
        if (remaining.length > 0) next[draftKey] = remaining;
        else delete next[draftKey];
        return next;
      });
      delete referenceUndoRef.current[draftKey];
      delete referenceRedoRef.current[draftKey];
    },
    onMessageRejected: (submittedText, references, images) => {
      if (!draftKey) return;
      const restoredText = stripReferenceText(
        submittedText,
        references.map((reference) => reference.prompt),
      );
      composerDraftsByThreadRef.current[draftKey] = restoredText;
      setImagesForThread(draftKey, images);
      setComposerReferencesByDraft((prev) => ({
        ...prev,
        [draftKey]: references,
      }));
      setDraftRevision((revision) => revision + 1);
    },
  });

  const handleSend = useCallback(async (
    text: string,
    images: string[] = [],
    appMentions: AppMention[] = [],
    submitIntent: ComposerSendIntent = "default",
    options?: { replaceMessageId?: string },
    references: ComposerReference[] = [],
    submission?: ComposerSubmission,
  ) => {
    try {
      await handleQueuedSend(
        text,
        images,
        appMentions,
        submitIntent,
        options,
        references,
        submission,
      );
    } catch (error) {
      if (draftKey && references.length > 0) {
        const restoredText = stripReferenceText(
          text,
          references.map((reference) => reference.prompt),
        );
        composerDraftsByThreadRef.current[draftKey] = restoredText;
        setDraftRevision((revision) => revision + 1);
      }
      throw error;
    }
  }, [draftKey, handleQueuedSend]);

  const activeDraft = draftKey
    ? composerDraftsByThreadRef.current[draftKey] ?? ""
    : "";

  const handleDraftChange = useCallback(
    (next: string) => {
      if (!draftKey) {
        return;
      }
      // Composer already owns immediate text rendering; this ref only mirrors cross-thread drafts.
      composerDraftsByThreadRef.current[draftKey] = next;
    },
    [draftKey],
  );

  const getActiveDraft = useCallback(
    () =>
      draftKey ? composerDraftsByThreadRef.current[draftKey] ?? "" : "",
    [draftKey],
  );

  const replaceActiveDraft = useCallback(
    (next: string) => {
      if (!draftKey) {
        return;
      }
      composerDraftsByThreadRef.current[draftKey] = next;
      // External insert/restore actions must push the mirrored value back into Composer.
      setDraftRevision((revision) => revision + 1);
    },
    [draftKey],
  );

  const insertDraftForThread = useCallback((threadId: string, insertText: string) => {
    if (!threadId || !insertText) {
      return;
    }
    const current = composerDraftsByThreadRef.current[threadId] ?? "";
    const separator = current && !/\s$/.test(current) && !/^\s/.test(insertText)
      ? "\n\n"
      : "";
    composerDraftsByThreadRef.current[threadId] = `${current}${separator}${insertText}`;
    if (threadId === draftKey) {
      setDraftRevision((revision) => revision + 1);
    }
  }, [draftKey]);

  const addComposerReference = useCallback((reference: ComposerReference) => {
    if (!draftKey) return;
    referenceUndoRef.current[draftKey] = [
      ...(referenceUndoRef.current[draftKey] ?? []),
      { text: composerDraftsByThreadRef.current[draftKey] ?? "", references: composerReferencesByDraft[draftKey] ?? [] },
    ].slice(-20);
    delete referenceRedoRef.current[draftKey];
    setComposerReferencesByDraft((prev) => ({
      ...prev,
      [draftKey]: [...(prev[draftKey] ?? []), reference],
    }));
  }, [composerReferencesByDraft, draftKey]);
  const addComposerReferenceForDraft = useCallback((targetDraftKey: string, reference: ComposerReference) => {
    setComposerReferencesByDraft((prev) => ({
      ...prev,
      [targetDraftKey]: [...(prev[targetDraftKey] ?? []), reference],
    }));
  }, []);
  const removeComposerReference = useCallback((id: string) => {
    if (!draftKey) return;
    referenceUndoRef.current[draftKey] = [
      ...(referenceUndoRef.current[draftKey] ?? []),
      { text: composerDraftsByThreadRef.current[draftKey] ?? "", references: composerReferencesByDraft[draftKey] ?? [] },
    ].slice(-20);
    delete referenceRedoRef.current[draftKey];
    setComposerReferencesByDraft((prev) => {
      const refs = prev[draftKey] ?? [];
      const target = refs.find((ref) => ref.id === id);
      if (!target) return prev;
      return { ...prev, [draftKey]: refs.filter((ref) => ref.id !== id) };
    });
  }, [composerReferencesByDraft, draftKey]);
  const toggleComposerReference = useCallback((id: string) => {
    if (!draftKey) return;
    referenceUndoRef.current[draftKey] = [
      ...(referenceUndoRef.current[draftKey] ?? []),
      { text: composerDraftsByThreadRef.current[draftKey] ?? "", references: composerReferencesByDraft[draftKey] ?? [] },
    ].slice(-20);
    delete referenceRedoRef.current[draftKey];
    setComposerReferencesByDraft((prev) => ({
      ...prev,
      [draftKey]: (prev[draftKey] ?? []).map((ref) => ref.id === id ? { ...ref, collapsed: !ref.collapsed } : ref),
    }));
  }, [composerReferencesByDraft, draftKey]);
  const reorderComposerReferences = useCallback((from: number, to: number) => {
    if (!draftKey || from === to) return;
    referenceUndoRef.current[draftKey] = [
      ...(referenceUndoRef.current[draftKey] ?? []),
      { text: composerDraftsByThreadRef.current[draftKey] ?? "", references: composerReferencesByDraft[draftKey] ?? [] },
    ].slice(-20);
    delete referenceRedoRef.current[draftKey];
    setComposerReferencesByDraft((prev) => {
      const refs = [...(prev[draftKey] ?? [])];
      if (!refs[from] || to < 0 || to >= refs.length) return prev;
      const [item] = refs.splice(from, 1); refs.splice(to, 0, item);
      return { ...prev, [draftKey]: refs };
    });
  }, [composerReferencesByDraft, draftKey]);

  const restoreReferenceHistory = useCallback((redo: boolean) => {
    if (!draftKey) return false;
    const source = redo ? referenceRedoRef.current : referenceUndoRef.current;
    const target = redo ? referenceUndoRef.current : referenceRedoRef.current;
    const stack = source[draftKey] ?? [];
    const snapshot = stack[stack.length - 1];
    if (!snapshot) return false;
    const currentText = composerDraftsByThreadRef.current[draftKey] ?? "";
    if (snapshot.text !== currentText) return false;
    target[draftKey] = [
      ...(target[draftKey] ?? []),
      { text: currentText, references: composerReferencesByDraft[draftKey] ?? [] },
    ].slice(-20);
    source[draftKey] = stack.slice(0, -1);
    composerDraftsByThreadRef.current[draftKey] = snapshot.text;
    setDraftRevision((revision) => revision + 1);
    setComposerReferencesByDraft((prev) => ({ ...prev, [draftKey]: snapshot.references }));
    return true;
  }, [composerReferencesByDraft, draftKey]);

  const handleSendPrompt = useCallback(
    (text: string, appMentions?: AppMention[]) => {
      if (!text.trim()) {
        return;
      }
      void handleSend(text, [], appMentions, "default", undefined, []);
    },
    [handleSend],
  );

  const handleEditQueued = useCallback(
    (item: QueuedMessage) => {
      if (!activeThreadId) {
        return;
      }
      removeQueuedMessage(activeThreadId, item.id);
      setImagesForThread(activeThreadId, item.images ?? []);
      setComposerReferencesByDraft((prev) => ({
        ...prev,
        [activeThreadId]: item.references ?? [],
      }));
      setPrefillDraft({
        ...item,
        text: stripReferenceText(
          item.text,
          (item.references ?? []).map((reference) => reference.prompt),
        ),
      });
    },
    [activeThreadId, removeQueuedMessage, setImagesForThread],
  );

  const handleDeleteQueued = useCallback(
    (id: string) => {
      if (!activeThreadId) {
        return;
      }
      removeQueuedMessage(activeThreadId, id);
    },
    [activeThreadId, removeQueuedMessage],
  );

  const clearDraftForThread = useCallback((threadId: string) => {
    if (!(threadId in composerDraftsByThreadRef.current)) {
      return;
    }
    delete composerDraftsByThreadRef.current[threadId];
    if (threadId === draftKey) {
      setDraftRevision((revision) => revision + 1);
    }
  }, [draftKey]);

  return {
    activeImageDraftKey,
    activeImages,
    attachImages,
    pickImages,
    removeImage,
    clearActiveImages,
    replaceActiveImages,
    setImagesForThread,
    removeImagesForThread,
    activeQueue,
    handleSend,
    queueMessage,
    removeQueuedMessage,
    clearQueuedMessages,
    steerQueuedMessage,
    prefillDraft,
    setPrefillDraft,
    composerInsert,
    setComposerInsert,
    activeDraft,
    handleDraftChange,
    getActiveDraft,
    replaceActiveDraft,
    insertDraftForThread,
    composerReferences: draftKey ? composerReferencesByDraft[draftKey] ?? [] : [],
    addComposerReference,
    addComposerReferenceForDraft,
    removeComposerReference,
    toggleComposerReference,
    reorderComposerReferences,
    undoComposerReference: () => restoreReferenceHistory(false),
    redoComposerReference: () => restoreReferenceHistory(true),
    handleSendPrompt,
    handleEditQueued,
    handleDeleteQueued,
    clearDraftForThread,
  };
}
