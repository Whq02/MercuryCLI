import { z } from 'zod/v4'

import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { editHunksEnabled } from '../../services/changeTransaction/hunks.js'
import { lineAnchorsEnabled } from '../../services/changeTransaction/lineAnchors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'


const FILE_PATH_DESCRIPTION = 'The absolute path to the file to modify'
const OLD_STRING_DESCRIPTION = 'The exact text to replace, sent with new_string; unique in the file unless replace_all'
const NEW_STRING_DESCRIPTION = 'The text to replace it with; "" deletes old_string'
const REPLACE_ALL_DESCRIPTION = 'Replace every occurrence of old_string'
const EXPECTED_ANCHOR_DESCRIPTION =
  'The bare fa:… or ra:… value inside the latest "(anchor: …)" for this file — a Read, or an Edit or Write result — without the wrapper'
const APPEND_DESCRIPTION =
  'Text added on its own line at the end of the file (created when absent; no prior read needed), or at the end of `section`'
const SECTION_DESCRIPTION =
  'A Markdown heading line exactly as it stands in the file ("## Checks"), occurring once: with new_string the whole section, heading included, becomes new_string; with append the text is added inside it'

const hunksDescription = (): string =>
  lineAnchorsEnabled()
    ? 'Line-addressed hunks against the snapshot expected_anchor names, or against the content anchors when every hunk carries one'
    : 'Line-addressed hunks against the snapshot expected_anchor names'

const hunkLinesDescription = (): string =>
  lineAnchorsEnabled()
    ? 'A 1-based line ("12"), an inclusive range ("12-18"), or the anchored spelling from a line_anchors read ("12#ab3f", "12#ab3f-18#9c2e")'
    : 'A 1-based line ("12") or inclusive range ("12-18") of the snapshot'

const hunkEntrySchema = () =>
  z.strictObject({
    lines: z.string().describe(hunkLinesDescription()),
    replace: z
      .string()
      .describe('The replacement body; "" deletes the range; with insert, the inserted body'),
    insert: z
      .enum(['before', 'after'])
      .optional()
      .describe('Insert beside the single anchor line instead of replacing it'),
  })


const EDIT_SHAPES_DESCRIPTION =
  'One of four shapes: old_string + new_string · hunks · append · section + new_string or append'

const widestSchemaFactory = () =>
  z
    .strictObject({
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
    .describe(EDIT_SHAPES_DESCRIPTION)

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

const editedLinesSchema = lazySchema(() =>
  z.object({
    what: z.string(),
    where: z.string(),
    occurrences: z.number().optional(),
    changes: z.array(
      z.object({
        kind: z.enum(['changed', 'added', 'removed']),
        start: z.number(),
        end: z.number(),
        removedLines: z.number().optional(),
      }),
    ),
    lineCount: z.number(),
    endsWithNewline: z.boolean(),
    shown: z.array(z.object({ start: z.number(), end: z.number(), anchor: z.string() })),
    notShown: z.array(z.object({ start: z.number(), end: z.number() })),
    readBack: z.enum(['same', 'differs', 'failed']),
    body: z.string(),
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
    readThrough: z.string().optional(),
    editedLines: editedLinesSchema().optional(),
    parseError: z.string().optional(),
  }),
)

export type FileEditOutput = z.infer<ReturnType<typeof outputSchema>>
