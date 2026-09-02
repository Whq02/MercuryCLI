import { memoize } from 'lodash-es'

/**
 * Debug category filter: parsing the filter expression and deciding whether
 * a message's extracted categories pass it.
 */

export type DebugFilter = {
  include: string[]
  exclude: string[]
  isExclusive: boolean
}

/**
 * Parse a comma-separated category filter. Entries beginning with `!` are
 * exclusions. Mixing inclusive and exclusive entries is rejected silently —
 * the whole filter becomes null (show everything).
 */
export const parseDebugFilter = memoize(
  (filterString?: string): DebugFilter | null => {
    if (!filterString || filterString.trim() === '') return null
    const entries = filterString
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
    if (entries.length === 0) return null
    const exclusions = entries.filter(entry => entry.startsWith('!'))
    if (exclusions.length > 0 && exclusions.length < entries.length) {
      // Mixed inclusive/exclusive: show everything.
      return null
    }
    const isExclusive = exclusions.length === entries.length
    const names = entries.map(entry => entry.replace(/^!/, '').toLowerCase())
    return isExclusive
      ? { include: [], exclude: names, isExclusive: true }
      : { include: names, exclude: [], isExclusive: false }
  },
)

// The debug-message convention for MCP server lines; the extractor anchors
// on the quoted name.
const MCP_SERVER_PATTERN = /^MCP server ["']([^"']+)["']/

// A leading `<word>:` prefix — the bracket exclusion keeps a bracketed
// message from also producing a prefix category.
const PREFIX_PATTERN = /^([^:[]+):/

const BRACKET_PATTERN = /^\[([^\]]+)\]/

// The first-party-event marker phrase; the category is what an operator
// types in a filter.
const FIRST_PARTY_MARKER = '1p event:'

// A secondary `…: <word> type:`-style pattern, unanchored. The qualifier
// word is OPTIONAL: a `…: word:` form with no qualifier also yields the
// word — captured lazily up to the next colon, with the length/no-spaces
// guard below doing the filtering.
const SECONDARY_PATTERN = /:\s*(.+?)(?:\s+(?:type|mode|status|event))?:/

/** Extract a de-duplicated, lowercase category list from a message. */
export function extractDebugCategories(message: string): string[] {
  const categories = new Set<string>()
  const mcpMatch = MCP_SERVER_PATTERN.exec(message)
  if (mcpMatch) {
    // Checked FIRST so the generic prefix rule cannot fire on it: the two
    // rules are an if/else, never additive.
    categories.add('mcp')
    categories.add((mcpMatch[1] as string).toLowerCase())
  } else {
    const prefixMatch = PREFIX_PATTERN.exec(message)
    if (prefixMatch) {
      categories.add((prefixMatch[1] as string).trim().toLowerCase())
    }
    const bracketMatch = BRACKET_PATTERN.exec(message)
    if (bracketMatch) {
      categories.add((bracketMatch[1] as string).trim().toLowerCase())
    }
  }
  if (message.toLowerCase().includes(FIRST_PARTY_MARKER)) {
    categories.add('1p')
  }
  const secondaryMatch = SECONDARY_PATTERN.exec(message)
  if (secondaryMatch) {
    const word = (secondaryMatch[1] as string).trim().toLowerCase()
    // A crude "is this a plausible category name" guard.
    if (word.length < 30 && !word.includes(' ')) {
      categories.add(word)
    }
  }
  return [...categories]
}

/**
 * Decide whether categories pass a filter. With a filter and ZERO extracted
 * categories, hide in both modes — uncategorised output must not leak past
 * an exclusive filter.
 */
export function shouldShowDebugCategories(
  categories: string[],
  filter: DebugFilter | null,
): boolean {
  if (!filter) return true
  if (categories.length === 0) return false
  if (filter.isExclusive) {
    return categories.every(category => !filter.exclude.includes(category))
  }
  return categories.some(category => filter.include.includes(category))
}

/**
 * Convenience entry point: short-circuits on a null filter before doing any
 * extraction (extraction is regex-heavy and runs per message).
 */
export function shouldShowDebugMessage(message: string, filter: DebugFilter | null): boolean {
  if (!filter) return true
  return shouldShowDebugCategories(extractDebugCategories(message), filter)
}
