import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getKeybindingsPath } from '../../keybindings/loadUserBindings.js'
import { generateKeybindingsTemplate } from '../../keybindings/template.js'
import type { LocalCommandResult } from '../../types/command.js'
import { getErrnoCode } from '../../utils/errors.js'
import { editFileInEditor } from '../../utils/promptEditor.js'

/**
 * `/keybindings` — create the user keybindings file when absent (template
 * included) and open it in an editor. Exclusive create keeps the probe and
 * the write one atomic syscall; `EEXIST` simply means the file already
 * existed and its content is preserved.
 */
export async function call(): Promise<LocalCommandResult> {
  const path = getKeybindingsPath()
  mkdirSync(dirname(path), { recursive: true })

  let created = true
  try {
    writeFileSync(path, generateKeybindingsTemplate(), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') throw error
    created = false
  }

  const verb = created ? 'Created' : 'Opened'
  const result = await editFileInEditor(path)
  if (result.content === null && result.error) {
    return {
      type: 'text',
      value: `${created ? 'Created' : 'Found'} ${path}, but the editor failed to open it: ${result.error}`,
    }
  }
  // The write half and the read half are one owned configuration: /keys
  // shows the effective map.
  return {
    type: 'text',
    value: `${verb} ${path}. See the effective map with /keys.`,
  }
}
