import type { Argument, CommandSpec, Option } from '../../../platform/shell/bash/commandSpecs.js'

export const DEPTH_RULES: Record<string, number> = {
  rg: 2,
  'pre-commit': 2,
  gcloud: 4,
  'gcloud compute': 6,
  'gcloud beta': 6,
  aws: 4,
  az: 4,
  kubectl: 3,
  docker: 3,
  dotnet: 3,
  'git push': 2,
}

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

function optionHasCommandOrModuleArg(spec: CommandSpec | null, flag: string): boolean {
  const option = findOption(spec, flag)
  if (!option) return false
  return asArgList(option.args).some(arg => Boolean(arg.isCommand || arg.isModule))
}

function optionIsModuleArg(spec: CommandSpec | null, flag: string): boolean {
  const option = findOption(spec, flag)
  if (!option) return false
  return asArgList(option.args).some(arg => Boolean(arg.isModule))
}

function looksLikeFilePathOrUrl(token: string): boolean {
  if (URL_PREFIXES.some(prefix => token.startsWith(prefix))) return true
  if (token.includes('/')) return true
  const dotIndex = token.lastIndexOf('.')
  if (dotIndex > 0 && dotIndex < token.length - 1) {
    const ext = token.slice(dotIndex + 1)
    if (!ext.includes(':')) return true
  }
  return false
}

function findFirstSubcommand(args: string[], spec: CommandSpec | null): string | undefined {
  const hasSubcommands = Boolean(spec?.subcommands && spec.subcommands.length > 0)
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (!token) continue
    if (token.startsWith('-')) {
      if (!token.includes('=') && optionTakesArgument(spec, token, { hasSubcommands, next: args[i + 1] })) {
        i++
      }
      continue
    }
    return token
  }
  return undefined
}

function resolveTargetDepth(command: string, args: string[], spec: CommandSpec | null): number {
  const firstSubcommand = findFirstSubcommand(args, spec)
  const lowerCommand = command.toLowerCase()
  if (firstSubcommand !== undefined) {
    const twoWord = `${lowerCommand} ${firstSubcommand.toLowerCase()}`
    if (Object.prototype.hasOwnProperty.call(DEPTH_RULES, twoWord)) {
      return DEPTH_RULES[twoWord]!
    }
  }
  if (Object.prototype.hasOwnProperty.call(DEPTH_RULES, lowerCommand)) {
    return DEPTH_RULES[lowerCommand]!
  }
  if (!spec) return 2

  if (args.some(token => token.startsWith('-') && optionHasCommandOrModuleArg(spec, token))) {
    return 3
  }

  const subSpec = firstSubcommand !== undefined ? findSubcommandSpec(spec, firstSubcommand) : undefined
  if (subSpec) {
    const subArgs = asArgList(subSpec.args)
    if (subArgs.some(arg => arg.isCommand)) return 3
    if (subArgs.some(arg => arg.isVariadic)) return 2
    if (subSpec.subcommands && subSpec.subcommands.length > 0) return 4
    if (subArgs.length === 0) return 2
    return 3
  }

  const topArgs = asArgList(spec.args)
  const commandIndex = topArgs.findIndex(arg => arg.isCommand)
  if (commandIndex !== -1) {
    return topArgs.length === 1 ? 2 : Math.min(commandIndex + 2, 3)
  }
  const hasSubcommands = Boolean(spec.subcommands && spec.subcommands.length > 0)
  if (!hasSubcommands && topArgs.some(arg => arg.isVariadic)) return 1
  if (!hasSubcommands && topArgs.length > 0 && !topArgs[0]!.isOptional) return 2
  if (topArgs.some(arg => arg.isDangerous)) return 3
  return 2
}

export async function buildPrefix(
  command: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<string> {
  const depth = resolveTargetDepth(command, args, spec)
  const words: string[] = [command]
  const hasSubcommands = Boolean(spec?.subcommands && spec.subcommands.length > 0)
  const lowerCommand = command.toLowerCase()
  let foundSubcommand = false
  let prevWasModuleFlag = false

  for (let i = 0; i < args.length && words.length < depth; i++) {
    const token = args[i]
    if (!token) continue
    if (token.startsWith('-')) {
      if ((lowerCommand === 'python' || lowerCommand === 'python3') && token === '-c') {
        break
      }
      if (optionHasCommandOrModuleArg(spec, token)) {
        words.push(token)
        prevWasModuleFlag = token === '-m' && optionIsModuleArg(spec, token)
        continue
      }
      if (hasSubcommands && !foundSubcommand) {
        if (!token.includes('=') && optionTakesArgument(spec, token, { hasSubcommands: true, next: args[i + 1] })) {
          i++
        }
        prevWasModuleFlag = false
        continue
      }
      break
    }

    if (!prevWasModuleFlag && looksLikeFilePathOrUrl(token)) {
      break
    }
    prevWasModuleFlag = false
    words.push(token)
    if (!foundSubcommand && spec && findSubcommandSpec(spec, token)) {
      foundSubcommand = true
    }
  }

  return words.join(' ')
}
