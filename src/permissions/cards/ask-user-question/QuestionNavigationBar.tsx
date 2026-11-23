import figures from 'figures'
import { GLYPH } from '../../../screen/theme/glyphs.js'
import React from 'react'
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js'
import { stringWidth } from '../../../screen/renderer/stringWidth.js'
import { Box, Text } from '../../../screen/themedRenderer.js'
import type { Question } from '../../../tools/ask-question/AskUserQuestionTool.js'
import { truncateToWidth } from '../../../platform/text/format.js'

type Props = {
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  hideSubmitTab?: boolean
}

const CHIP_OVERHEAD = 4

function chipTexts(
  questions: Question[],
  currentQuestionIndex: number,
  availableForTabs: number,
): string[] {
  const headers = questions.map((q, i) => q?.header || `Q${i + 1}`)
  if (availableForTabs <= 0) {
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
  const leftArrow = `${figures.arrowLeft} `
  const rightArrow = ` ${figures.arrowRight}`
  const submitText = hideSubmitTab ? '' : ` ${GLYPH.check} Submit `
  const availableForTabs = columns - stringWidth(leftArrow) - stringWidth(rightArrow) - stringWidth(submitText)
  const labels = chipTexts(questions, currentQuestionIndex, availableForTabs)

  const hideArrows = questions.length === 1 && hideSubmitTab
  const isOnSubmit = currentQuestionIndex === questions.length

  return (
    <Box flexDirection="row" marginBottom={1}>
      {hideArrows ? null : (
        <Text color={currentQuestionIndex === 0 ? 'inactive' : undefined}>{leftArrow}</Text>
      )}
      {questions.map((q, idx) => {
        const icon = q.question && answers[q.question] ? figures.checkboxOn : figures.checkboxOff
        const label = ` ${icon} ${labels[idx] || q.header || `Q${idx + 1}`} `
        return (
          <Box key={q.question || `question-${idx}`}>
            {idx === currentQuestionIndex ? (
              <Text backgroundColor="permission" color="inverseText">
                {label}
              </Text>
            ) : (
              <Text>{label}</Text>
            )}
          </Box>
        )
      })}
      {hideSubmitTab ? null : (
        <Box>
          {isOnSubmit ? (
            <Text backgroundColor="permission" color="inverseText">
              {submitText}
            </Text>
          ) : (
            <Text>{submitText}</Text>
          )}
        </Box>
      )}
      {hideArrows ? null : <Text color={isOnSubmit ? 'inactive' : undefined}>{rightArrow}</Text>}
    </Box>
  )
}
