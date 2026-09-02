/**
 * How a tool exposes its pending edit to the IDE diff surface. The field
 * spellings cross the IDE-diff hook and prompt-surface boundary.
 */

import type { FileEdit } from '../../../tools/FileEditTool/types.js'

export type { FileEdit }

export type IDEDiffConfig = {
  filePath: string
  edits?: FileEdit[]
  editMode?: 'single' | 'multiple'
}

export type IDEDiffSupport<TInput> = {
  getConfig: (input: TInput) => IDEDiffConfig
  applyChanges: (input: TInput, modifiedEdits: FileEdit[]) => TInput
}

/** A one-edit config; always single mode. */
export function createSingleEditDiffConfig(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): IDEDiffConfig {
  return {
    filePath,
    edits: [{ old_string: oldString, new_string: newString, replace_all: replaceAll ?? false }],
    editMode: 'single',
  }
}
