/**
 * The interview navigation bar (MERCURY INTERVIEW Wave B, reimplemented at
 * the owner) — one chip per decision (answered state + header) plus the
 * Submit chip, budgeted to the terminal width in DISPLAY CELLS.
 *
 * Width policy: every chip at its ideal width when it fits; otherwise the
 * current chip keeps up to half the row and the others share the rest
 * (never below 6 cells each); below any usable width, only the current
 * chip's 3-cell abbreviation survives. Truncation is truncateToWidth —
 * cell-true, never String.length.
 */
import figures from 'figures'
import { GLYPH } from '../../mercury-ui/glyphs.js'
import React from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Box, Text } from '../../../ink.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { truncateToWidth } from '../../../utils/format.js'

type Props = {
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  hideSubmitTab?: boolean
}

/** Chip chrome: ' ☐ ' lead + ' ' tail around the label (4 cells). */
const CHIP_OVERHEAD = 4

function chipTexts(
  questions: Question[],
  currentQuestionIndex: number,
  availableForTabs: number,
): string[] {
  const headers = questions.map((q, i) => q?.header || `Q${i + 1}`)
  if (availableForTabs <= 0) {
    // No usable width: only the current chip's abbreviation survives.
    return headers.map((h, i) => (i === currentQuestionIndex ? h.slice(0, 3) : ''))
  }
  const idealTotal = headers.reduce((sum, h) => sum + CHIP_OVERHEAD + stringWidth(h), 0)
  if (idealTotal <= availableForTabs) return headers

  const currentHeader = headers[currentQuestionIndex] ?? ''
  const currentWidth = Math.min(CHIP_OVERHEAD + stringWidth(currentHeader), availableForTabs / 2)
  const others = Math.max(questions.length - 1, 1)
  const widthPerOther = Math.max(6, Math.floor((availableForTabs - currentWidth) / others))
  return headers.map((h, i) =>
    truncateToWidth(h, (i === currentQuestionIndex ? currentWidth : widthPerOther) - CHIP_OVERHEAD),
  )
}

export function QuestionNavigationBar({
  questions,
  currentQuestionIndex,
  answers,
  hideSubmitTab = false,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()

  const submitText = hideSubmitTab ? '' : ` ${GLYPH.check} Submit `
  const fixedWidth = stringWidth('← ') + stringWidth(' →') + stringWidth(submitText)
  const texts = chipTexts(questions, currentQuestionIndex, columns - fixedWidth)
  const hideArrows = questions.length === 1 && hideSubmitTab
  const onSubmitTab = currentQuestionIndex === questions.length

  return (
    <Box flexDirection="row" marginBottom={1}>
      {!hideArrows && <Text color={currentQuestionIndex === 0 ? 'inactive' : undefined}>← </Text>}
      {questions.map((q, i) => {
        const isSelected = i === currentQuestionIndex
        const checkbox = q?.question && answers[q.question] ? figures.checkboxOn : figures.checkboxOff
        const label = ` ${checkbox} ${texts[i] || q?.header || `Q${i + 1}`} `
        return (
          <Box key={q?.question || `question-${i}`}>
            {isSelected ? (
              <Text backgroundColor="permission" color="inverseText">
                {label}
              </Text>
            ) : (
              <Text>{label}</Text>
            )}
          </Box>
        )
      })}
      {!hideSubmitTab && (
        <Box key="submit">
          {onSubmitTab ? (
            <Text backgroundColor="permission" color="inverseText">
              {` ${GLYPH.check} Submit `}
            </Text>
          ) : (
            <Text>{` ${GLYPH.check} Submit `}</Text>
          )}
        </Box>
      )}
      {!hideArrows && <Text color={onSubmitTab ? 'inactive' : undefined}> →</Text>}
    </Box>
  )
}
