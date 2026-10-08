import { parseForSecurity } from '../../src/utils/permissions/decision/commandAnalysis.js'
import { checkPathConstraints as pathCheck } from '../../src/tools/BashTool/pathValidation.js'
import { bashToolCheckPermission as commandCheck } from '../../src/tools/BashTool/bashPermissions.js'

export async function checkParsedPaths(...args: Parameters<typeof pathCheck>): Promise<ReturnType<typeof pathCheck>> {
  const parsed = await parseForSecurity(args[0].command)
  if (parsed.kind === 'simple') {
    args[4] = parsed.commands.flatMap(command => command.redirects)
    args[5] = parsed.commands
  }
  return pathCheck(...args)
}

export async function checkParsedCommand(...args: Parameters<typeof commandCheck>): Promise<ReturnType<typeof commandCheck>> {
  const parsed = await parseForSecurity(args[0].command)
  if (parsed.kind === 'simple' && parsed.commands.length === 1) args[3] = parsed.commands[0]
  return commandCheck(...args)
}
