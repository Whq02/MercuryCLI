import { z } from 'zod/v4'
import { JEV_MAX_CHOICE_OPTIONS, JEV_MAX_SCORE_LEVELS, JEV_MIN_SCORE_LEVELS } from '../../services/jev/jevContract.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { JEV_EVAL_ESCAPE_OPTION, JEV_EVAL_ID_PATTERN, JEV_EVAL_MAX_GOAL_CHARS, JEV_EVAL_MAX_ID_CHARS } from './constants.js'

export const JEV_EVAL_KINDS = ['noul', 'choice', 'score'] as const
export type JevEvalKind = (typeof JEV_EVAL_KINDS)[number]

const questionSchema = lazySchema(() =>
  z.strictObject({
    id: z
      .string()
      .min(1)
      .max(JEV_EVAL_MAX_ID_CHARS)
      .regex(JEV_EVAL_ID_PATTERN)
      .describe('Your handle for this answer line (letters, digits, _ and -); never sent to Jev'),
    kind: z
      .enum(JEV_EVAL_KINDS)
      .describe('noul: the probability a yes/no statement holds · choice: one of your options · score: a position on your ordered levels'),
    ask: z
      .string()
      .min(1)
      .describe('The whole question, short and literal — Jev reads only this and `evidence`; name the evidence keys it turns on in backticks'),
    options: z
      .record(z.string(), z.string().nullable())
      .optional()
      .describe('choice only: label → the exact condition it stands for (null when the label says it all); an option you omit cannot be chosen'),
    levels: z
      .array(z.string().min(1))
      .min(JEV_MIN_SCORE_LEVELS)
      .max(JEV_MAX_SCORE_LEVELS)
      .optional()
      .describe('score only: 2..10 ordered level descriptions, lowest first, each distinct'),
    allow_none: z
      .boolean()
      .optional()
      .describe('choice only, and required there: true appends the escape option `none` so Jev can say none of these fit; false forces a pick'),
    none_means: z
      .string()
      .min(1)
      .optional()
      .describe('choice with allow_none true: what `none` stands for, phrased positively'),
  }),
)

export type JevEvalQuestion = z.infer<ReturnType<typeof questionSchema>>

export const jevEvalInputSchema = lazySchema(() =>
  z
    .strictObject({
      goal: z
        .string()
        .min(1)
        .max(JEV_EVAL_MAX_GOAL_CHARS)
        .describe('One line: the decision this call serves (shown to the operator, not sent to Jev)'),
      evidence: z
        .record(z.string(), z.string())
        .describe(
          "Named facts, sent verbatim as Jev's state: filtered excerpts and measured values only — never whole files, the transcript, environment values, secrets or stack traces; everything here leaves the machine and is retained by the provider",
        ),
      questions: z.array(questionSchema()).min(1).describe('Every question you want answered against this evidence, in one call'),
    })
    .superRefine((input, ctx) => {
      if (Object.keys(input.evidence).length === 0) {
        ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'evidence needs at least one named fact' })
      }
      const seen = new Set<string>()
      input.questions.forEach((question, index) => {
        const at = (field: string, message: string): void => {
          ctx.addIssue({ code: 'custom', path: ['questions', index, field], message: `question "${question.id}": ${message}` })
        }
        if (seen.has(question.id)) at('id', 'the id is used twice; ids are the answer keys and must be unique')
        seen.add(question.id)
        if (question.kind === 'choice') {
          const labels = Object.keys(question.options ?? {})
          if (question.options === undefined || labels.length === 0) at('options', 'a choice needs options (label → condition)')
          if (labels.some(label => label.trim() === '')) at('options', 'an option label must not be empty')
          if (labels.includes(JEV_EVAL_ESCAPE_OPTION)) at('options', `the label "${JEV_EVAL_ESCAPE_OPTION}" is reserved for the escape option — set allow_none true instead`)
          if (question.allow_none === undefined) at('allow_none', 'a choice must say whether Jev may answer none of these (allow_none true or false)')
          const outcomes = labels.length + (question.allow_none === true ? 1 : 0)
          if (labels.length > 0 && outcomes < 2) at('options', 'a choice needs at least two outcomes: two options, or one option with allow_none true')
          if (outcomes > JEV_MAX_CHOICE_OPTIONS) at('options', `${outcomes} outcomes (options plus the escape) exceed the ${JEV_MAX_CHOICE_OPTIONS} the provider accepts`)
          if (question.none_means !== undefined && question.allow_none !== true) at('none_means', 'none_means only goes with allow_none true')
          if (question.levels !== undefined) at('levels', 'levels belong to a score question, not a choice')
        } else {
          if (question.options !== undefined) at('options', `options belong to a choice question, not a ${question.kind}`)
          if (question.allow_none !== undefined) at('allow_none', `allow_none belongs to a choice question, not a ${question.kind}`)
          if (question.none_means !== undefined) at('none_means', `none_means belongs to a choice question, not a ${question.kind}`)
          if (question.kind === 'score') {
            if (question.levels === undefined) at('levels', 'a score needs levels (2..10 ordered descriptions)')
            else if (new Set(question.levels.map(level => level.trim())).size !== question.levels.length) at('levels', 'every level must be described distinctly')
          } else if (question.levels !== undefined) {
            at('levels', 'levels belong to a score question, not a noul')
          }
        }
      })
    }),
)

export type JevEvalInputSchema = ReturnType<typeof jevEvalInputSchema>
export type JevEvalInput = z.infer<JevEvalInputSchema>
