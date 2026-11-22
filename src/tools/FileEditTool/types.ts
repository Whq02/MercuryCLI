import { z } from 'zod/v4'

import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { editHunksEnabled } from '../../services/changeTransaction/hunks.js'
import { lineAnchorsEnabled } from '../../services/changeTransaction/lineAnchors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


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


const EDIT_SHAPES_DESCRIPTION =
  'One of four shapes: old_string + new_string · hunks · append · section + new_string or append'

const widestSchemaFactory = (): Unbuilt =>
  notBuilt('src/tools/FileEditTool/types.ts:47')

const stockSchemaFactory = () =>
  z.strictObject({
    file_path: z.string().describe(FILE_PATH_DESCRIPTION),
    old_string: z.string().describe(OLD_STRING_DESCRIPTION),
    new_string: z.string().describe(NEW_STRING_DESCRIPTION),
    replace_all: semanticBoolean(z.boolean().optional().default(false)).describe(
      REPLACE_ALL_DESCRIPTION,
    ),
  })

const anchoredSchemaFactory = (): Unbuilt =>
  notBuilt('src/tools/FileEditTool/types.ts:73')

type WidestSchema = ReturnType<typeof widestSchemaFactory>

export type FileEditInput = z.infer<WidestSchema>

export const inputSchema = lazySchema((): z.ZodType<FileEditInput> => {
  if (!changeTransactionEnabled()) return stockSchemaFactory()
  if (!editHunksEnabled()) return anchoredSchemaFactory()
  return widestSchemaFactory()
})

export const hunkSchema: Unbuilt = unbuilt('src/tools/FileEditTool/types.ts:94')

export const gitDiffSchema: Unbuilt = unbuilt('src/tools/FileEditTool/types.ts:104')

export const outputSchema: Unbuilt = unbuilt('src/tools/FileEditTool/types.ts:146')

export type FileEditOutput = z.infer<ReturnType<typeof outputSchema>>
