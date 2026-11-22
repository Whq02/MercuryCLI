import { getCommandSpec, type CommandSpec } from '../bash/registry.js'
import { NEVER_SUGGEST } from './dangerousCmdlets.js'
import type { ParsedCommandElement, ParsedPowerShellCommand } from './parser.js'
import { parsePowerShellCommand } from './parser.js'
import { buildPrefix, DEPTH_RULES } from '../shell/specPrefix.js'
import { notBuilt } from '../../pi/holes.js'

function optionTakesArgument(spec: CommandSpec | null, flagText: string): boolean {
  if (!spec?.options) return false
  const lower = flagText.toLowerCase()
  for (const option of spec.options) {
    const names = Array.isArray(option.name) ? option.name : [option.name]
    if (names.some(n => n.toLowerCase() === lower)) return option.args !== undefined
  }
  return false
}

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
