import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getKeybindingsPath } from '../../keybindings/loadUserBindings.js'
import { generateKeybindingsTemplate } from '../../keybindings/template.js'
import type { LocalCommandResult } from '../../types/command.js'
import { getErrnoCode } from '../../utils/errors.js'
import { toTildePath } from '../../utils/path.js'
import { editFileInEditor } from '../../utils/promptEditor.js'
import { editorDisplayName, editorRefusalLine, resolveExternalEditor, shownEditorValue, type EditorResolution } from '../../utils/editor.js'

export async function call(): Promise<LocalCommandResult> {
  return openKeybindings({})
}

export async function openKeybindings(io: { edit?: typeof editFileInEditor; editor?: () => EditorResolution }): Promise<LocalCommandResult> {
  const path = getKeybindingsPath()
  mkdirSync(dirname(path), { recursive: true })

  try {
    writeFileSync(path, generateKeybindingsTemplate(), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') throw error
  }

  const shown = toTildePath(path)
  const resolved = (io.editor ?? resolveExternalEditor)()
  if (!resolved.ok) {
    if (resolved.reason === 'none') return { type: 'text', value: `EDITOR is unset — edit ${shown} by hand` }
    return { type: 'text', value: editorRefusalLine(resolved) }
  }
  const named = resolved.variable === 'default' ? editorDisplayName(resolved.executable) : `${resolved.variable}=${shownEditorValue(resolved.editor, QUICK_RETURN_SHOWN_MAX)}`
  const before = readFileSync(path, 'utf8')
  const startedAt = Date.now()
  const result = await (io.edit ?? editFileInEditor)(path)
  if (result.content === null && result.error) {
    return { type: 'text', value: result.error }
  }
  if (result.content !== null && result.content === before && Date.now() - startedAt < QUICK_RETURN_MS) {
    return { type: 'text', value: `${named} returned at once; set an editor that waits` }
  }
  if (result.content !== null && result.content !== before) {
    return { type: 'text', value: `Saved ${shown} — the change is read now` }
  }
  return { type: 'text', value: `Opened ${shown} — /keys shows the map` }
}

const QUICK_RETURN_MS = 500
const QUICK_RETURN_SHOWN_MAX = 10
