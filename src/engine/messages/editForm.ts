import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { EDIT_TOOL_NAME } from '../../tools/kit/names/edit.js'

function forcedEditForm(): 'full' | 'plain' | undefined {
  const value = flagEnv('MERCURY_EDIT_FORM')
  return value === 'full' || value === 'plain' ? value : undefined
}

export function forcedShortForm(toolName: string): boolean | undefined {
  const forced = toolName === EDIT_TOOL_NAME ? forcedEditForm() : undefined
  return forced === undefined ? undefined : forced === 'plain'
}

export function editFormCacheMark(): string {
  const forced = forcedEditForm()
  return forced === undefined ? '' : `:edit-${forced}`
}
