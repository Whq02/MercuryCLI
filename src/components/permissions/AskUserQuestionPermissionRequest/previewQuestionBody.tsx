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
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type PreviewQuestionBodyArgs = Unbuilt

export function previewQuestionBody(arg0: PreviewQuestionBodyArgs): React.ReactNode {
  return notBuilt('src/components/permissions/AskUserQuestionPermissionRequest/previewQuestionBody.tsx:31')
}
