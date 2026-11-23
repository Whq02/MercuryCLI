import { getCommandSpec, type CommandSpec } from '../../../platform/shell/bash/commandSpecs.js'
import { NEVER_SUGGEST } from '../../../platform/shell/powershell/dangerousCmdlets.js'
import type { ParsedCommandElement, ParsedPowerShellCommand } from '../../../platform/shell/powershell/parser.js'
import { parsePowerShellCommand } from '../../../platform/shell/powershell/parser.js'
import { buildPrefix, DEPTH_RULES } from './specPrefix.js'

function hasSubcommandsOrDepthRule(lowerName: string, spec: CommandSpec | null): boolean {
  if (spec?.subcommands && spec.subcommands.length > 0) return true
  return Object.hasOwn(DEPTH_RULES, lowerName)
}

function verifyWordIntegrity(
  prefix: string,
  args: string[],
  spec: CommandSpec | null,
): boolean {
  const words = prefix.split(' ')
  if (words.length <= 1) return true
  const expected = words.slice(1)
  let argIdx = 0
  for (let i = 0; i < expected.length; i++) {
    const target = expected[i]!
    if (target.includes('\\')) return false
    let matched = false
    while (argIdx < args.length) {
      const arg = args[argIdx]!
      if (arg === '') {
        argIdx++
        continue
      }
      if (arg === target) {
        argIdx++
        matched = true
        break
      }
      if (i === 0 && arg.startsWith('-')) {
        argIdx += optionTakesArgument(spec, arg) ? 2 : 1
        continue
      }
      return false
    }
    if (!matched) return false
  }
  return true
}

function hasStaticElementTypes(element: ParsedCommandElement): boolean {
  const types = element.elementTypes
  if (!types || types.length === 0 || types[0] !== 'StringConstant') return false
  for (let i = 1; i < types.length; i++) {
    const type = types[i]
    if (type !== 'StringConstant' && type !== 'Parameter') return false
  }
  return true
}

async function loadSpec(
  lowerName: string,
  cache: Map<string, CommandSpec | null>,
): Promise<CommandSpec | null> {
  if (cache.has(lowerName)) return cache.get(lowerName) ?? null
  const spec = await getCommandSpec(lowerName)
  cache.set(lowerName, spec)
  return spec
}

async function extractElementPrefix(
  element: ParsedCommandElement,
  specCache: Map<string, CommandSpec | null>,
): Promise<string | null> {
  const name = element.name
  if (element.nameType === 'application' || !name) return null
  const lowerName = name.toLowerCase()
  if (NEVER_SUGGEST.has(lowerName)) return null
  if (element.nameType === 'cmdlet') return name
  if (!hasStaticElementTypes(element)) return null

  const spec = await loadSpec(lowerName, specCache)
  const prefix = await buildPrefix(name, element.args, spec)
  if (!verifyWordIntegrity(prefix, element.args, spec)) return null
  if (!prefix.includes(' ') && hasSubcommandsOrDepthRule(lowerName, spec)) return null
  return prefix
}

function commonWordPrefix(prefixes: string[]): string {
  let common = prefixes[0]!.split(' ')
  for (let i = 1; i < prefixes.length; i++) {
    const words = prefixes[i]!.split(' ')
    let k = 0
    while (
      k < common.length &&
      k < words.length &&
      common[k]!.toLowerCase() === words[k]!.toLowerCase()
    ) {
      k++
    }
    common = common.slice(0, k)
    if (common.length === 0) break
  }
  return common.join(' ')
}

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
  const parsed = await parsePowerShellCommand(command)
  if (!parsed.valid) return []

  const elements = collectCommandAstElements(parsed)
  if (elements.length === 0) return []

  const specCache = new Map<string, CommandSpec | null>()
  if (elements.length === 1) {
    const single = await extractElementPrefix(elements[0]!, specCache)
    return single ? [single] : []
  }

  const groups = new Map<string, string[]>()
  for (const element of elements) {
    if (excludeSubcommand?.(element)) continue
    const prefix = await extractElementPrefix(element, specCache)
    if (!prefix) continue
    const rootLower = prefix.split(' ')[0]!.toLowerCase()
    const list = groups.get(rootLower)
    if (list) list.push(prefix)
    else groups.set(rootLower, [prefix])
  }

  const out: string[] = []
  for (const [rootLower, prefixes] of groups) {
    const collapsed = commonWordPrefix(prefixes)
    if (!collapsed) continue
    if (!collapsed.includes(' ')) {
      const spec = await loadSpec(rootLower, specCache)
      if (hasSubcommandsOrDepthRule(rootLower, spec)) continue
    }
    out.push(collapsed)
  }
  return out
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
