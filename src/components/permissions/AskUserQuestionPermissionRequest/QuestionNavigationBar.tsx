import figures from 'figures'
import { GLYPH } from '../../../utils/glyphs.js'
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
  const submitText = ` ${GLYPH.check} Submit `
  const arrowsWidth = stringWidth(leftArrow) + stringWidth(rightArrow)
  const submitWidth = hideSubmitTab ? 0 : stringWidth(submitText)
  const availableForTabs = columns - arrowsWidth - submitWidth
  const labels = chipTexts(questions, currentQuestionIndex, availableForTabs)

  const showArrows = !(questions.length === 1 && hideSubmitTab)
  const isOnSubmit = currentQuestionIndex === questions.length

  return (
    <Box marginBottom={1}>
      {showArrows ? <Text dimColor={currentQuestionIndex === 0}>{leftArrow}</Text> : null}
      {questions.map((q, idx) => {
        const isSelected = idx === currentQuestionIndex
        const isAnswered = Boolean(answers[q.question])
        const icon = isAnswered ? figures.checkboxOn : figures.checkboxOff
        const label = labels[idx] || q.header || `Q${idx + 1}`
        return (
          <Text
            key={q.question}
            backgroundColor={isSelected ? 'permission' : undefined}
            color={isSelected ? 'inverseText' : undefined}
          >
            {` ${icon} ${label} `}
          </Text>
        )
      })}
      {!hideSubmitTab ? (
        <Text
          backgroundColor={isOnSubmit ? 'permission' : undefined}
          color={isOnSubmit ? 'inverseText' : undefined}
        >
          {submitText}
        </Text>
      ) : null}
      {showArrows ? <Text dimColor={isOnSubmit}>{rightArrow}</Text> : null}
    </Box>
  )
}
