import { useId } from "react";
import Paperclip from "lucide-react/dist/esm/icons/paperclip";
import type { RequestUserInputQuestion, RequestUserInputResponse } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import { PanelHeader } from "@/features/design-system/components/panel/PanelPrimitives";
import { ComposerAttachments } from "@/features/composer/components/ComposerAttachments";
import { useComposerImageDrop } from "@/features/composer/hooks/useComposerImageDrop";
import { useUserInputDraft } from "@app/hooks/useUserInputDraft";

type UserInputFormProps = {
  draftKey: object;
  questions: RequestUserInputQuestion[];
  title: string;
  description?: string;
  queueLabel?: string;
  attachmentsEnabled?: boolean;
  onSubmit: (response: RequestUserInputResponse, attachments?: string[]) => Promise<void> | void;
  onClose?: () => void;
};

export function UserInputForm({ draftKey, questions, title, description, queueLabel, attachmentsEnabled = false, onSubmit, onClose }: UserInputFormProps) {
  const { t } = useI18n();
  const formId = useId();
  const { draft, store, update, attach, readAttachments, pickAttachments, removeAttachment } = useUserInputDraft(draftKey);
  const disabled = draft.submitting || draft.submitted;
  const drop = useComposerImageDrop({ disabled: !attachmentsEnabled || disabled, onAttachImages: attach });
  const answers: RequestUserInputResponse["answers"] = {};
  for (const question of questions) {
    const selected = question.options?.[draft.selections[question.id] ?? -1];
    const values = selected ? [selected.label || selected.description] : [];
    const note = (draft.notes[question.id] ?? "").trim();
    if (note) values.push(selected ? `user_note: ${note}` : note);
    answers[question.id] = { answers: values };
  }
  const complete = questions.length > 0 && questions.every(
    (question) => Boolean(question.id && (answers[question.id]?.answers.length ||
      (attachmentsEnabled && questions.length === 1 && draft.attachments.length))),
  );
  const submit = async () => {
    if (!complete || store.snapshot.submitting || store.snapshot.submitted || store.snapshot.pendingAttachments) return;
    update({ submitting: true, failed: false });
    try {
      if (attachmentsEnabled) await onSubmit({ answers }, [...store.snapshot.attachments]);
      else await onSubmit({ answers });
      update({ submitting: false, submitted: true, selections: {}, notes: {}, attachments: [] });
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
      <div className={`request-user-input-body${drop.isDragOver ? " is-drag-over" : ""}`}
        ref={drop.dropTargetRef} onDragOver={drop.handleDragOver} onDragEnter={drop.handleDragEnter}
        onDragLeave={drop.handleDragLeave} onDrop={(event) => { if (attachmentsEnabled) void readAttachments(() => drop.handleDrop(event)); }}>
        {questions.map((question, index) => {
          const fieldId = `${formId}-${index}`;
          const hasOptions = Boolean(question.options?.length);
          const changeNote = (value: string) => update({ notes: { ...draft.notes, [question.id]: value } });
          return (
            <fieldset key={question.id} className="request-user-input-question" disabled={draft.submitting || draft.submitted}>
              <legend className="request-user-input-question-text">{question.question}</legend>
              <div className="request-user-input-question-body">
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
                    onPaste={(event) => { if (attachmentsEnabled) void readAttachments(() => drop.handlePaste(event)); }}
                    placeholder={t(hasOptions ? "userInput.notesPlaceholder" : "userInput.answerPlaceholder")}
                    value={draft.notes[question.id] ?? ""} onChange={(event) => changeNote(event.target.value)} />
                )}
                {hasOptions && draft.selections[question.id] !== undefined ? (
                  <button type="button" className="ghost" data-button-elevation="none"
                    onClick={() => update({ selections: { ...draft.selections, [question.id]: undefined } })}>{t("userInput.clearSelection")}</button>
                ) : null}
              </div>
            </fieldset>
          );
        })}
        {!questions.length ? <p>{t("userInput.empty")}</p> : null}
        {attachmentsEnabled ? (
          <>
            <button type="button" className="ghost request-user-input-attach" data-button-elevation="none"
              disabled={disabled || Boolean(draft.pendingAttachments)} onClick={() => { void pickAttachments(); }}>
              <Paperclip size={14} aria-hidden />{t("composer.addAttachment")}
            </button>
            <ComposerAttachments attachments={draft.attachments} disabled={disabled} onRemoveAttachment={removeAttachment} />
          </>
        ) : null}
      </div>
      {draft.attachmentFailed ? <p role="alert" className="request-user-input-error">{t("userInput.attachmentFailed")}</p> : null}
      {draft.failed ? <p role="alert" className="request-user-input-error">{t("userInput.failed")}</p> : null}
      {draft.submitted ? <p role="status">{t("userInput.submitted")}</p> : null}
      <div className="request-user-input-actions">
        {onClose ? <button type="button" className="ghost" data-button-elevation="none" onClick={onClose}>{t("userInput.collapse")}</button> : null}
        <button type="submit" className="primary" data-button-elevation="none" disabled={!complete || disabled || Boolean(draft.pendingAttachments)}>
          {t(draft.submitting ? "userInput.submitting" : draft.failed ? "userInput.retry" : "userInput.submit")}
        </button>
      </div>
    </form>
  );
}
