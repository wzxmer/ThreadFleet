import { Markdown } from "../components/Markdown";
import { normalizeMessageImageSrc } from "../utils/messageRenderUtils";
import type { ConversationExportMessage } from "./conversationExport";

type ConversationExportDocumentProps = {
  messages: ConversationExportMessage[];
  exportedAt: Date;
  exportedAtLabel: string;
  imageUnavailableLabel: string;
};

export function ConversationExportDocument({
  messages,
  exportedAt,
  exportedAtLabel,
  imageUnavailableLabel,
}: ConversationExportDocumentProps) {
  return (
    <article className="conversation-export-document">
      <header className="conversation-export-header" data-export-block>
        <div className="conversation-export-brand">ThreadFleet</div>
        <div className="conversation-export-time">
          {exportedAtLabel}: {exportedAt.toLocaleString()}
        </div>
      </header>
      <div className="conversation-export-messages">
        {messages.map((message) => (
          <section
            key={message.id}
            className={`conversation-export-message conversation-export-message--${message.role}`}
            data-export-block
          >
            <div className="conversation-export-role">{message.label}</div>
            {message.images.map((image, index) => {
              const src = normalizeMessageImageSrc(image);
              return (
                <div
                  key={`${image}-${index}`}
                  className="conversation-export-image-frame"
                  data-export-image
                >
                  {src ? (
                    <img
                      src={src}
                      alt=""
                      crossOrigin="anonymous"
                      onError={(event) => {
                        event.currentTarget.closest("[data-export-image]")?.setAttribute(
                          "data-image-error",
                          "true",
                        );
                      }}
                    />
                  ) : null}
                  <div className="conversation-export-image-placeholder">
                    {imageUnavailableLabel}
                  </div>
                </div>
              );
            })}
            {message.text.trim() ? (
              <Markdown
                value={message.text}
                className="conversation-export-markdown"
                codeBlockStyle="default"
                showFilePath={false}
              />
            ) : null}
          </section>
        ))}
      </div>
    </article>
  );
}
