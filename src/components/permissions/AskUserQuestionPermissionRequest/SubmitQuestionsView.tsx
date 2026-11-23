import figures from 'figures'
import React from 'react'
import { GLYPH } from '../../../utils/glyphs.js'
import { Box, Text } from '../../../ink.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import { Select } from '../../CustomSelect/index.js'
import { Divider } from '../../design-system/Divider.js'
import { PermissionRequestTitle } from '../PermissionRequestTitle.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'

const SUBMIT_VALUE = '__submit__'
const CANCEL_VALUE = '__cancel__'

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
}: Props): React.ReactNode {
  const options = [
    ...questions.map(q => {
      const answer = answers[q.question]
      const note = notes?.[q.question]
      const glyph = answer ? GLYPH.check : GLYPH.warn
      const answerText = answer || '(unanswered — select to answer)'
      const noteSuffix = note ? ` · notes: ${note}` : ''
      return {
        label: `${glyph} ${q.header || q.question}`,
        value: q.question,
        description: `${figures.arrowRight} ${answerText}${noteSuffix}`,
      }
    }),
    {
      label: 'Submit answers',
      value: SUBMIT_VALUE,
    },
    {
      label: 'Cancel',
      value: CANCEL_VALUE,
    },
  ]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider color="inactive" />
      <Box flexDirection="column" borderTop borderColor="inactive" paddingTop={0}>
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
        />
        <PermissionRequestTitle title="Review your answers" color="text" />
        <Box flexDirection="column" marginTop={1} minHeight={minContentHeight}>
          {!allQuestionsAnswered ? (
            <Box marginBottom={1}>
              <Text color="warning">
                {GLYPH.warn} Not every question is answered — select one to answer it, or{' '}
                submit deliberately
              </Text>
            </Box>
          ) : null}
          <PermissionRuleExplanation permissionResult={permissionResult} />
          <Text color="inactive">Select a decision to revise it, or submit:</Text>
          <Box marginTop={1}>
            <Select
              options={options}
              defaultFocusValue={initialFocusValue}
              scrollMovesFocus={false}
              onChange={value => {
                if (value === SUBMIT_VALUE) {
                  onFinalResponse('submit')
                } else if (value === CANCEL_VALUE) {
                  onFinalResponse('cancel')
                } else {
                  onEditQuestion?.(value)
                }
              }}
              onCancel={() => onFinalResponse('cancel')}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
