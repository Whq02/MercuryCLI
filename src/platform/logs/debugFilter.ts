import { memoize } from 'lodash-es'

export type DebugFilter = { include: string[]; exclude: string[]; isExclusive: boolean }

export const parseDebugFilter = memoize((text?: string): DebugFilter | null => {
  if (!text) return null
  const parts = text.split(',').map(part => part.trim()).filter(Boolean)
  if (!parts.length) return null
  const isExclusive = parts[0]!.startsWith('!')
  if (parts.some(part => part.startsWith('!') !== isExclusive)) return null
  const names = parts.map(part => (isExclusive ? part.slice(1) : part).toLowerCase())
  return { include: isExclusive ? [] : names, exclude: isExclusive ? names : [], isExclusive }
})

const MCP_SERVER_PATTERN = /^MCP server ["']([^"']+)["']/

const PREFIX_PATTERN = /^([^:[]+):/

const BRACKET_PATTERN = /^\[([^\]]+)\]/

const FIRST_PARTY_MARKER = '1p event:'

const SECONDARY_PATTERN = /:\s*(.+?)(?:\s+(?:type|mode|status|event))?:/

function extractDebugCategories(message: string): string[] {
  const categories = new Set<string>()
  const server = MCP_SERVER_PATTERN.exec(message)
  if (server) {
    categories.add('mcp')
    categories.add(server[1]!.toLowerCase())
  } else {
    const head = PREFIX_PATTERN.exec(message) ?? BRACKET_PATTERN.exec(message)
    if (head) categories.add(head[1]!.trim().toLowerCase())
  }
  if (message.toLowerCase().includes(FIRST_PARTY_MARKER)) categories.add('1p')
  const secondary = SECONDARY_PATTERN.exec(message)
  if (secondary) {
    const name = secondary[1]!.trim().toLowerCase()
    if (name.length < 30 && !name.includes(' ')) categories.add(name)
  }
  return [...categories]
}

function shouldShowDebugCategories(
  categories: string[],
  filter: DebugFilter | null,
): boolean {
  if (!filter) return true
  if (!categories.length) return false
  if (filter.isExclusive) return !categories.some(name => filter.exclude.includes(name))
  return categories.some(name => filter.include.includes(name))
}

export function shouldShowDebugMessage(message: string, filter: DebugFilter | null): boolean {
  if (!filter) return true
  return shouldShowDebugCategories(extractDebugCategories(message), filter)
}
