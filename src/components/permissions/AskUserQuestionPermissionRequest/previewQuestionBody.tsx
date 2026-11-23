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
  question: Question
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  hideSubmitTab: boolean
  layout: ReturnType<typeof resolveInterviewLayout>
  minContentHeight: number | undefined
  optionRows: React.ReactNode
  previewBox: React.ReactNode
  notesRow: React.ReactNode
  isFooterFocused: boolean
  editorKey: string | null
  editorName: string | null
  onKeyDown: (e: KeyboardEvent) => void
  onRespondToModel?: () => void | Promise<void>
}

export function previewQuestionBody({
  question,
  questions,
  currentQuestionIndex,
  answers,
  hideSubmitTab,
  layout,
  minContentHeight,
  optionRows,
  previewBox,
  notesRow,
  isFooterFocused,
  editorKey,
  editorName,
  onKeyDown,
  onRespondToModel,
}: PreviewQuestionBodyArgs): React.ReactNode {
  const tabHint = questions.length > 1 ? ' · Tab to switch questions' : ''
  const editorHint =
    editorKey && editorName ? ` · ${editorKey} to edit in ${editorName}` : ''
  const helpLine = `Enter to select · ${figures.arrowUp}/${figures.arrowDown} to navigate · n to add notes${tabHint}${editorHint} · Esc to cancel`

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      tabIndex={0}
      autoFocus
      onKeyDown={onKeyDown}
    >
      <Divider color="inactive" />
      <Box flexDirection="column" paddingTop={0}>
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          hideSubmitTab={hideSubmitTab}
        />
        <PermissionRequestTitle title={question.question} color="text" />
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
              {layout.mode === 'stacked' ? <Box marginTop={1}>{previewBox}</Box> : null}
              {notesRow}
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            <Divider color="inactive" />
            <Box flexDirection="row" gap={1} onClick={onRespondToModel}>
              {isFooterFocused ? <Text color="suggestion">{figures.pointer}</Text> : <Text> </Text>}
              <Text color={isFooterFocused ? 'suggestion' : undefined}>{DISCUSS_OPTION_LABEL}</Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text color="inactive" dimColor>
              {helpLine}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
