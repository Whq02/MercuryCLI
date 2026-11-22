import * as React from 'react'
import { z } from 'zod'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { getQuestionPreviewFormat } from '../../bootstrap/state.js'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { useAppState } from '../../state/AppState.js'
import {
  getModeColor,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import type { Theme } from '../../utils/theme.js'
import { buildTool } from '../../Tool.js'
import { REJECT_MESSAGE, REJECT_MESSAGE_WITH_REASON_PREFIX, SUBAGENT_REJECT_MESSAGE, SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX, unwrapToolUseError } from '../../utils/messages/rejectionText.js'
import {
  ASK_USER_QUESTION_TOOL_CHIP_WIDTH,
  ASK_USER_QUESTION_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_PROMPT,
  DESCRIPTION,
  DISCUSS_OPTION_LABEL,
  PREVIEW_FEATURE_PROMPT,
} from './prompt.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const RESULT_SIZE_CAP = 100_000

const questionSchema: Unbuilt = unbuilt('src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:47')

const annotationsSchema = z
  .record(
    z.string(),
    z.object({
      preview: z.string().optional(),
      notes: z.string().optional(),
    }),
  )
  .optional()

const outcomeSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('answers-submitted'),
      decisionRecordId: z.string().optional(),
    }),
    z.object({
      kind: z.literal('discussion-requested'),
      questionId: z.string(),
    }),
    z.object({
      kind: z.literal('cancelled'),
      preserveDraft: semanticBoolean(z.boolean().default(false)),
    }),
  ])
  .optional()

const inputSchemaObject: Unbuilt = unbuilt('src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:96')

const modelInputSchemaObject = z.strictObject({ questions: inputSchemaObject.shape.questions })

const outputSchemaObject = z.object({
  questions: z.array(questionSchema),
  answers: z.record(z.string(), z.string()).default({}),
  annotations: annotationsSchema,
  outcome: outcomeSchema,
})

export type Question = z.infer<typeof questionSchema>
type Input = z.infer<typeof inputSchemaObject>
type Output = z.infer<typeof outputSchemaObject>


function lookupFor<T>(
  record: Record<string, T> | undefined,
  question: Question,
): T | undefined {
  if (!record) return undefined
  if (question.id !== undefined && question.id in record) {
    return record[question.id]
  }
  return record[question.question]
}

function answersSoFarBlock(output: Output): string {
  const entries = Object.entries(output.answers ?? {})
  if (entries.length === 0) return ''
  const lines = entries.map(
    ([key, value]) => `- ${JSON.stringify(key)} -> ${JSON.stringify(value)}`,
  )
  return `\nAnswers so far:\n${lines.join('\n')}`
}

function typedOutcomeText(output: Output): string | null {
  const outcome = output.outcome
  if (!outcome) return null
  switch (outcome.kind) {
    case 'discussion-requested': {
      const question = output.questions.find(
        q => q.id === outcome.questionId || q.question === outcome.questionId,
      )
      const label = question?.question ?? outcome.questionId
      return (
        `The user wants to DISCUSS the question ${JSON.stringify(label)} before answering. ` +
        'Talk it through with them; the interview session and its drafts are preserved and will resume at this question.' +
        answersSoFarBlock(output)
      )
    }
    case 'cancelled':
      return (
        `The user cancelled the interview${outcome.preserveDraft ? ' (drafts preserved for resume)' : ''}. Do not re-ask these questions now.` +
        answersSoFarBlock(output)
      )
    case 'answers-submitted':
      return null
  }
}


export const AskUserQuestionTool: Unbuilt = unbuilt('src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:200')

function AnsweredQuestionsCard({
  entries,
}: {
  entries: Array<[string, string]>
}): React.ReactElement {
  const mode = useAppState(state => state.toolPermissionContext.mode)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={getModeColor(mode as PermissionMode) as keyof Theme}>
          ●
        </Text>{' '}
        User answered Mercury&apos;s questions:
      </Text>
      <MessageResponse>
        <Box flexDirection="column">
          {entries.map(([question, answer]) => (
            <Text key={question} color={'inactive' as keyof Theme}>
              · {question} → {answer}
            </Text>
          ))}
        </Box>
      </MessageResponse>
    </Box>
  )
}
