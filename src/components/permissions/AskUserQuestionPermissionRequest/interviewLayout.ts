/**
 * The ONE interview layout decision owner (MERCURY INTERVIEW B2).
 *
 * Every geometry decision the interview workspace makes — side-by-side vs
 * stacked preview, panel widths, preview line budget — is derived HERE from
 * terminal cells and content shape. No raw column constant may silently push
 * an inner width negative or crop the control surface (the inherited
 * `LEFT_PANEL_WIDTH = 30` + `columns − 34` pair did exactly that below 35
 * columns). Width truth is DISPLAY CELLS via stringWidth, never `.length`.
 *
 * Modes:
 *   side-by-side — options left, preview right; both panes readable.
 *   stacked      — narrow: the preview sits under the focused option list.
 *   minimal      — very narrow/short: the active question + controls only,
 *                  preview available through explicit disclosure.
 */

import { stringWidth } from '../../../ink/stringWidth.js'
import type { InterviewQuestion } from '../../../services/interview/contracts.js'

export type InterviewLayoutMode = 'side-by-side' | 'stacked' | 'minimal'

export interface InterviewLayout {
  mode: InterviewLayoutMode
  /** Cells for the option list pane (side-by-side) or the full row (stacked). */
  optionPaneWidth: number
  /** Inner cells available to preview CONTENT (excludes the box frame). */
  previewContentWidth: number
  /** Preview content line budget (≥1 whenever a preview paints at all). */
  previewMaxLines: number
  /** Whether the notes row fits beside the preview (side-by-side only). */
  notesInline: boolean
  /** Cells for the notes input field. */
  notesInputWidth: number
}

/** The preview box frame: '│ ' + content + ' │' = 4 cells. */
export const PREVIEW_FRAME_CELLS = 4
/** The gap between panes in side-by-side mode. */
export const PANE_GAP = 2
/** Chrome rows inside the question region beside preview content (borders,
 *  notes, footer, help — measured from the shipped layout). */
export const PREVIEW_CHROME_ROWS = 11
/** Floors below which a pane stops being readable. */
const MIN_OPTION_PANE = 18
const MIN_PREVIEW_CONTENT = 24
const MIN_STACKED_WIDTH = 20
const MINIMAL_ROWS = 10

/** The widest option row in display cells: pointer + index + label (+ tick). */
export function measureOptionPane(question: InterviewQuestion): number {
  let widest = 0
  question.options.forEach((o, i) => {
    // '❯ 1. ' = 5 cells, ' ✓' = 2 cells reserve.
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

  // Stacked: the preview takes the full width under the options; its line
  // budget shares the height with the option rows.
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
