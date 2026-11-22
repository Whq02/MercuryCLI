import { notBuilt } from '../../pi/holes.js'

export function validateInputForSettingsFileEdit(
  filePath: string,
  originalContent: string,
  getUpdatedContent: () => string,
): { result: false; message: string; errorCode: number } | null {
  return notBuilt('src/utils/settings/validateEditTool.ts:4')
}
