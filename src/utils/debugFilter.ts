import { memoize } from 'lodash-es'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


export type DebugFilter = Unbuilt

export const parseDebugFilter: Unbuilt = unbuilt('src/utils/debugFilter.ts:10')

const MCP_SERVER_PATTERN = /^MCP server ["']([^"']+)["']/

const PREFIX_PATTERN = /^([^:[]+):/

const BRACKET_PATTERN = /^\[([^\]]+)\]/

const FIRST_PARTY_MARKER = '1p event:'

const SECONDARY_PATTERN = /:\s*(.+?)(?:\s+(?:type|mode|status|event))?:/

function extractDebugCategories(message: string): string[] {
  return notBuilt('src/utils/debugFilter.ts:40')
}

function shouldShowDebugCategories(
  categories: string[],
  filter: DebugFilter | null,
): boolean {
  return notBuilt('src/utils/debugFilter.ts:69')
}

export function shouldShowDebugMessage(message: string, filter: DebugFilter | null): boolean {
  if (!filter) return true
  return shouldShowDebugCategories(extractDebugCategories(message), filter)
}
