import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { openFilesMenu } from '../../utils/cockpit/filesMenu.js'

export const call = async (_args: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  openFilesMenu()
  return { type: 'skip' }
}
