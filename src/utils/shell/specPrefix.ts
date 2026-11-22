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
  const lower = token.toLowerCase()
  return spec.subcommands?.find(sub => {
    const name = sub.name as unknown
    if (Array.isArray(name)) return (name as string[]).some(n => n.toLowerCase() === lower)
    return (name as string).toLowerCase() === lower
  })
}

function findOption(spec: CommandSpec | null, flagName: string): Option | undefined {
  return spec?.options?.find(option => optionNames(option).some(n => n === flagName))
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
