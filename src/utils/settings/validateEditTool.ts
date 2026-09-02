import { isClaudeSettingsPath } from '../permissions/filesystem.js'
import { validateSettingsFileContent } from './validation.js'

/**
 * Guard blocking a file edit that would break a currently-valid settings
 * file. Not a settings file, a currently-invalid file (the user may be
 * fixing it), or a still-valid result all pass. Error code 10 is contract
 * data — the tool layer matches it.
 */
export function validateInputForSettingsFileEdit(
  filePath: string,
  originalContent: string,
  getUpdatedContent: () => string,
): { result: false; message: string; errorCode: number } | null {
  if (!isClaudeSettingsPath(filePath)) return null
  const before = validateSettingsFileContent(originalContent)
  if (!before.isValid) return null
  // Only computed when the before-state was valid.
  const after = validateSettingsFileContent(getUpdatedContent())
  if (after.isValid) return null
  return {
    result: false,
    message:
      `The settings file would fail validation after this edit.\n${after.error}\n\n` +
      `Settings schema:\n${after.fullSchema}\n\n` +
      'Do not modify the env block of a settings file unless the user explicitly asked for it.',
    errorCode: 10,
  }
}
