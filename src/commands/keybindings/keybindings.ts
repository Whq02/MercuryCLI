import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getKeybindingsPath } from '../../keybindings/loadUserBindings.js'
import { generateKeybindingsTemplate } from '../../keybindings/template.js'
import type { LocalCommandResult } from '../../types/command.js'
import { getErrnoCode } from '../../utils/errors.js'
import { editFileInEditor } from '../../utils/promptEditor.js'
import { getExternalEditor } from '../../utils/editor.js'

export async function call(): Promise<LocalCommandResult> {
  return openKeybindings({})
}

export async function openKeybindings(io: { edit?: typeof editFileInEditor; editor?: () => string | undefined }): Promise<LocalCommandResult> {
  const path = getKeybindingsPath()
  mkdirSync(dirname(path), { recursive: true })

  let created = true
  try {
    writeFileSync(path, generateKeybindingsTemplate(), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') throw error
    created = false
  }

  const made = created ? 'Created' : 'Found'
  const editor = (io.editor ?? getExternalEditor)()
  if (editor === undefined || editor.trim() === '') {
    return {
      type: 'text',
      value: `${made} ${path}; no editor is configured (set EDITOR or VISUAL to open it from here), so edit the file by hand — a saved change is read on the next keystroke. See the effective map with /keys.`,
    }
  }
  const before = readFileSync(path, 'utf8')
  const startedAt = Date.now()
  const result = await (io.edit ?? editFileInEditor)(path)
  if (result.content === null && result.error) {
    return {
      type: 'text',
      value: `${made} ${path}, but the editor failed to open it: ${result.error}`,
    }
  }
  if (result.content !== null && result.content === before && Date.now() - startedAt < QUICK_RETURN_MS) {
    return {
      type: 'text',
      value: `${made} ${path}; the editor (${editor}) returned at once without opening it — set EDITOR or VISUAL to an editor that waits, or edit the file by hand. See the effective map with /keys.`,
    }
  }
  return {
    type: 'text',
    value: `${created ? 'Created' : 'Opened'} ${path}${result.content !== null && result.content !== before ? ' — the change is saved and read' : ''}. See the effective map with /keys.`,
  }
}

const QUICK_RETURN_MS = 500
