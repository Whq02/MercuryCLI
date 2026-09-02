/**
 * Shell-agnostic CLI-spec walker that decides how many argv words a
 * meaningful permission prefix should span, then emits them. Pure over
 * (commandName, argv, spec | null).
 */
import type { Argument, CommandSpec, Option } from '../bash/registry.js'

/**
 * Explicit depth overrides for CLIs whose specs are not loadable at run time
 * (dynamic spec loading does not work in the packaged build). Contract data.
 */
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

function subcommandNames(spec: CommandSpec): string[] {
  const names: string[] = []
  for (const sub of spec.subcommands ?? []) {
    const name = sub.name as unknown
    if (Array.isArray(name)) names.push(...(name as string[]))
    else names.push(name as string)
  }
  return names
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
    // A declared option's own answer is authoritative and final.
    return option.args !== undefined
  }
  if (!spec) return false
  // Heuristic: only when the spec declares subcommands and a following non-flag
  // non-subcommand token exists.
  if (followedByNonFlagSubcommand.hasSubcommands && followedByNonFlagSubcommand.next !== undefined) {
    const next = followedByNonFlagSubcommand.next
    if (!next.startsWith('-') && !findSubcommandSpec(spec, next)) return true
  }
  return false
}

/** Find the first subcommand token (or first non-flag with no subcommands). */
function findFirstSubcommand(argv: string[], spec: CommandSpec | null): string | undefined {
  const hasSubcommands = (spec?.subcommands?.length ?? 0) > 0
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '') continue
    if (token.startsWith('-')) {
      if (optionTakesArgument(spec, token, { hasSubcommands, next: argv[i + 1] })) i++ // skip value
      continue
    }
    if (!hasSubcommands) return token
    if (spec && findSubcommandSpec(spec, token)) return token
  }
  return undefined
}

/** Resolve the emission depth. */
function resolveDepth(command: string, argv: string[], spec: CommandSpec | null): number {
  const firstSubcommand = findFirstSubcommand(argv, spec)
  const lowerCommand = command.toLowerCase()

  // 2. Depth table: "<command> <sub>" then "<command>".
  if (firstSubcommand) {
    const combined = `${lowerCommand} ${firstSubcommand.toLowerCase()}`
    if (DEPTH_RULES[combined]) return DEPTH_RULES[combined]
  }
  if (DEPTH_RULES[lowerCommand]) return DEPTH_RULES[lowerCommand]

  // 3. No spec → 2.
  if (!spec) return 2

  // 4. A flag whose declared arg is a command/module → 3.
  for (const token of argv) {
    if (!token.startsWith('-')) continue
    const option = findOption(spec, token)
    if (option) {
      const optArgs = asArgList(option.args)
      if (optArgs.some(a => a.isCommand || a.isModule)) return 3
    }
  }

  // 5. First subcommand matches a declared subcommand.
  if (firstSubcommand) {
    const subSpec = findSubcommandSpec(spec, firstSubcommand)
    if (subSpec) {
      const subArgs = asArgList(subSpec.args)
      if (subArgs.some(a => a.isCommand)) return 3
      if (subArgs.some(a => a.isVariadic)) return 2
      if ((subSpec.subcommands?.length ?? 0) > 0) return 4
      if (subArgs.length === 0) return 2 // leaf subcommand with no args → transient 3rd word
      return 3
    }
  }

  // 6. From the spec's own top-level arguments.
  const topArgs = asArgList(spec.args)
  const firstCommandIndex = topArgs.findIndex(a => a.isCommand)
  if (firstCommandIndex !== -1) {
    if (topArgs.length === 1) return 2
    return Math.min(2 + firstCommandIndex, 3)
  }
  if ((spec.subcommands?.length ?? 0) === 0) {
    if (topArgs.some(a => a.isVariadic)) return 1
    if (topArgs[0] && !topArgs[0].isOptional) return 2
  }

  // 7. Fallback.
  return topArgs.some(a => a.isDangerous) ? 3 : 2
}

/** Whether a token has a file extension (last dot not first/last, tail no colon). */
function hasFileExtension(token: string): boolean {
  const lastDot = token.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === token.length - 1) return false
  return !token.slice(lastDot + 1).includes(':')
}

/** Whether the stop-at-argument test fires for `token` given the preceding argv. */
function stopAtArgument(token: string, precedingTokens: string[], spec: CommandSpec | null): boolean {
  if (token.startsWith('-')) return true
  const fileLike = token.includes('/') || hasFileExtension(token)
  const urlLike = URL_PREFIXES.some(prefix => token.startsWith(prefix))
  if (!fileLike && !urlLike) return false
  // Exception: `-m <module>` where the option's arg is a module.
  const prev = precedingTokens[precedingTokens.length - 1]
  if (prev === '-m') {
    const option = findOption(spec, '-m')
    if (option && asArgList(option.args).some(a => a.isModule)) return false
  }
  return true
}

/**
 * Emit the permission prefix: the command name plus as many argv words as the
 * resolved depth allows.
 */
export async function buildPrefix(
  command: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<string> {
  const depth = resolveDepth(command, args, spec)
  const hasSubcommands = (spec?.subcommands?.length ?? 0) > 0
  const words: string[] = [command]
  let foundSubcommand = false
  const consumed: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (words.length >= depth) break
    const token = args[i] as string
    if (token === '') continue

    if (token.startsWith('-')) {
      // Stop for python -c inline code.
      if (token === '-c' && (command.toLowerCase() === 'python' || command.toLowerCase() === 'python3')) {
        break
      }
      const option = findOption(spec, token)
      if (option && asArgList(option.args).some(a => a.isCommand || a.isModule)) {
        words.push(token)
        consumed.push(token)
        continue
      }
      if (hasSubcommands && !foundSubcommand) {
        // Skip the flag (and its value) to keep looking for the subcommand.
        if (optionTakesArgument(spec, token, { hasSubcommands, next: args[i + 1] })) i++
        continue
      }
      break
    }

    if (stopAtArgument(token, consumed, spec)) break
    if (hasSubcommands && !foundSubcommand && spec && findSubcommandSpec(spec, token)) {
      foundSubcommand = true
    }
    words.push(token)
    consumed.push(token)
  }

  return words.join(' ')
}
