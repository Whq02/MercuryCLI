import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export const ASK_USER_QUESTION_TOOL_NAME: Unbuilt = unbuilt('src/tools/AskUserQuestionTool/prompt.ts:2')

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH: Unbuilt = unbuilt('src/tools/AskUserQuestionTool/prompt.ts:4')

export const DISCUSS_OPTION_LABEL: Unbuilt = unbuilt('src/tools/AskUserQuestionTool/prompt.ts:6')

export const DESCRIPTION: Unbuilt =
  unbuilt('src/tools/AskUserQuestionTool/prompt.ts:8')

export const PREVIEW_FEATURE_PROMPT: Record<'markdown' | 'html', string> = unbuilt('src/tools/AskUserQuestionTool/prompt.ts:11')

export const ASK_USER_QUESTION_TOOL_PROMPT: Unbuilt = unbuilt('src/tools/AskUserQuestionTool/prompt.ts:16')
