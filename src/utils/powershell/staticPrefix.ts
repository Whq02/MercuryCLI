/**
 * Derives a suggested permission-rule prefix from a parsed PowerShell command,
 * for the permission dialog's editable "don't ask again for" field. Returning
 * nothing is always acceptable; returning something too broad is a failure.
 *
 * The single-command static entry is omitted (operator drop-dead ruling,
 * only the compound entry is consumed); its logic lives inline.
 */
import { getCommandSpec, type CommandSpec } from '../bash/registry.js'
import { NEVER_SUGGEST } from './dangerousCmdlets.js'
import type { ParsedCommandElement, ParsedPowerShellCommand } from './parser.js'
import { parsePowerShellCommand } from './parser.js'
import { buildPrefix, DEPTH_RULES } from '../shell/specPrefix.js'

/** Extract a prefix from one parsed command element (or null). */
async function extractPrefixFromElement(element: ParsedCommandElement): Promise<string | null> {
  const name = element.name
  // 1. Application → null (PowerShell runs a file).
  if (element.nameType === 'application') return null
  // 2. No name → null.
  if (name === '') return null
  // 3. Never-suggest → null.
  if (NEVER_SUGGEST.has(name.toLowerCase())) return null
  // 4. Cmdlet → the name alone (original casing).
  if (element.nameType === 'cmdlet') return name

  // 5. External command: guard the argv before consulting the spec.
  const classes = element.elementTypes ?? []
  if (classes[0] !== 'StringConstant') return null
  for (let i = 1; i < classes.length; i++) {
    const cls = classes[i]
    if (cls !== 'StringConstant' && cls !== 'Parameter') return null
  }

  // 6. Look up the spec by lowercased name; call the walker unconditionally.
  const spec = await getCommandSpec(name.toLowerCase())
  const prefix = await buildPrefix(name, element.args, spec)

  // 7. Word-integrity check on the result.
  if (!checkWordIntegrity(prefix, name, element.args, spec)) return null

  // 8. Bare-root guard.
  if (!prefix.includes(' ')) {
    const hasSubcommands = (spec?.subcommands?.length ?? 0) > 0
    const hasDepthRule = Object.keys(DEPTH_RULES).some(key => key === name.toLowerCase())
    if (hasSubcommands || hasDepthRule) return null
  }

  return prefix
}

/** Whether a spec declares an option (lowercased) that takes an argument. */
function optionTakesArgument(spec: CommandSpec | null, flagText: string): boolean {
  if (!spec?.options) return false
  const lower = flagText.toLowerCase()
  for (const option of spec.options) {
    const names = Array.isArray(option.name) ? option.name : [option.name]
    if (names.some(n => n.toLowerCase() === lower)) return option.args !== undefined
  }
  return false
}

/** Walk the prefix words after the root against a cursor into the arguments. */
function checkWordIntegrity(prefix: string, name: string, args: string[], spec: CommandSpec | null): boolean {
  const words = prefix.split(' ')
  if (words[0] !== name && words[0]?.toLowerCase() !== name.toLowerCase()) {
    // The root should equal the command name; a divergence is unexpected.
  }
  const prefixWords = words.slice(1)
  let cursor = 0
  for (const expected of prefixWords) {
    // Reject any prefix word containing a backslash first.
    if (expected.includes('\\')) return false
    while (cursor < args.length) {
      const arg = args[cursor] as string
      if (arg === expected) break
      if (arg.startsWith('-')) {
        cursor++
        // Skip its value only when spec-declared arg-taking (fail-safe otherwise).
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
      // A non-dash argument that is not the expected word → split.
      return false
    }
    if (cursor >= args.length) return false // ran out before the expected word
    cursor++ // consume the matched argument
  }
  return true
}

/** The word-aligned longest common prefix of a group (case-insensitive compare). */
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

/**
 * The compound entry point: for a command with several invocations, return a
 * list of suggested prefixes. The exclusion predicate receives the PARSED
 * element (not text).
 */
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

  // Collapse by root (case-insensitive key, first-seen casing + order).
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
      // Guard the collapse: drop the group if the root has subcommands/depth rule.
      if (!specCache.has(rootKey)) specCache.set(rootKey, await getCommandSpec(rootKey))
      const spec = specCache.get(rootKey) ?? null
      const hasSubcommands = (spec?.subcommands?.length ?? 0) > 0
      const hasDepthRule = Object.keys(DEPTH_RULES).some(key => key === rootKey)
      if (hasSubcommands || hasDepthRule) continue // drop the group
    }
    result.push(collapsed)
  }
  return result
}

/** Collect elements whose kind is CommandAst (skip synthetic entries). */
function collectCommandAstElements(parsed: ParsedPowerShellCommand): ParsedCommandElement[] {
  const out: ParsedCommandElement[] = []
  for (const statement of parsed.statements) {
    for (const command of statement.commands) {
      if (command.elementType === 'CommandAst') out.push(command)
    }
  }
  return out
}
