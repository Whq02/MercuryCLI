import figures from 'figures'
import React from 'react'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text } from '../../../ink.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { DISCUSS_OPTION_LABEL } from '../../../tools/AskUserQuestionTool/prompt.js'
import { Divider } from '../../design-system/Divider.js'
import { PermissionRequestTitle } from '../PermissionRequestTitle.js'
import type { resolveInterviewLayout } from './interviewLayout.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'

type PreviewQuestionBodyArgs = {
  handleKeyDown: (e: KeyboardEvent) => void
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  hideSubmitTab: boolean
  question: Question
  minContentHeight: number | undefined
  layout: ReturnType<typeof resolveInterviewLayout>
  optionRows: React.ReactNode[]
  previewBox: React.ReactNode
  notesRow: React.ReactNode
  onRespondToModel: () => void
  isFooterFocused: boolean
  isInNotesInput: boolean
  editorName: string | null
  editorKey: string | null
}

export function previewQuestionBody({ handleKeyDown, questions, currentQuestionIndex, answers, hideSubmitTab, question, minContentHeight, layout, optionRows, previewBox, notesRow, onRespondToModel, isFooterFocused, isInNotesInput, editorName, editorKey }: PreviewQuestionBodyArgs): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Divider color="inactive" />
      <Box flexDirection="column" paddingTop={0}>
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          hideSubmitTab={hideSubmitTab}
        />
        <PermissionRequestTitle title={question.question} color={'text'} />

        <Box flexDirection="column" minHeight={minContentHeight}>
          {layout.mode === 'side-by-side' ? (
            <Box marginTop={1} flexDirection="row" gap={2}>
              <Box flexDirection="column" width={layout.optionPaneWidth}>
                {optionRows}
              </Box>
              <Box flexDirection="column" flexGrow={1}>
                {previewBox}
                {notesRow}
              </Box>
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              <Box flexDirection="column">{optionRows}</Box>
              {layout.mode === 'stacked' && <Box marginTop={1}>{previewBox}</Box>}
              {notesRow}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Divider color="inactive" />
            <Box flexDirection="row" gap={1} onClick={onRespondToModel}>
              {isFooterFocused ? (
                <Text color="suggestion">{figures.pointer}</Text>
              ) : (
                <Text> </Text>
              )}
              <Text color={isFooterFocused ? 'suggestion' : undefined}>
                {DISCUSS_OPTION_LABEL}
              </Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text color="inactive" dimColor>
              Enter to select · {figures.arrowUp}/{figures.arrowDown} to navigate · n to add notes
              {questions.length > 1 && <> · Tab to switch questions</>}
              {isInNotesInput && editorName && editorKey && <> · {editorKey} to edit in {editorName}</>}{' '}
              · Esc to cancel
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
