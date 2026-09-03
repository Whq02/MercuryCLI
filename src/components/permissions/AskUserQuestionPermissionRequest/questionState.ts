
import type {
  InterviewAnswerValue,
  InterviewQuestionState,
} from '../../../services/interview/contracts.js'

export type QuestionState = {
  selectedValue?: string | string[]
  textInputValue: string
}

export const OTHER_OPTION_VALUE = '__other__'

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
