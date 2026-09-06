import { isSettingsFilePath } from '../permissions/filesystem.js'
import { validateSettingsFileContent } from './validation.js'

export function validateInputForSettingsFileEdit(
  filePath: string,
  originalContent: string,
  getUpdatedContent: () => string,
): { result: false; message: string; errorCode: number } | null {
  if (!isSettingsFilePath(filePath)) return null
  const before = validateSettingsFileContent(originalContent)
  if (!before.isValid) return null
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
