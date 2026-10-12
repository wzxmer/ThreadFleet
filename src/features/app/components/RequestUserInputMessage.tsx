import type { RequestUserInputRequest, RequestUserInputResponse } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import { UserInputForm } from "./UserInputForm";

type RequestUserInputMessageProps = {
  requests: RequestUserInputRequest[];
  activeThreadId: string | null;
  activeWorkspaceId?: string | null;
  onSubmit: (request: RequestUserInputRequest, response: RequestUserInputResponse) => Promise<void> | void;
};

export function RequestUserInputMessage({
  requests, activeThreadId, activeWorkspaceId, onSubmit,
}: RequestUserInputMessageProps) {
  const { t } = useI18n();
  const activeRequests = requests.filter((request) =>
    activeThreadId && request.params.thread_id === activeThreadId &&
    (!activeWorkspaceId || request.workspace_id === activeWorkspaceId),
  );
  const request = activeRequests[0];
  if (!request) return null;
  return (
    <div className="message request-user-input-message">
      <UserInputForm
        key={`${request.workspace_id}:${typeof request.request_id}:${request.request_id}`}
        draftKey={request}
        questions={request.params.questions}
        title={t("userInput.title")}
        description={t("userInput.required")}
        queueLabel={activeRequests.length > 1 ? t("userInput.queue").replace("{count}", String(activeRequests.length)) : undefined}
        onSubmit={(response) => onSubmit(request, response)}
      />
    </div>
  );
}
