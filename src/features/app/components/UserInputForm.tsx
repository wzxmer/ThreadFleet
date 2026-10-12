import { useId, useSyncExternalStore } from "react";
import type { RequestUserInputQuestion, RequestUserInputResponse } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import { PanelHeader } from "@/features/design-system/components/panel/PanelPrimitives";

type Draft = {
  selections: Record<string, number | undefined>;
  notes: Record<string, string>;
  submitting: boolean;
  failed: boolean;
  submitted: boolean;
};

// Keep live request/message drafts across navigation. Neither RPC IDs nor
// secret answers survive an app restart; unreachable requests release drafts.
const drafts = new WeakMap<object, { snapshot: Draft; listeners: Set<() => void> }>();
function getDraft(key: object) {
  let store = drafts.get(key);
  if (!store) {
    store = {
      snapshot: { selections: {}, notes: {}, submitting: false, failed: false, submitted: false },
      listeners: new Set(),
    };
    drafts.set(key, store);
  }
  return store;
}

type UserInputFormProps = {
  draftKey: object;
  questions: RequestUserInputQuestion[];
  title: string;
  description?: string;
  queueLabel?: string;
  onSubmit: (response: RequestUserInputResponse) => Promise<void> | void;
  onClose?: () => void;
};

export function UserInputForm({ draftKey, questions, title, description, queueLabel, onSubmit, onClose }: UserInputFormProps) {
  const { t } = useI18n();
  const formId = useId();
  const store = getDraft(draftKey);
  const draft = useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => { store.listeners.delete(listener); };
    },
    () => store.snapshot,
  );
  const update = (patch: Partial<Draft>) => {
    store.snapshot = { ...store.snapshot, ...patch };
    store.listeners.forEach((listener) => listener());
  };
  const answers: RequestUserInputResponse["answers"] = {};
  for (const question of questions) {
    const selected = question.options?.[draft.selections[question.id] ?? -1];
    const values = selected ? [selected.label || selected.description] : [];
    const note = (draft.notes[question.id] ?? "").trim();
    if (note) values.push(selected ? `user_note: ${note}` : note);
    answers[question.id] = { answers: values };
  }
  const complete = questions.length > 0 && questions.every(
    (question) => Boolean(question.id && answers[question.id]?.answers.length),
  );
  const submit = async () => {
    if (!complete || store.snapshot.submitting || store.snapshot.submitted) return;
    update({ submitting: true, failed: false });
    try {
      await onSubmit({ answers });
      update({ submitting: false, submitted: true, selections: {}, notes: {} });
    } catch {
      update({ submitting: false, failed: true });
    }
  };

  return (
    <form className="request-user-input-card" aria-label={title} aria-busy={draft.submitting}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <PanelHeader className="request-user-input-header">
        <span className="request-user-input-title">{title}</span>
        {queueLabel ? <span className="request-user-input-queue">{queueLabel}</span> : null}
      </PanelHeader>
      {description ? <p className="request-user-input-description">{description}</p> : null}
      <div className="request-user-input-body">
        {questions.map((question, index) => {
          const fieldId = `${formId}-${index}`;
          const hasOptions = Boolean(question.options?.length);
          const changeNote = (value: string) => update({ notes: { ...draft.notes, [question.id]: value } });
          return (
            <fieldset key={question.id} className="request-user-input-question" disabled={draft.submitting || draft.submitted}>
              <legend className="request-user-input-question-text">{question.question}</legend>
              {question.header ? <span className="request-user-input-question-header">{question.header}</span> : null}
              {hasOptions ? (
                <div className="request-user-input-options">
                  {question.options?.map((option, optionIndex) => (
                    <label key={optionIndex} className={`request-user-input-option${draft.selections[question.id] === optionIndex ? " is-selected" : ""}`}>
                      <input type="radio" name={`${formId}-${question.id}`}
                        aria-label={option.label || option.description}
                        aria-describedby={option.description ? `${fieldId}-option-${optionIndex}` : undefined}
                        checked={draft.selections[question.id] === optionIndex}
                        onChange={() => update({ selections: { ...draft.selections, [question.id]: optionIndex } })} />
                      <span className="request-user-input-option-content">
                        <span className="request-user-input-option-label">{option.label}</span>
                        {option.description ? <span id={`${fieldId}-option-${optionIndex}`} className="request-user-input-option-description">{option.description}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
              <label className="request-user-input-answer-label" htmlFor={fieldId}>{t(hasOptions ? "userInput.notes" : "userInput.answer")}</label>
              {question.isSecret ? (
                <input id={fieldId} type="password" autoComplete="off" className="request-user-input-notes"
                  value={draft.notes[question.id] ?? ""} onChange={(event) => changeNote(event.target.value)} />
              ) : (
                <textarea id={fieldId} className="request-user-input-notes" rows={2}
                  placeholder={t(hasOptions ? "userInput.notesPlaceholder" : "userInput.answerPlaceholder")}
                  value={draft.notes[question.id] ?? ""} onChange={(event) => changeNote(event.target.value)} />
              )}
              {hasOptions && draft.selections[question.id] !== undefined ? (
                <button type="button" className="ghost" data-button-elevation="none"
                  onClick={() => update({ selections: { ...draft.selections, [question.id]: undefined } })}>{t("userInput.clearSelection")}</button>
              ) : null}
            </fieldset>
          );
        })}
        {!questions.length ? <p>{t("userInput.empty")}</p> : null}
      </div>
      {draft.failed ? <p role="alert" className="request-user-input-error">{t("userInput.failed")}</p> : null}
      {draft.submitted ? <p role="status">{t("userInput.submitted")}</p> : null}
      <div className="request-user-input-actions">
        {onClose ? <button type="button" className="ghost" data-button-elevation="none" onClick={onClose}>{t("userInput.collapse")}</button> : null}
        <button type="submit" className="primary" data-button-elevation="none" disabled={!complete || draft.submitting || draft.submitted}>
          {t(draft.submitting ? "userInput.submitting" : draft.failed ? "userInput.retry" : "userInput.submit")}
        </button>
      </div>
    </form>
  );
}
