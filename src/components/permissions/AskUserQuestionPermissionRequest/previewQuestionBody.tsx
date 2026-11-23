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
  const showTabHint = questions.length > 1 || !hideSubmitTab
  const tabHint = showTabHint ? ' · Tab to switch questions' : ''
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
            <Box gap={2} marginTop={1}>
              <Box width={layout.optionPaneWidth} flexShrink={0} flexDirection="column">
                {optionRows}
              </Box>
              <Box flexDirection="column" flexGrow={1}>
                {previewBox}
                {notesRow}
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {optionRows}
              {layout.mode === 'stacked' ? (
                <Box marginTop={1}>{previewBox}</Box>
              ) : null}
              {notesRow}
            </Box>
          )}
          <Box
            marginTop={1}
            onClick={() => {
              void onRespondToModel?.()
            }}
          >
            <Text color={isFooterFocused ? 'suggestion' : undefined} bold={isFooterFocused}>
              {isFooterFocused ? `${figures.pointer} ` : '  '}
              {DISCUSS_OPTION_LABEL}
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{helpLine}</Text>
        </Box>
      </Box>
    </Box>
  )
}
