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

export const JEV_EVAL_KINDS = ['noul', 'choice', 'score'] as const
export type JevEvalKind = (typeof JEV_EVAL_KINDS)[number]
export type JevEvalFormat = (typeof JEV_EVAL_FORMATS)[number]

const idSchema = (): z.ZodString => z.string().min(1).max(JEV_EVAL_MAX_ID_CHARS).regex(JEV_EVAL_ID_PATTERN)
const idColumnSchema = (): z.ZodOptional<z.ZodString> =>
  z.string().min(1).optional().describe(`The column whose cell keys the row (the row label, never sent); absent, a column named ${JEV_EVAL_ID_COLUMN} when there is one, else the rows are keyed by position`)

const fileItemSchema = () =>
  z.strictObject({
    [JEV_EVAL_FILE_KEY]: z
      .strictObject({
        path: z.string().min(1).describe('The file to read: an absolute path (a relative one resolves against the working directory, ~ expands); it passes the same read rules as Read'),
        format: z
          .enum(JEV_EVAL_FORMATS)
          .optional()
          .describe(
            'Absent, the extension decides: .tsv tsv, .csv csv, .md/.markdown markdown (the first pipe table), .jsonl/.ndjson jsonl (one object per line), anything else text (the whole file is ONE item as the fact `text`); paragraphs splits a text file on blank lines, one item each',
          ),
        id_column: idColumnSchema(),
      })
      .describe('A file of evidence: a table file becomes one item per row, the header names the facts; a text file one item'),
  })

const tableItemSchema = () =>
  z.strictObject({
    [JEV_EVAL_TABLE_KEY]: z
      .strictObject({
        columns: z.array(z.string().min(1)).min(1).describe('The fact names, one per column, each once'),
        rows: z.array(z.array(z.string())).min(1).describe('One item per row, one cell per column, in the columns\' order'),
        id_column: idColumnSchema(),
      })
      .describe('An inline table: one item per row, the columns the fact names'),
  })

const evidenceItemSchema = lazySchema(() =>
  z.union(
    [
      z.string().min(1).describe(`A paragraph, sent as the one fact \`${JEV_EVAL_PARAGRAPH_FACT}\`; its row is keyed by position (#1, #2, …)`),
      fileItemSchema(),
      tableItemSchema(),
      z
        .object({
          id: idSchema().optional().describe('The row label (letters, digits, _ and -); never sent to Jev; absent, the row is keyed by position'),
        })
        .catchall(z.string())
        .describe(
          "Named facts, sent verbatim as Jev's state: filtered excerpts and measured values only — never a whole file pasted in (a file of rows is the file form), the transcript, environment values, secrets or stack traces; everything here leaves the machine under the selected road's data policy",
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

const questionSchema = lazySchema(() =>
  z.strictObject({
    id: idSchema().describe('Your handle for this answer column (letters, digits, _ and -); never sent to Jev'),
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
        .array(evidenceItemSchema())
        .min(1)
        .describe(
          `The evidence items, each a record of named facts, a bare paragraph, a file ({"${JEV_EVAL_FILE_KEY}":{"path":…}}: a table file — tsv, csv, a markdown pipe table, jsonl — is one item per row named by its header, a text file one item) or an inline table ({"${JEV_EVAL_TABLE_KEY}":{"columns":[…],"rows":[[…]]}}: one item per row); every item is judged against every question, one request each, all at once, each counted against the pace and the budget; one table back, rows keyed by the item's id (a record's id, a row's ${JEV_EVAL_ID_COLUMN} column, never sent) or by position. The size rule: files and tables add at most ${JEV_EVAL_MAX_ROWS} rows to one call and a file is at most ${JEV_EVAL_MAX_FILE_BYTES} bytes; above either the call is refused naming the count, nothing trimmed, nothing sent; a ragged row is refused naming its line, never padded or cut`,
        ),
      questions: z.array(questionSchema()).min(1).describe('The one question set, asked of every evidence item'),
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
