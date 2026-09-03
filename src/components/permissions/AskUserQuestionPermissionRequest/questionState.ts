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

import type { InterviewQuestionState } from '../../../services/interview/contracts.js'

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
