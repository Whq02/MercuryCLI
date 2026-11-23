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

const RESULT_SIZE_CAP = 100_000

const optionSchema = z.object({
  id: z.string().optional().describe('Answer id (default positional)'),
  label: z.string().describe('1-5 word label'),
  description: z.string().describe('Option meaning/implication'),
  preview: z.string().optional().describe('Focused preview (host-format dependent)'),
})

const questionSchema = z.object({
  id: z.string().optional().describe('Question id in answer (default positional)'),
  decisionId: z
    .string()
    .optional()
    .describe('Interview record key (mercury://interview/<session>/<decisionId>)'),
  question: z.string().describe('Question text; phrase for multi-select when applicable'),
  header: z
    .string()
    .max(ASK_USER_QUESTION_TOOL_CHIP_WIDTH)
    .describe(`Chip label (≤${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} chars)`),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe('Exclusive unless multiSelect; Other free-text answer is supplied automatically'),
  multiSelect: semanticBoolean(z.boolean().default(false)).describe('Allow several answers'),
})

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

const inputSchemaObject = z
  .strictObject({
    questions: z.array(questionSchema).min(1).max(4),
    answers: z.record(z.string(), z.string()).optional(),
    annotations: annotationsSchema,
    outcome: outcomeSchema,
    metadata: z
      .object({
        source: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    data => {
      const seenQuestions = new Set<string>()
      for (const q of data.questions) {
        if (seenQuestions.has(q.question)) return false
        seenQuestions.add(q.question)
        const seenLabels = new Set<string>()
        for (const opt of q.options) {
          if (seenLabels.has(opt.label)) return false
          seenLabels.add(opt.label)
        }
      }
      return true
    },
    {
      message:
        'Question texts must be unique across the call, and option labels must be unique within each question.',
    },
  )

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


const FULL_HTML_DOC_RE = /<\s*(?:html|body)[\s>]|<!doctype/i
const SCRIPT_OR_STYLE_RE = /<\s*(?:script|style)[\s>]/i
const HTML_ELEMENT_RE = /<[a-zA-Z][^>]*>/

function isDeclineErrorText(error: unknown): boolean {
  if (typeof error !== 'string') return false
  const unwrapped = unwrapToolUseError(error)
  return (
    unwrapped.startsWith(REJECT_MESSAGE) ||
    unwrapped.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    unwrapped.startsWith(SUBAGENT_REJECT_MESSAGE) ||
    unwrapped.startsWith(SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX)
  )
}

export const AskUserQuestionTool = buildTool({
  name: ASK_USER_QUESTION_TOOL_NAME,
  inputSchema: inputSchemaObject,
  inputJSONSchema: zodToJsonSchema(modelInputSchemaObject),
  outputSchema: outputSchemaObject,
  maxResultSizeChars: RESULT_SIZE_CAP,
  shouldDefer: true,
  searchHint: "present structured questions and collect the user's answers",
  searchKeywords: ['ask', 'multiple-choice'],
  userFacingName: () => '',
  requiresUserInteraction: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    const format = getQuestionPreviewFormat()
    const previewPrompt =
      format === 'markdown' || format === 'html' ? PREVIEW_FEATURE_PROMPT[format] : undefined
    return previewPrompt
      ? `${ASK_USER_QUESTION_TOOL_PROMPT}\n\n${previewPrompt}`
      : ASK_USER_QUESTION_TOOL_PROMPT
  },
  async checkPermissions(input: Input) {
    return {
      behavior: 'ask' as const,
      message: "Answer the assistant's questions?",
      updatedInput: input,
    }
  },
  validateInput(input: Input) {
    if (getQuestionPreviewFormat() !== 'html') {
      return { result: true as const }
    }
    for (const question of input.questions) {
      for (const option of question.options) {
        const preview = option.preview
        if (!preview) continue
        const where = `option "${option.label}" of question "${question.question}"`
        if (FULL_HTML_DOC_RE.test(preview)) {
          return {
            result: false as const,
            errorCode: 1,
            message: `Preview for ${where} is a full HTML document — supply a self-contained fragment without <html>, <body>, or a doctype.`,
          }
        }
        if (SCRIPT_OR_STYLE_RE.test(preview)) {
          return {
            result: false as const,
            errorCode: 1,
            message: `Preview for ${where} contains a <script> or <style> element — use inline style attributes instead.`,
          }
        }
        if (!HTML_ELEMENT_RE.test(preview)) {
          return {
            result: false as const,
            errorCode: 1,
            message: `Preview for ${where} contains no HTML element while the HTML preview format is active — wrap the content in an element.`,
          }
        }
      }
    }
    return { result: true as const }
  },
  async call(input: Input) {
    return {
      data: {
        questions: input.questions,
        answers: input.answers ?? {},
        ...(input.annotations ? { annotations: input.annotations } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const typed = typedOutcomeText(output)
    if (typed !== null) {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: typed,
      }
    }
    const lines = output.questions.map((question, index) => {
      const id = question.id || `q${index + 1}`
      const answer = lookupFor(output.answers, question)
      const answerText = answer === undefined ? '(unanswered)' : JSON.stringify(answer)
      let line = `- [${id}] ${JSON.stringify(question.question)} -> ${answerText}`
      const annotation = lookupFor(output.annotations, question)
      if (annotation?.notes) {
        line += `\n  notes: ${JSON.stringify(annotation.notes)}`
      }
      if (annotation?.preview) {
        line += `\n  selected preview:\n${annotation.preview}`
      }
      return line
    })
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [
        'User has answered your questions:',
        ...lines,
        "You can now continue with the user's answers in mind.",
      ].join('\n'),
    }
  },
  extractSearchText(output: Output) {
    return Object.entries(output.answers ?? {})
      .map(([key, value]) => `${key} ${value}`)
      .join('\n')
  },
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolResultMessage(output: Output): React.ReactNode {
    const answers = output.answers ?? {}
    const discussionId =
      output.outcome?.kind === 'discussion-requested' ? output.outcome.questionId : undefined
    const entries: Array<[string, string]> = []
    const consumedKeys = new Set<string>()
    for (const question of output.questions) {
      if (question.id) consumedKeys.add(question.id)
      if (question.question) consumedKeys.add(question.question)
      if (
        discussionId !== undefined &&
        (question.id === discussionId || question.question === discussionId)
      ) {
        entries.push([question.question, DISCUSS_OPTION_LABEL])
        continue
      }
      const answer = lookupFor(answers, question)
      if (answer !== undefined) {
        entries.push([question.question, answer])
      }
    }
    if (
      discussionId !== undefined &&
      !entries.some(([, value]) => value === DISCUSS_OPTION_LABEL)
    ) {
      entries.push([discussionId, DISCUSS_OPTION_LABEL])
    }
    for (const [key, value] of Object.entries(answers)) {
      if (!consumedKeys.has(key)) {
        entries.push([key, value])
      }
    }
    return <AnsweredQuestionsCard entries={entries} />
  },
  renderToolUseRejectedMessage(): React.ReactNode {
    return <Text dimColor>User declined to answer</Text>
  },
  renderToolUseErrorMessage(error: unknown): React.ReactNode {
    if (!isDeclineErrorText(error)) return null
    return <Text dimColor>User declined to answer</Text>
  },
})

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
