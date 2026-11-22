import figures from 'figures'
import { GLYPH } from '../../../utils/glyphs.js'
import React from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Box, Text } from '../../../ink.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { truncateToWidth } from '../../../utils/format.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type Props = Unbuilt

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

export function QuestionNavigationBar(arg0: Props): React.ReactNode {
  return notBuilt('src/components/permissions/AskUserQuestionPermissionRequest/QuestionNavigationBar.tsx:40')
}
