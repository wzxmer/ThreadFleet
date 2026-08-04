import { useCallback, useLayoutEffect, useRef } from "react";
import type { ManagedSessionPreviewItem } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import { Markdown } from "@/features/messages/components/Markdown";
import { normalizeMessageImageSrc } from "@/features/messages/utils/messageRenderUtils";
import { useMessageHistoryWindow } from "@/features/messages/components/useMessageHistoryWindow";

const SESSION_CONTENT_BATCH_SIZE = 40;

type Props = {
  sessionKey: string;
  items: ManagedSessionPreviewItem[];
  loading: boolean;
  error: string | null;
  incomplete: boolean;
  fallback: string | null;
  workspacePath?: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadEarlier?: () => Promise<void>;
};

const HISTORY_SCROLL_THRESHOLD_PX = 24;

export function SessionManagerConversation({ sessionKey, items, loading, error, incomplete, fallback, workspacePath = null, hasMore = false, loadingMore = false, onLoadEarlier }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initialScrollSessionRef = useRef<string | null>(null);
  const followLatestRef = useRef(true);
  const resizeScrollFrameRef = useRef<number | null>(null);
  const pendingRemoteScrollRestoreRef = useRef<{
    previousScrollHeight: number;
    previousScrollTop: number;
    previousItemCount: number;
  } | null>(null);
  const historyWindow = useMessageHistoryWindow({
    items,
    threadId: sessionKey,
    batchSize: SESSION_CONTENT_BATCH_SIZE,
    containerRef,
  });
  const loadEarlier = useCallback(() => {
    if (historyWindow.hiddenBeforeCount > 0) {
      historyWindow.loadEarlier();
      return;
    }
    if (!hasMore || loadingMore || !onLoadEarlier) return;
    const container = containerRef.current;
    if (container) {
      pendingRemoteScrollRestoreRef.current = {
        previousScrollHeight: container.scrollHeight,
        previousScrollTop: container.scrollTop,
        previousItemCount: items.length,
      };
    }
    void onLoadEarlier();
  }, [hasMore, historyWindow, items.length, loadingMore, onLoadEarlier]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (loading || !container || items.length === 0) return;
    const pendingRestore = pendingRemoteScrollRestoreRef.current;
    if (
      pendingRestore &&
      items.length > pendingRestore.previousItemCount &&
      historyWindow.visibleItems.length === items.length
    ) {
      container.scrollTop =
        container.scrollHeight - pendingRestore.previousScrollHeight + pendingRestore.previousScrollTop;
      pendingRemoteScrollRestoreRef.current = null;
      return;
    }
    if (initialScrollSessionRef.current !== sessionKey) {
      container.scrollTop = container.scrollHeight;
      initialScrollSessionRef.current = sessionKey;
    }
  }, [historyWindow.visibleItems.length, items.length, loading, sessionKey]);

  useLayoutEffect(() => {
    followLatestRef.current = true;
  }, [sessionKey]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = container?.querySelector<HTMLElement>(".session-manager-preview-content");
    if (loading || !container || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!followLatestRef.current) return;
      if (resizeScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeScrollFrameRef.current);
      }
      resizeScrollFrameRef.current = window.requestAnimationFrame(() => {
        resizeScrollFrameRef.current = null;
        if (followLatestRef.current && containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (resizeScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeScrollFrameRef.current);
        resizeScrollFrameRef.current = null;
      }
    };
  }, [items.length, loading, sessionKey]);

  return (
    <section className="session-manager-latest-preview">
      <h2>{t("sessionManager.conversationContent")}</h2>
      {loading ? (
        <div className="session-manager-preview-state">{t("sessionManager.previewLoading")}</div>
      ) : error ? (
        <div className="session-manager-preview-state is-error">{t("sessionManager.previewUnavailable")}</div>
      ) : items.length ? (
        <div
          className="session-manager-preview-items"
          ref={containerRef}
          onScroll={(event) => {
            const container = event.currentTarget;
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            followLatestRef.current = distanceFromBottom <= HISTORY_SCROLL_THRESHOLD_PX;
            historyWindow.handleHistoryScroll(container);
            if (
              container.scrollTop <= HISTORY_SCROLL_THRESHOLD_PX &&
              historyWindow.hiddenBeforeCount === 0
            ) {
              loadEarlier();
            }
          }}
          >
          <div className="session-manager-preview-content">
            {(historyWindow.hiddenBeforeCount > 0 || hasMore) && (
              <button
                type="button"
                className="session-manager-preview-load-earlier"
                data-button-elevation="none"
                onClick={loadEarlier}
                disabled={loadingMore}
              >
                {loadingMore ? t("sessionManager.previewLoading") : t("sessionManager.loadEarlierMessages")}
              </button>
            )}
            {historyWindow.visibleItems.map((item, index) => (
              <article key={`${historyWindow.hiddenBeforeCount + index}-${item.role}`} className={`session-manager-preview-item is-${item.role}`}>
                <span>{item.role === "user" ? t("sessionManager.previewUser") : t("sessionManager.previewAssistant")}</span>
                {item.images && item.images.length > 0 && (
                  <div className="session-manager-preview-images">
                    {item.images.map((image, imageIndex) => {
                      const src = normalizeMessageImageSrc(image);
                      if (!src) return null;
                      return <img key={`${image}-${imageIndex}`} src={src} alt={t("files.imagePreview")} loading="lazy" />;
                    })}
                  </div>
                )}
                {item.text && (
                  <Markdown
                    value={item.text}
                    className="session-manager-preview-markdown markdown"
                    workspacePath={workspacePath}
                  />
                )}
              </article>
            ))}
          </div>
        </div>
      ) : fallback ? (
        <div className="session-manager-detail-preview">{fallback}</div>
      ) : (
        <div className="session-manager-preview-state">{t("sessionManager.previewEmpty")}</div>
      )}
      {incomplete && <div className="session-manager-preview-note">{t("sessionManager.contentIncomplete")}</div>}
    </section>
  );
}
