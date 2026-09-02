import { z } from 'zod/v4'

import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { editHunksEnabled } from '../../services/changeTransaction/hunks.js'
import { lineAnchorsEnabled } from '../../services/changeTransaction/lineAnchors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'

/**
 * The Edit tool's gate-selected input schema (three shapes), the shared
 * patch/git-diff sub-schemas Write re-uses, and the output schema.
 *
 * The STATIC type is always the widest shape so every lane stays reachable
 * in code; the RUNTIME schema narrows when the gates are off, which is
 * strictly more restrictive. Gate selection happens once, when the lazy
 * schema is first materialised.
 */

const FILE_PATH_DESCRIPTION = 'The absolute path to the file to modify'
const OLD_STRING_DESCRIPTION = 'The text to replace'
const NEW_STRING_DESCRIPTION = 'The text to replace it with (must be different from old_string)'
const REPLACE_ALL_DESCRIPTION = 'Replace all occurences of old_string (default false)'
const EXPECTED_ANCHOR_DESCRIPTION =
  'The staleness anchor from your most recent Read of this file — carry the parenthesised "(anchor: …)" value across exactly'

/** Gate-aware teaching (read at schema materialisation, like the shapes). */
const hunksDescription = (): string =>
  lineAnchorsEnabled()
    ? 'Line-addressed hunks against the anchored snapshot. Mutually exclusive with old_string/new_string; requires expected_anchor unless EVERY hunk is anchor-qualified ("12#ab3f" from a line_anchors read — then the line anchors are the staleness contract).'
    : 'Line-addressed hunks against the anchored snapshot. Mutually exclusive with old_string/new_string; requires expected_anchor.'

const hunkLinesDescription = (): string =>
  lineAnchorsEnabled()
    ? 'A 1-based line number ("12"), inclusive range ("12-18"), or anchor-qualified spelling copied exactly from a line_anchors read ("12#ab3f", "12#ab3f-18#9c2e"). Anchor-qualified endpoints are verified against the current content: a drifted line refuses and the refusal answers the current anchors — re-aim from those, never retype content.'
    : 'A 1-based line number ("12") or inclusive range ("12-18") of the anchored snapshot'

/** One line-addressed hunk of the anchored-edit lane. */
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

/** The widest (hunks-capable) shape — the static type derives from this. */
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
  })

/** The base shape: exact-string fields only. */
const stockSchemaFactory = () =>
  z.strictObject({
    file_path: z.string().describe(FILE_PATH_DESCRIPTION),
    old_string: z.string().describe(OLD_STRING_DESCRIPTION),
    new_string: z.string().describe(NEW_STRING_DESCRIPTION),
    replace_all: semanticBoolean(z.boolean().optional().default(false)).describe(
      REPLACE_ALL_DESCRIPTION,
    ),
  })

/** The base shape plus the anchor (change-transaction on, hunks off). */
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

/**
 * The runtime input schema, chosen by the two capability gates at first
 * materialisation. The widest static type is asserted over the narrower
 * runtime shapes: the narrow schemas are strictly more restrictive, so a
 * value they accept always inhabits the wide type.
 */
export const inputSchema = lazySchema((): WidestSchema => {
  if (!changeTransactionEnabled()) return stockSchemaFactory() as unknown as WidestSchema
  if (!editHunksEnabled()) return anchoredSchemaFactory() as unknown as WidestSchema
  return widestSchemaFactory()
})

/** The parsed input type (parsed, not raw — the lenient boolean coercion
 *  makes the input side unknown). */
export type FileEditInput = z.infer<WidestSchema>

/** The same shape minus the path. */
export type EditInput = Omit<FileEditInput, 'file_path'>

/** One normalised edit, replace-all always defined. */
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

/** A display-patch hunk (shared with Write and the diff components). */
export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

/** The single-file git-diff attachment (shared with Write). */
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

/** The bounded-repetition block a no-change settlement carries. */
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
    /** The chaining answer an anchor-addressed hunks call carries: the
     *  touched regions re-anchored against the updated content. */
    freshLineAnchors: z.string().optional(),
    /** The relocation notice (FN-013 LOOP-03): present exactly when a
     *  stale anchor was recovered by the bounded relocation — names the
     *  per-hunk line offsets ("lines A → B"). */
    staleRecovery: z.string().optional(),
  }),
)

export type FileEditOutput = z.infer<ReturnType<typeof outputSchema>>
