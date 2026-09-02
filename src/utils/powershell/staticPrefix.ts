import { getCommandSpec, type CommandSpec } from '../bash/registry.js'
import { NEVER_SUGGEST } from './dangerousCmdlets.js'
import type { ParsedCommandElement, ParsedPowerShellCommand } from './parser.js'
import { parsePowerShellCommand } from './parser.js'
import { buildPrefix, DEPTH_RULES } from '../shell/specPrefix.js'

async function extractPrefixFromElement(element: ParsedCommandElement): Promise<string | null> {
  const name = element.name
  if (element.nameType === 'application') return null
  if (name === '') return null
  if (NEVER_SUGGEST.has(name.toLowerCase())) return null
  if (element.nameType === 'cmdlet') return name

  const classes = element.elementTypes ?? []
  if (classes[0] !== 'StringConstant') return null
  for (let i = 1; i < classes.length; i++) {
    const cls = classes[i]
    if (cls !== 'StringConstant' && cls !== 'Parameter') return null
  }

  const spec = await getCommandSpec(name.toLowerCase())
  const prefix = await buildPrefix(name, element.args, spec)

  if (!checkWordIntegrity(prefix, name, element.args, spec)) return null

  if (!prefix.includes(' ')) {
    const hasSubcommands = (spec?.subcommands?.length ?? 0) > 0
    const hasDepthRule = Object.keys(DEPTH_RULES).some(key => key === name.toLowerCase())
    if (hasSubcommands || hasDepthRule) return null
  }

  return prefix
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

function checkWordIntegrity(prefix: string, name: string, args: string[], spec: CommandSpec | null): boolean {
  const words = prefix.split(' ')
  if (words[0] !== name && words[0]?.toLowerCase() !== name.toLowerCase()) {
  }
  const prefixWords = words.slice(1)
  let cursor = 0
  for (const expected of prefixWords) {
    if (expected.includes('\\')) return false
    while (cursor < args.length) {
      const arg = args[cursor] as string
      if (arg === expected) break
      if (arg.startsWith('-')) {
        cursor++
        const next = args[cursor]
        if (
          spec &&
          next !== undefined &&
          next !== expected &&
          !next.startsWith('-') &&
          optionTakesArgument(spec, arg)
        ) {
          cursor++
        }
        continue
      }
      return false
    }
    if (cursor >= args.length) return false
    cursor++
  }
  return true
}

function wordAlignedCommonPrefix(prefixes: string[]): string {
  if (prefixes.length === 1) return prefixes[0] as string
  const wordLists = prefixes.map(p => p.split(' '))
  const first = wordLists[0] as string[]
  let common = first.length
  for (const words of wordLists) {
    let i = 0
    while (i < common && i < words.length && words[i]?.toLowerCase() === first[i]?.toLowerCase()) i++
    common = i
  }
  return first.slice(0, common).join(' ')
}

export async function getCompoundCommandPrefixesStatic(
  command: string,
  excludeSubcommand?: (element: ParsedCommandElement) => boolean,
): Promise<string[]> {
  const parsed = await parsePowerShellCommand(command)
  if (!parsed.valid) return []

  const commandElements = collectCommandAstElements(parsed)

  if (commandElements.length <= 1) {
    const single = commandElements[0] ? await extractPrefixFromElement(commandElements[0]) : null
    return single ? [single] : []
  }

  const prefixes: string[] = []
  for (const element of commandElements) {
    if (excludeSubcommand?.(element)) continue
    const prefix = await extractPrefixFromElement(element)
    if (prefix !== null) prefixes.push(prefix)
  }
  if (prefixes.length === 0) return []

  const groupOrder: string[] = []
  const groups = new Map<string, string[]>()
  for (const prefix of prefixes) {
    const rootKey = (prefix.split(' ')[0] as string).toLowerCase()
    if (!groups.has(rootKey)) {
      groups.set(rootKey, [])
      groupOrder.push(rootKey)
    }
    ;(groups.get(rootKey) as string[]).push(prefix)
  }

  const result: string[] = []
  const specCache = new Map<string, CommandSpec | null>()
  for (const rootKey of groupOrder) {
    const group = groups.get(rootKey) as string[]
    const collapsed = wordAlignedCommonPrefix(group)
    if (collapsed === '' || !collapsed.includes(' ')) {
      if (!specCache.has(rootKey)) specCache.set(rootKey, await getCommandSpec(rootKey))
      const spec = specCache.get(rootKey) ?? null
      const hasSubcommands = (spec?.subcommands?.length ?? 0) > 0
      const hasDepthRule = Object.keys(DEPTH_RULES).some(key => key === rootKey)
      if (hasSubcommands || hasDepthRule) continue
    }
    result.push(collapsed)
  }
  return result
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
