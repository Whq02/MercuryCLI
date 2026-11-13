import { z } from 'zod/v4'
import { JEV_MAX_CHOICE_OPTIONS, JEV_MAX_SCORE_LEVELS, JEV_MIN_SCORE_LEVELS } from '../../services/jev/jevContract.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  JEV_EVAL_ESCAPE_OPTION,
  JEV_EVAL_FILE_KEY,
  JEV_EVAL_FORMATS,
  JEV_EVAL_ID_COLUMN,
  JEV_EVAL_ID_PATTERN,
  JEV_EVAL_MAX_FILE_BYTES,
  JEV_EVAL_MAX_GOAL_CHARS,
  JEV_EVAL_MAX_ID_CHARS,
  JEV_EVAL_MAX_ROWS,
  JEV_EVAL_PARAGRAPH_FACT,
  JEV_EVAL_TABLE_KEY,
} from './constants.js'
import { jevEvalFileOf, jevEvalTableOf, jevEvalTableRows } from './jevEvalEvidence.js'

const JEV_EVAL_KINDS = ['noul', 'choice', 'score'] as const
export type JevEvalKind = (typeof JEV_EVAL_KINDS)[number]
export type JevEvalFormat = (typeof JEV_EVAL_FORMATS)[number]

const idSchema = (): z.ZodString => z.string().min(1).max(JEV_EVAL_MAX_ID_CHARS).regex(JEV_EVAL_ID_PATTERN)
const idColumnSchema = (): z.ZodOptional<z.ZodString> =>
  z.string().min(1).optional().describe(`Row-key column (never sent; default ${JEV_EVAL_ID_COLUMN} if present, else positional)`)

const fileItemSchema = () =>
  z.strictObject({
    [JEV_EVAL_FILE_KEY]: z
      .strictObject({
        path: z.string().min(1).describe('File path (relative to cwd, ~ expands), checked against read permissions'),
        format: z
          .enum(JEV_EVAL_FORMATS)
          .optional()
          .describe(
            'Default by extension (.tsv, .csv, .md/.markdown first pipe table, .jsonl/.ndjson, else whole-file `text`); paragraphs splits on blank lines',
          ),
        id_column: idColumnSchema(),
      })
      .describe('Evidence file (one item per table row, or one item for text)'),
  })

const tableItemSchema = () =>
  z.strictObject({
    [JEV_EVAL_TABLE_KEY]: z
      .strictObject({
        columns: z.array(z.string().min(1)).min(1).describe('Distinct fact column names'),
        rows: z.array(z.array(z.string())).min(1).describe('Rows matching columns order'),
        id_column: idColumnSchema(),
      })
      .describe('Inline evidence table (one item per row)'),
  })

const evidenceItemSchema = lazySchema(() =>
  z.union(
    [
      z.string().min(1).describe(`Paragraph sent as \`${JEV_EVAL_PARAGRAPH_FACT}\` (keyed #1, #2, …)`),
      fileItemSchema(),
      tableItemSchema(),
      z
        .object({
          id: idSchema().optional().describe('Row label (never sent; default positional)'),
        })
        .catchall(z.string())
        .describe(
          "Named facts sent verbatim under the road's data policy (omit unrelated text)",
        ),
    ],
    {
      error: `an evidence item is a paragraph (a string), a record of named facts (string values, an optional id), a file ({"${JEV_EVAL_FILE_KEY}":{"path":…}}) or a table ({"${JEV_EVAL_TABLE_KEY}":{"columns":[…],"rows":[[…]]}})`,
    },
  ),
)

export type JevEvalEvidenceItem = z.infer<ReturnType<typeof evidenceItemSchema>>
export type JevEvalFileItem = z.infer<ReturnType<typeof fileItemSchema>>
export type JevEvalTableItem = z.infer<ReturnType<typeof tableItemSchema>>
export type JevEvalRecordItem = { id?: string } & Record<string, string>

function withoutMeaninglessEmpties(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const question = { ...(value as Record<string, unknown>) }
  if (Array.isArray(question.levels) && question.levels.length === 0) delete question.levels
  if (question.none_means === '') delete question.none_means
  if (question.allow_none === false && question.kind !== 'choice') delete question.allow_none
  if (typeof question.options === 'object' && question.options !== null && !Array.isArray(question.options) && Object.keys(question.options).length === 0 && question.kind !== 'choice') delete question.options
  return question
}

const questionFields = () =>
  z.strictObject({
    id: idSchema().describe('Answer column handle (never sent)'),
    kind: z
      .enum(JEV_EVAL_KINDS)
      .describe('noul: p(yes) · choice: option pick · score: ordered level'),
    ask: z
      .string()
      .min(1)
      .describe('Question text (Jev sees only ask + evidence)'),
    options: z
      .record(z.string(), z.string().nullable())
      .optional()
      .describe('choice: label → exact condition (null if label suffices)'),
    levels: z
      .array(z.string().min(1))
      .min(JEV_MIN_SCORE_LEVELS)
      .max(JEV_MAX_SCORE_LEVELS)
      .optional()
      .describe('score: 2..10 distinct ordered levels, lowest first'),
    allow_none: z
      .boolean()
      .optional()
      .describe('choice (required): true adds escape option `none`; false forces a pick'),
    none_means: z
      .string()
      .min(1)
      .optional()
      .describe('choice + allow_none: positive meaning of `none`'),
  })

const questionSchema = lazySchema(() => z.preprocess(withoutMeaninglessEmpties, questionFields()))

export type JevEvalQuestion = z.infer<ReturnType<typeof questionFields>>

export const jevEvalInputSchema = lazySchema(() =>
  z
    .strictObject({
      goal: z
        .string()
        .min(1)
        .max(JEV_EVAL_MAX_GOAL_CHARS)
        .describe('One-line decision served (shown to operator, never sent)'),
      evidence: z
        .array(evidenceItemSchema())
        .min(1)
        .describe(
          `Evidence items judged in parallel against all questions (rows keyed by id/${JEV_EVAL_ID_COLUMN} or position; files/tables add ≤${JEV_EVAL_MAX_ROWS} rows, file ≤${JEV_EVAL_MAX_FILE_BYTES} B)`,
        ),
      questions: z.array(questionSchema()).min(1).describe('Questions asked of every item'),
    })
    .superRefine((input, ctx) => {
      const rows = new Map<string, string>()
      input.evidence.forEach((item, index) => {
        if (typeof item === 'string') {
          if (item.trim() === '') ctx.addIssue({ code: 'custom', path: ['evidence', index], message: `evidence[${index}] is an empty paragraph` })
          return
        }
        if (jevEvalFileOf(item) !== undefined) return
        const table = jevEvalTableOf(item)
        if (table !== undefined) {
          const expanded = jevEvalTableRows(table.columns, table.rows, table.id_column, { index, name: 'table', unit: 'row' }, rows)
          if (!expanded.ok) ctx.addIssue({ code: 'custom', path: ['evidence', index], message: expanded.reason })
          return
        }
        const record = item as JevEvalRecordItem
        if (Object.keys(record).filter(key => key !== 'id').length === 0) {
          ctx.addIssue({ code: 'custom', path: ['evidence', index], message: `evidence[${index}] needs at least one named fact besides its id` })
        }
        if (record.id !== undefined) {
          if (rows.has(record.id)) ctx.addIssue({ code: 'custom', path: ['evidence', index, 'id'], message: `evidence[${index}].id "${record.id}" is used twice; ids are the row keys and must be unique` })
          rows.set(record.id, `evidence[${index}]`)
        }
      })
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
