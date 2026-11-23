import { isSettingsFilePath } from '../permissions/filesystem.js'
import { validateSettingsFileContent } from './validation.js'

export function validateInputForSettingsFileEdit(
  filePath: string,
  originalContent: string,
  getUpdatedContent: () => string,
): { result: false; message: string; errorCode: number } | null {
  if (!isSettingsFilePath(filePath)) return null
  if (!validateSettingsFileContent(originalContent).isValid) return null
  const validation = validateSettingsFileContent(getUpdatedContent())
  if (validation.isValid) return null
  return {
    result: false,
    message: `The settings file would fail validation after this edit.\n${validation.error}\n\nSettings schema:\n${validation.fullSchema}\n\nDo not modify the environment.values block of a settings file unless the user explicitly asked for it.`,
    errorCode: 10,
  }
}
