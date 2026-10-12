import { useCallback, useRef } from "react";
import type { Dispatch } from "react";
import type {
  ConversationItem,
  RequestUserInputRequest,
  RequestUserInputResponse,
} from "@/types";
import { respondToUserInputRequest } from "@services/tauri";
import type { ThreadAction } from "./useThreadsReducer";
import { useI18n } from "@/features/i18n/I18nProvider";

type UseThreadUserInputOptions = {
  dispatch: Dispatch<ThreadAction>;
  requests: RequestUserInputRequest[];
};

function asString(value: unknown) {
  return typeof value === "string" ? value : value ? String(value) : "";
}

function buildUserInputConversationItem(
  request: RequestUserInputRequest,
  response: RequestUserInputResponse,
  secretAnswer: string,
  fallbackQuestion: string,
): Extract<ConversationItem, { kind: "userInput" }> {
  const threadId = asString(request.params.thread_id).trim();
  const turnId = asString(request.params.turn_id).trim();
  const itemId = asString(request.params.item_id).trim();
  const requestId = asString(request.request_id).trim();
  const answered = response.answers ?? {};
  const seen = new Set<string>();
  const questions = request.params.questions.map((question, index) => {
    const id = question.id || `question-${index + 1}`;
    seen.add(id);
    const record = answered[id];
    const answers = Array.isArray(record?.answers)
      ? record.answers.map((entry) => asString(entry).trim()).filter(Boolean)
      : [];
    return {
      id,
      header: asString(question.header).trim(),
      question: asString(question.question).trim(),
      answers: question.isSecret && answers.length ? [secretAnswer] : answers,
    };
  });
  const extra = Object.entries(answered)
    .filter(([id]) => !seen.has(id))
    .map(([id, value]) => {
      const answers = Array.isArray(value?.answers)
        ? value.answers.map((entry) => asString(entry).trim()).filter(Boolean)
        : [];
      return {
        id,
        header: "",
        question: id,
        answers,
      };
    });
  const entries = [...questions, ...extra];
  if (!entries.length) {
    entries.push({
      id: "user-input",
      header: "",
      question: fallbackQuestion,
      answers: [],
    });
  }
  return {
    id: itemId
      ? [
          "user-input",
          request.workspace_id,
          threadId || "thread",
          turnId || "turn",
          itemId,
        ].join("-")
      : [
          "user-input",
          request.workspace_id,
          threadId || "thread",
          turnId || "turn",
          `request-${requestId || "unknown"}`,
        ].join("-"),
    kind: "userInput",
    status: "answered",
    questions: entries,
  };
}

export function useThreadUserInput({ dispatch, requests }: UseThreadUserInputOptions) {
  const { t } = useI18n();
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const inFlight = useRef(new Map<RequestUserInputRequest, Promise<void>>());
  const handleUserInputSubmit = useCallback(
    (request: RequestUserInputRequest, response: RequestUserInputResponse): Promise<void> => {
      const pending = inFlight.current.get(request);
      if (pending) return pending;
      if (!requestsRef.current.includes(request)) {
        return Promise.reject(new Error("User input request is no longer pending"));
      }
      const submission = (async () => {
        await respondToUserInputRequest(
          request.workspace_id,
          request.request_id,
          response.answers,
        );
        const item = buildUserInputConversationItem(request, response, t("userInput.secretAnswer"), t("userInput.title"));
        dispatch({
          type: "upsertItem",
          workspaceId: request.workspace_id,
          threadId: request.params.thread_id,
          item,
        });
        dispatch({
          type: "removeUserInputRequest",
          requestId: request.request_id,
          workspaceId: request.workspace_id,
        });
      })().finally(() => { inFlight.current.delete(request); });
      inFlight.current.set(request, submission);
      return submission;
    },
    [dispatch, t],
  );

  return { handleUserInputSubmit };
}
