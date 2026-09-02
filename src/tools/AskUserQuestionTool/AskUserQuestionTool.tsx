// The multiple-choice question tool. Mercury layers: stable
// question/option identity, typed interview outcomes, preview validation.
//
// Compat: the id-less, outcome-less result text is a byte-preserved
// historical wire shape — prover-pinned verbatim.

import * as React from 'react'
import { z } from 'zod'
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
import {
  ASK_USER_QUESTION_TOOL_CHIP_WIDTH,
  ASK_USER_QUESTION_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_PROMPT,
  DESCRIPTION,
  PREVIEW_FEATURE_PROMPT,
} from './prompt.js'

const RESULT_SIZE_CAP = 100_000

// ── Schemas ────────────────────────────────────────────────────────

const questionOptionSchema = z.object({
  /** Stable option id — reused across rounds; omission mints
   *  presentation-scoped identity. */
  id: z.string().optional(),
  label: z.string().describe('Concise 1-5 word label for this option'),
  description: z
    .string()
    .describe('What choosing this option means or implies'),
  preview: z
    .string()
    .optional()
    .describe('Rendered when the option is focused (host-format dependent)'),
})

const questionSchema = z.object({
  /** Stable question id: identity, answers, and notes attach to it — carry
   *  it forward whenever the question is re-asked or reworded. */
  id: z.string().optional(),
  /** The durable decision several rounds may serve. */
  decisionId: z.string().optional(),
  question: z
    .string()
    .describe(
      'Clear, specific question ending in a question mark; phrase for multi-select when applicable',
    ),
  header: z
    .string()
    .max(ASK_USER_QUESTION_TOOL_CHIP_WIDTH)
    .describe(
      `Chip label, at most ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} characters`,
    ),
  options: z
    .array(questionOptionSchema)
    .min(2)
    .max(4)
    .describe(
      'Mutually exclusive unless multiSelect; an "Other" free-text option is supplied automatically — never author one',
    ),
  multiSelect: semanticBoolean(z.boolean().default(false)).describe(
    'Allow several answers to this question',
  ),
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
      kind: z.literal('finish-requested'),
      retainedDecisionIds: z.array(z.string()).default([]),
    }),
    z.object({
      kind: z.literal('cancelled'),
      preserveDraft: semanticBoolean(z.boolean().default(false)),
    }),
  ])
  .optional()

const inputSchemaObject = z
  .object({
    questions: z.array(questionSchema).min(1).max(4),
    answers: z.record(z.string(), z.string()).optional(),
    annotations: annotationsSchema,
    outcome: outcomeSchema,
    metadata: z.object({ source: z.string().optional() }).optional(),
  })
  .strict()
  .refine(
    input => {
      const texts = input.questions.map(q => q.question)
      if (new Set(texts).size !== texts.length) return false
      for (const q of input.questions) {
        const labels = q.options.map(o => o.label)
        if (new Set(labels).size !== labels.length) return false
      }
      return true
    },
    {
      message:
        'Question texts must be unique across the call, and option labels must be unique within each question.',
    },
  )

const outputSchemaObject = z.object({
  questions: z.array(questionSchema),
  answers: z.record(z.string(), z.string()).default({}),
  annotations: annotationsSchema,
  outcome: outcomeSchema,
})

/** The SDK-facing schemas are identical to the internal ones. */
export const _sdkInputSchema = inputSchemaObject
export const _sdkOutputSchema = outputSchemaObject

export type Question = z.infer<typeof questionSchema>
export type QuestionOption = z.infer<typeof questionOptionSchema>
export type Input = z.infer<typeof inputSchemaObject>
export type Output = z.infer<typeof outputSchemaObject>

// ── Result text ────────────────────────────────────────────────────

/** Resolve an answers/annotations key for a question: stable id first,
 * question text second (the id wins when both exist). */
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
    case 'finish-requested':
      return (
        'The user has finished the interview early — they have decided enough. Stop asking further questions and proceed with the answers provided.' +
        answersSoFarBlock(output)
      )
    case 'cancelled':
      return (
        `The user cancelled the interview${outcome.preserveDraft ? ' (drafts preserved for resume)' : ''}. Do not re-ask these questions now.` +
        answersSoFarBlock(output)
      )
    case 'answers-submitted':
      return null
  }
}

/** The historical id-less, outcome-less wire — byte-preserved. */
function legacyResultText(output: Output): string {
  const parts = output.questions.map(question => {
    const answer = lookupFor(output.answers, question) ?? ''
    const annotation = lookupFor(output.annotations, question)
    let entry = `${JSON.stringify(question.question)}=${JSON.stringify(answer)}`
    if (annotation?.preview) {
      entry += ` selected preview: ${annotation.preview}`
    }
    if (annotation?.notes) {
      entry += ` user notes: ${annotation.notes}`
    }
    return entry
  })
  return `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`
}

