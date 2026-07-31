import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/features/i18n/I18nProvider";
import { pickConversationExportPath, writeBinaryFile } from "@services/tauri";
import type { ConversationItem, TurnExecutionSummary } from "@/types";
import {
  buildConversationExportFileName,
  buildConversationExportMessages,
  countConversationExportImages,
  getExportableMessageIds,
  type ConversationExportFormat,
  type ConversationExportProgress,
} from "./conversationExport";
import {
  ConversationExportCancelledError,
  ConversationExportImageTooTallError,
  renderConversationExport,
} from "./conversationExportRenderer";

type UseConversationExportOptions = {
  items: ConversationItem[];
  summaries: TurnExecutionSummary[];
  threadId: string | null;
};

export function useConversationExport({
  items,
  summaries,
  threadId,
}: UseConversationExportOptions) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const [progress, setProgress] = useState<ConversationExportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const exportableIds = useMemo(() => getExportableMessageIds(items), [items]);

  useEffect(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setBusy(false);
    setSelectedIds(null);
    setProgress(null);
  }, [threadId]);

  const startSelection = useCallback((messageId: string) => {
    setSelectedIds(new Set([messageId]));
  }, []);

  const toggleSelection = useCallback((messageId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current ?? []);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds((current) =>
      current?.size === exportableIds.length ? new Set() : new Set(exportableIds),
    );
  }, [exportableIds]);

  const exportConversation = useCallback(async (format: ConversationExportFormat) => {
    if (!selectedIds || selectedIds.size === 0 || abortControllerRef.current) return;
    const path = await pickConversationExportPath(
      format,
      buildConversationExportFileName(format),
      t("messages.exportSaveTitle"),
    );
    if (!path) return;
    const messages = buildConversationExportMessages(
      items,
      summaries,
      {
        user: t("messages.exportUserLabel"),
        assistantFallback: t("messages.exportAiLabel"),
      },
      selectedIds,
    );
    const imageCount = countConversationExportImages(messages);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBusy(true);
    setProgress({
      stage: "preparing",
      completed: 0,
      total: 0,
      messageCount: messages.length,
      imageCount,
    });
    try {
      const bytes = await renderConversationExport({
        format,
        messages,
        exportedAt: new Date(),
        exportedAtLabel: t("messages.exportedAt"),
        imageUnavailableLabel: t("messages.exportImageUnavailable"),
        signal: controller.signal,
        onProgress: (completed, total) => setProgress((current) =>
          current ? { ...current, stage: "rendering", completed, total } : current,
        ),
      });
      if (controller.signal.aborted) throw new ConversationExportCancelledError();
      setProgress((current) =>
        current ? { ...current, stage: "saving", completed: 0, total: 0 } : current,
      );
      await writeBinaryFile(path, bytes, {
        signal: controller.signal,
        onProgress: (completed, total) => setProgress((current) =>
          current ? { ...current, stage: "saving", completed, total } : current,
        ),
      });
      setSelectedIds(null);
      setProgress((current) => current ? { ...current, stage: "completed", path } : current);
    } catch (error) {
      if (controller.signal.aborted || error instanceof ConversationExportCancelledError) {
        setProgress(null);
      } else {
        const message = error instanceof ConversationExportImageTooTallError
          ? t("messages.exportImageTooTall")
          : error instanceof Error ? error.message : String(error);
        setProgress((current) => ({
          stage: "error",
          completed: 0,
          total: 0,
          messageCount: current?.messageCount ?? messages.length,
          imageCount: current?.imageCount ?? imageCount,
          error: message,
        }));
      }
    } finally {
      abortControllerRef.current = null;
      setBusy(false);
    }
  }, [items, selectedIds, summaries, t]);

  return {
    selecting: selectedIds !== null,
    selectedIds: selectedIds ?? new Set<string>(),
    selectedCount: selectedIds?.size ?? 0,
    totalCount: exportableIds.length,
    busy,
    progress,
    startSelection,
    toggleSelection,
    selectAll,
    cancelSelection: () => setSelectedIds(null),
    cancelExport: () => abortControllerRef.current?.abort(),
    dismissProgress: () => setProgress(null),
    exportConversation,
  };
}
