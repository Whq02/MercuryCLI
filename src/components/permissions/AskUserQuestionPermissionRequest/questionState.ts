/**
 * The child views' projection vocabulary (MERCURY INTERVIEW Wave B).
 *
 * Durable interview meaning lives in the ONE session authority
 * (src/services/interview/store.ts); the request component projects it into
 * this per-question display shape for the views through projectQuestionState
 * — the one place the views' selection and text derive from the folded
 * state. The historical useMultipleChoiceState reducer that once OWNED this
 * state is retired — the type is the only survivor.
 */

import type {
  InterviewAnswerValue,
  InterviewQuestionState,
} from '../../../services/interview/contracts.js'

export type QuestionState = {
  selectedValue?: string | string[]
  textInputValue: string
}

/** The free-text "Other" row's value in the select lists — the card's own
 *  spelling, never an authored label; it is filtered out before anything
 *  reaches the session authority (option identity never carries it). */
export const OTHER_OPTION_VALUE = '__other__'

/**
 * Project one question's folded state into the views' display shape.
 *
 * The TEXT is the newest typed text: a draft's free text first (typing
 * drafts on every keystroke and outlives navigation, a re-render and a
 * remount), the committed answer's otherwise. The SELECTION is what the
 * operator has chosen: for a single-select the committed answer (its option,
 * or the Other row when the answer is free text); for a multi-select the
 * chosen options plus the Other row exactly when text is typed — the row's
 * membership IS its text, so the checkbox can never disagree with the field.
 * A preview question's text is its note.
 */
export function projectQuestionState(qs: InterviewQuestionState): QuestionState {
  const q = qs.question
  const answer = qs.committed ?? qs.draft
  const text = qs.note ?? qs.draft?.freeText ?? qs.committed?.freeText ?? ''
  const labels = (answer?.optionIds ?? [])
    .map(id => q.options.find(o => o.id === id)?.label)
    .filter((l): l is string => typeof l === 'string')
  if (q.multiSelect) {
    return {
      selectedValue: text.trim() ? [...labels, OTHER_OPTION_VALUE] : labels,
      textInputValue: text,
    }
  }
  const committed = qs.committed
  const committedLabels = committed
    ? committed.optionIds
        .map(id => q.options.find(o => o.id === id)?.label)
        .filter((l): l is string => typeof l === 'string')
    : []
  const selectedValue = committed
    ? (committedLabels[0] ?? (committed.freeText?.trim() ? OTHER_OPTION_VALUE : undefined))
    : undefined
  return { selectedValue, textInputValue: text }
}

/**
 * One answer as the card commits it. `labels` are the view's labels (the
 * Other row rides as OTHER_OPTION_VALUE); `typed` is the Other field's text
 * as it stands; `hasImage` says an image is attached to the decision.
 *
 * The COMMIT carries the chosen options and, when the Other row is in the
 * answer, its text. A single-select answered by a ROW while text is typed
 * under Other also returns the draft that KEEPS that text uncommitted — the
 * lost-input law: choosing A–D never discards what was typed under E; the
 * highlight back on E shows it again to pick or edit; only emptying the
 * field drops it, and a submit carries the committed row, never the draft
 * (the authority answers from the committed value). A multi-select's text
 * rides with its Other row and needs no keeping.
 */
export function composeAnswer(input: {
  question: { multiSelect: boolean; options: ReadonlyArray<{ id: string; label: string }> }
  labels: readonly string[]
  typed: string
  hasImage: boolean
}): { commit: InterviewAnswerValue; keptDraft?: InterviewAnswerValue } {
  const { question, labels, typed, hasImage } = input
  const optionIds = labels
    .filter(l => l !== OTHER_OPTION_VALUE)
    .map(l => question.options.find(o => o.label === l)?.id)
    .filter((id): id is string => typeof id === 'string')
  const other = labels.includes(OTHER_OPTION_VALUE)
  const text = typed.trim()
  const freeText = other
    ? text
      ? hasImage
        ? `${text} (Image attached)`
        : text
      : hasImage
        ? '(Image attached)'
        : undefined
    : undefined
  const commit: InterviewAnswerValue = { optionIds, ...(freeText ? { freeText } : {}) }
  const keptDraft =
    !question.multiSelect && !other && text ? { optionIds, freeText: text } : undefined
  return { commit, ...(keptDraft ? { keptDraft } : {}) }
}