/** The identity-carrying per-question line shape. */
function identityResultText(output: Output): string {
  const lines = output.questions.map((question, index) => {
    const identifier = question.id ?? `q${index + 1}`
    const answer = lookupFor(output.answers, question)
    const annotation = lookupFor(output.annotations, question)
    // JSON-quoting keeps two different selections distinguishable to
    // whatever reads the wire text — bare values cannot guarantee that.
    let line = `- [${identifier}] ${JSON.stringify(question.question)} -> ${
      answer !== undefined ? JSON.stringify(answer) : '(unanswered)'
    }`
    if (annotation?.notes) {
      line += `\n  notes: ${JSON.stringify(annotation.notes)}`
    }
    if (annotation?.preview) {
      line += `\n  selected preview:\n${annotation.preview}`
    }
    return line
  })
  return `User has answered your questions:\n${lines.join('\n')}\nYou can now continue with the user's answers in mind.`
}

// ── The tool ───────────────────────────────────────────────────────────────

export const AskUserQuestionTool = buildTool({
  name: ASK_USER_QUESTION_TOOL_NAME,
  inputSchema: inputSchemaObject,
  outputSchema: outputSchemaObject,
  maxResultSizeChars: RESULT_SIZE_CAP,
  shouldDefer: true,
  searchHint: 'ask the user structured multiple-choice questions',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    const format = getQuestionPreviewFormat()
    if (format && PREVIEW_FEATURE_PROMPT[format]) {
      return `${ASK_USER_QUESTION_TOOL_PROMPT}\n\n${PREVIEW_FEATURE_PROMPT[format]}`
    }
    return ASK_USER_QUESTION_TOOL_PROMPT
  },
  requiresUserInteraction() {
    return true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  /** Empty: its rows render without a tool label. */
  userFacingName() {
    return ''
  },
  toAutoClassifierInput(input: Input): string {
    return Array.isArray(input.questions) ? input.questions.map(q => q?.question ?? '').join(' | ') : ''
  },
  /** HTML previews get an intent check, not a parser. */
  async validateInput(input: Input) {
    if (getQuestionPreviewFormat() !== 'html') return { result: true as const }
    for (const question of input.questions) {
      for (const option of question.options) {
        const preview = option.preview
        if (!preview) continue
        const where = `option "${option.label}" of question "${question.question}"`
        if (/<\s*(html|body)[\s>]|<!doctype/i.test(preview)) {
          return {
            result: false as const,
            message: `Preview for ${where} is a full HTML document — supply a self-contained fragment without <html>, <body>, or a doctype.`,
            errorCode: 1,
          }
        }
        if (/<\s*(script|style)[\s>]/i.test(preview)) {
          return {
            result: false as const,
            message: `Preview for ${where} contains a <script> or <style> element — use inline style attributes instead.`,
            errorCode: 1,
          }
        }
        if (!/<[a-z][^>]*>/i.test(preview)) {
          return {
            result: false as const,
            message: `Preview for ${where} contains no HTML element while the HTML preview format is active — wrap the content in an element.`,
            errorCode: 1,
          }
        }
      }
    }
    return { result: true as const }
  },
  /** Always asks. */
  async checkPermissions(input: Input) {
    return {
      behavior: 'ask' as const,
      message: 'Answer the assistant\'s questions?',
      updatedInput: input,
    }
  },
  async call(input: Input) {
    // Pass-through: the permission surface collected everything.
    return {
      data: {
        questions: input.questions,
        answers: input.answers ?? {},
        ...(input.annotations ? { annotations: input.annotations } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
      } as Output,
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
    const hasIdentity =
      output.outcome !== undefined ||
      output.questions.some(question => question.id !== undefined)
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: hasIdentity
        ? identityResultText(output)
        : legacyResultText(output),
    }
  },
  extractSearchText(output: Output): string {
    return Object.entries(output.answers ?? {})
      .map(([key, value]) => `${key} ${value}`)
      .join('\n')
  },
  renderToolUseMessage() {
    return null
  },
  renderToolUseProgressMessage() {
    return null
  },
  renderToolResultMessage(output: Output): React.ReactNode {
    // The card speaks QUESTION TEXT, never the stable id the answers record
    // may be keyed by (the interview authority keys by id — painting the
    // raw `iq_…` key told the operator nothing). An answer keyed by neither
    // id nor text still paints under its raw key rather than vanishing.
    const answers = output.answers ?? {}
    const byQuestion = new Map<string, string>()
    for (const q of output.questions) {
      const answer = lookupFor(answers, q)
      if (answer !== undefined) byQuestion.set(q.question, answer)
    }
    const matched = new Set(
      output.questions.flatMap(q => [q.id, q.question]).filter((k): k is string => !!k),
    )
    const entries: Array<[string, string]> = [
      ...byQuestion.entries(),
      ...Object.entries(answers).filter(([key]) => !matched.has(key)),
    ]
    return <AnsweredQuestionsCard entries={entries} />
  },
  renderToolUseRejectedMessage(): React.ReactNode {
    return <Text dimColor>User declined to answer</Text>
  },
})

/** The answered-questions card: the header row (mode-coloured ● + the
 *  sentence) sits OUTSIDE the shared response frame in a column box with a
 *  top margin; the per-answer rows render inside MessageResponse in the
 *  inactive text colour. */
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
