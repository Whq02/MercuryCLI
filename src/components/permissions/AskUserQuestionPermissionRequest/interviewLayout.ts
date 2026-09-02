
import { stringWidth } from '../../../ink/stringWidth.js'
import type { InterviewQuestion } from '../../../services/interview/contracts.js'

export type InterviewLayoutMode = 'side-by-side' | 'stacked' | 'minimal'

export interface InterviewLayout {
  mode: InterviewLayoutMode
  optionPaneWidth: number
  previewContentWidth: number
  previewMaxLines: number
  notesInline: boolean
  notesInputWidth: number
}

export const PREVIEW_FRAME_CELLS = 4
export const PANE_GAP = 2
export const PREVIEW_CHROME_ROWS = 11
const MIN_OPTION_PANE = 18
const MIN_PREVIEW_CONTENT = 24
const MIN_STACKED_WIDTH = 20
const MINIMAL_ROWS = 10

export function measureOptionPane(question: InterviewQuestion): number {
  let widest = 0
  question.options.forEach((o, i) => {
    widest = Math.max(widest, 5 + stringWidth(`${i + 1}. `) - 3 + stringWidth(o.label) + 2)
  })
  return Math.max(MIN_OPTION_PANE, Math.min(widest, 40))
}

export function resolveInterviewLayout(input: {
  columns: number
  rows: number
  question: InterviewQuestion
}): InterviewLayout {
  const { columns, rows, question } = input
  const optionPane = measureOptionPane(question)
  const hasPreview = question.options.some(o => o.preview)

  const sideBySidePreview = columns - optionPane - PANE_GAP - PREVIEW_FRAME_CELLS
  const heightBudget = Math.max(1, rows - PREVIEW_CHROME_ROWS)

  if (rows <= MINIMAL_ROWS || columns < MIN_STACKED_WIDTH + PREVIEW_FRAME_CELLS) {
    return {
      mode: 'minimal',
      optionPaneWidth: Math.max(1, columns - 2),
      previewContentWidth: Math.max(1, columns - PREVIEW_FRAME_CELLS),
      previewMaxLines: 1,
      notesInline: false,
      notesInputWidth: Math.max(8, columns - 10),
    }
  }

  if (hasPreview && sideBySidePreview >= MIN_PREVIEW_CONTENT) {
    return {
      mode: 'side-by-side',
      optionPaneWidth: optionPane,
      previewContentWidth: sideBySidePreview,
      previewMaxLines: heightBudget,
      notesInline: true,
      notesInputWidth: Math.max(8, Math.min(60, sideBySidePreview - 8)),
    }
  }

  const stackedLines = Math.max(1, heightBudget - question.options.length)
  return {
    mode: 'stacked',
    optionPaneWidth: Math.max(1, columns - 2),
    previewContentWidth: Math.max(MIN_STACKED_WIDTH - PREVIEW_FRAME_CELLS, columns - PREVIEW_FRAME_CELLS),
    previewMaxLines: stackedLines,
    notesInline: false,
    notesInputWidth: Math.max(8, Math.min(60, columns - 12)),
  }
}
