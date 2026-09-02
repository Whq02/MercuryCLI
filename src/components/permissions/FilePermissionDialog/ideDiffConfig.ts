
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
