import { getCommandSpec, type CommandSpec } from '../bash/registry.js'
import { NEVER_SUGGEST } from './dangerousCmdlets.js'
import type { ParsedCommandElement, ParsedPowerShellCommand } from './parser.js'
import { parsePowerShellCommand } from './parser.js'
import { buildPrefix, DEPTH_RULES } from '../shell/specPrefix.js'
import { notBuilt } from '../../pi/holes.js'

export async function getCompoundCommandPrefixesStatic(
  command: string,
  excludeSubcommand?: (element: ParsedCommandElement) => boolean,
): Promise<string[]> {
  return notBuilt('src/utils/powershell/staticPrefix.ts:89')
}

function collectCommandAstElements(parsed: ParsedPowerShellCommand): ParsedCommandElement[] {
  const out: ParsedCommandElement[] = []
  for (const statement of parsed.statements) {
    for (const command of statement.commands) {
      if (command.elementType === 'CommandAst') out.push(command)
    }
  }
  return out
}
