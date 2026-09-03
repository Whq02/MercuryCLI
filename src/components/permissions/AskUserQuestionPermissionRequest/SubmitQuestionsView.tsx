import figures from 'figures'
import { GLYPH } from '../../mercury-ui/glyphs.js'
import React from 'react'
import { Box, Text } from '../../../ink.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import { Select } from '../../CustomSelect/index.js'
import { Divider } from '../../design-system/Divider.js'
import { PermissionRequestTitle } from '../PermissionRequestTitle.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'

type Props = {
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  notes?: Record<string, string>
  allQuestionsAnswered: boolean
  permissionResult: PermissionDecision
  minContentHeight?: number
  onEditQuestion?: (questionText: string) => void
  initialFocusValue?: string
  onFinalResponse: (value: 'submit' | 'cancel') => void
}

export function SubmitQuestionsView({
  questions,
  currentQuestionIndex,
  answers,
  notes,
  allQuestionsAnswered,
  permissionResult,
  minContentHeight,
  onEditQuestion,
  initialFocusValue,
  onFinalResponse,
}: Props) {
  const decisionRows = questions
    .filter(q => q?.question)
    .map(q => {
      const answer = answers[q.question]
      const note = notes?.[q.question]
      const state = answer ? GLYPH.check : GLYPH.warn
      const shown = answer ?? '(unanswered — select to answer)'
      return {
        type: 'text' as const,
        value: q.question,
        label: `${state} ${q.header || q.question}`,
        description: `${figures.arrowRight} ${shown}${note ? ` · notes: ${note}` : ''}`,
      }
    })

  const actionRows = [
    { type: 'text' as const, value: '__submit__', label: 'Submit answers' },
    { type: 'text' as const, value: '__cancel__', label: 'Cancel' },
  ]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider color="inactive" />
      <Box flexDirection="column" borderTop={true} borderColor="inactive" paddingTop={0}>
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
        />
        <PermissionRequestTitle title="Review your answers" color="text" />
        <Box flexDirection="column" marginTop={1} minHeight={minContentHeight}>
          {!allQuestionsAnswered && (
            <Box marginBottom={1}>
              <Text color="warning">
                {GLYPH.warn} Not every question is answered — select one to answer it, or
                submit deliberately
              </Text>
            </Box>
          )}
          <PermissionRuleExplanation permissionResult={permissionResult} toolType="tool" />
          <Text color="inactive">Select a decision to revise it, or submit:</Text>
          <Box marginTop={1}>
            <Select
              options={[...decisionRows, ...actionRows]}
              defaultFocusValue={initialFocusValue}
              onChange={(value: string) => {
                if (value === '__submit__') onFinalResponse('submit')
                else if (value === '__cancel__') onFinalResponse('cancel')
                else onEditQuestion?.(value)
              }}
              onCancel={() => onFinalResponse('cancel')}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
