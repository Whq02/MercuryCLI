import type { Argument, CommandSpec, Option } from '../bash/registry.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'

export const DEPTH_RULES: Record<string, number> = unbuilt('src/utils/shell/specPrefix.ts:3')

const URL_PREFIXES = ['http://', 'https://', 'ftp://']

function asArgList(args: Argument | Argument[] | undefined): Argument[] {
  if (!args) return []
  return Array.isArray(args) ? args : [args]
}

function optionNames(option: Option): string[] {
  return Array.isArray(option.name) ? option.name : [option.name]
}

function findSubcommandSpec(spec: CommandSpec, token: string): CommandSpec | undefined {
  return notBuilt('src/utils/shell/specPrefix.ts:28')
}

function findOption(spec: CommandSpec | null, flagName: string): Option | undefined {
  return notBuilt('src/utils/shell/specPrefix.ts:37')
}

function optionTakesArgument(spec: CommandSpec | null, flag: string, followedByNonFlagSubcommand: {
  hasSubcommands: boolean
  next?: string
}): boolean {
  const option = findOption(spec, flag)
  if (option) {
    return option.args !== undefined
  }
  if (!spec) return false
  if (followedByNonFlagSubcommand.hasSubcommands && followedByNonFlagSubcommand.next !== undefined) {
    const next = followedByNonFlagSubcommand.next
    if (!next.startsWith('-') && !findSubcommandSpec(spec, next)) return true
  }
  return false
}

export async function buildPrefix(
  command: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<string> {
  return notBuilt('src/utils/shell/specPrefix.ts:138')
}
