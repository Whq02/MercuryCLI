import { z } from 'zod/v4'

import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { editHunksEnabled } from '../../services/changeTransaction/hunks.js'
import { lineAnchorsEnabled } from '../../services/changeTransaction/lineAnchors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'


const FILE_PATH_DESCRIPTION = 'The absolute path to the file to modify'
const OLD_STRING_DESCRIPTION = 'The text to replace'
const NEW_STRING_DESCRIPTION = 'The text to replace it with (must be different from old_string)'
const REPLACE_ALL_DESCRIPTION = 'Replace all occurences of old_string (default false)'
const EXPECTED_ANCHOR_DESCRIPTION =
  'The staleness anchor from your most recent Read of this file — carry the parenthesised "(anchor: …)" value across exactly'
const APPEND_DESCRIPTION =
  'Text to add at the end of the file, on its own line (a newline is placed before it when the file does not end with one; the file is created when absent). No line numbers, no prior read needed — no existing byte changes. With `section`, the text lands at the end of that section instead. Mutually exclusive with old_string/new_string/hunks.'
const SECTION_DESCRIPTION =
  'A Markdown heading line, exactly as it stands in the file ("## Checks"), naming the section to edit: the heading through the line before the next heading of the same or a higher level. With new_string the whole section (heading included) becomes new_string; with append the text is added inside the section. The heading must occur once. Mutually exclusive with old_string/hunks.'

const hunksDescription = (): string =>
  lineAnchorsEnabled()
    ? 'Line-addressed hunks against the anchored snapshot. Mutually exclusive with old_string/new_string; requires expected_anchor unless EVERY hunk is anchor-qualified ("12#ab3f" from a line_anchors read — then the line anchors are the staleness contract).'
    : 'Line-addressed hunks against the anchored snapshot. Mutually exclusive with old_string/new_string; requires expected_anchor.'

const hunkLinesDescription = (): string =>
  lineAnchorsEnabled()
    ? 'A 1-based line number ("12"), inclusive range ("12-18"), or anchor-qualified spelling copied exactly from a line_anchors read ("12#ab3f", "12#ab3f-18#9c2e"). Anchor-qualified endpoints are verified against the current content: a drifted line refuses and the refusal answers the current anchors — re-aim from those, never retype content.'
    : 'A 1-based line number ("12") or inclusive range ("12-18") of the anchored snapshot'

const hunkEntrySchema = () =>
  z.strictObject({
    lines: z.string().describe(hunkLinesDescription()),
    replace: z
      .string()
      .describe('The replacement body ("" deletes the range; with insert, the inserted body)'),
    insert: z
      .enum(['before', 'after'])
      .optional()
      .describe('Insert relative to the single anchor line instead of replacing it'),
  })

const widestSchemaFactory = () =>
  z.strictObject({
    file_path: z.string().describe(FILE_PATH_DESCRIPTION),
    old_string: z.string().optional().describe(OLD_STRING_DESCRIPTION),
    new_string: z.string().optional().describe(NEW_STRING_DESCRIPTION),
    replace_all: semanticBoolean(z.boolean().optional().default(false)).describe(
      REPLACE_ALL_DESCRIPTION,
    ),
    expected_anchor: z.string().optional().describe(EXPECTED_ANCHOR_DESCRIPTION),
    hunks: z.array(hunkEntrySchema()).optional().describe(hunksDescription()),
    append: z.string().optional().describe(APPEND_DESCRIPTION),
    section: z.string().optional().describe(SECTION_DESCRIPTION),
  })

const stockSchemaFactory = () =>
  z.strictObject({
    file_path: z.string().describe(FILE_PATH_DESCRIPTION),
    old_string: z.string().describe(OLD_STRING_DESCRIPTION),
    new_string: z.string().describe(NEW_STRING_DESCRIPTION),
    replace_all: semanticBoolean(z.boolean().optional().default(false)).describe(
      REPLACE_ALL_DESCRIPTION,
    ),
  })

const anchoredSchemaFactory = () =>
  z.strictObject({
    file_path: z.string().describe(FILE_PATH_DESCRIPTION),
    old_string: z.string().describe(OLD_STRING_DESCRIPTION),
    new_string: z.string().describe(NEW_STRING_DESCRIPTION),
    replace_all: semanticBoolean(z.boolean().optional().default(false)).describe(
      REPLACE_ALL_DESCRIPTION,
    ),
    expected_anchor: z.string().optional().describe(EXPECTED_ANCHOR_DESCRIPTION),
  })

type WidestSchema = ReturnType<typeof widestSchemaFactory>

export const inputSchema = lazySchema((): WidestSchema => {
  if (!changeTransactionEnabled()) return stockSchemaFactory() as unknown as WidestSchema
  if (!editHunksEnabled()) return anchoredSchemaFactory() as unknown as WidestSchema
  return widestSchemaFactory()
})

export type FileEditInput = z.infer<WidestSchema>

export type EditInput = Omit<FileEditInput, 'file_path'>

export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),
    status: z.enum(['modified', 'added']),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string(),
    repository: z.string().nullable().optional(),
  }),
)

const noChangeSchema = lazySchema(() =>
  z.object({
    streak: z.number(),
    stop: z.boolean(),
    guidance: z.string(),
  }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    originalFile: z.string(),
    structuredPatch: z.array(hunkSchema()),
    userModified: z.boolean(),
    replaceAll: z.boolean(),
    gitDiff: gitDiffSchema().optional(),
    noChange: noChangeSchema().optional(),
    freshLineAnchors: z.string().optional(),
    staleRecovery: z.string().optional(),
  }),
)

export type FileEditOutput = z.infer<ReturnType<typeof outputSchema>>
