import { memoize } from 'lodash-es'


export type DebugFilter = {
  include: string[]
  exclude: string[]
  isExclusive: boolean
}

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
      return null
    }
    const isExclusive = exclusions.length === entries.length
    const names = entries.map(entry => entry.replace(/^!/, '').toLowerCase())
    return isExclusive
      ? { include: [], exclude: names, isExclusive: true }
      : { include: names, exclude: [], isExclusive: false }
  },
)

const MCP_SERVER_PATTERN = /^MCP server ["']([^"']+)["']/

const PREFIX_PATTERN = /^([^:[]+):/

const BRACKET_PATTERN = /^\[([^\]]+)\]/

const FIRST_PARTY_MARKER = '1p event:'

const SECONDARY_PATTERN = /:\s*(.+?)(?:\s+(?:type|mode|status|event))?:/

export function extractDebugCategories(message: string): string[] {
  const categories = new Set<string>()
  const mcpMatch = MCP_SERVER_PATTERN.exec(message)
  if (mcpMatch) {
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
    if (word.length < 30 && !word.includes(' ')) {
      categories.add(word)
    }
  }
  return [...categories]
}

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

export function shouldShowDebugMessage(message: string, filter: DebugFilter | null): boolean {
  if (!filter) return true
  return shouldShowDebugCategories(extractDebugCategories(message), filter)
}
