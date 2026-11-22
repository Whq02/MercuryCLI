import { logForDebugging } from './debug.js'
import type { HooksSettings } from './settings/types.js'
import { parseYaml } from './yaml.js'
import { isRecord as isPlainObject } from './isRecord.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export type FrontmatterShell = Unbuilt

export type FrontmatterData = Unbuilt

type ParsedMarkdown = Unbuilt

export const FRONTMATTER_REGEX = /^\uFEFF?---[ \t]*\r?\n((?:[\s\S]*?\r?\n)??)[ \t]*---[ \t]*\r?\n?(?:[ \t]*\r?\n)?/

const YAML_SPECIAL = /[{}[\]*&#!|>%@`]|: |---/

function quoteSpecialValues(block: string): string {
  return block
    .split('\n')
    .map(line => {
      const cr = line.endsWith('\r') ? '\r' : ''
      const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(cr ? line.slice(0, -1) : line)
      if (!match) return line
      const key = match[1] as string
      const value = match[2] as string
      if (value === '') return line
      const alreadyQuoted =
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      if (alreadyQuoted) return line
      if (!YAML_SPECIAL.test(value)) return line
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return `${key}: "${escaped}"${cr}`
    })
    .join('\n')
}

export function parseFrontmatter(markdown: string, sourcePath?: string): ParsedMarkdown {
  return notBuilt('src/utils/frontmatterParser.ts:61')
}

function expandBraces(pattern: string): string[] {
  return notBuilt('src/utils/frontmatterParser.ts:85')
}

function splitOutsideBraces(input: string): string[] {
  return notBuilt('src/utils/frontmatterParser.ts:99')
}

export function splitPathInFrontmatter(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.flatMap(entry => (typeof entry === 'string' ? splitPathInFrontmatter(entry) : []))
  }
  if (typeof input !== 'string') return []
  return splitOutsideBraces(input).flatMap(expandBraces)
}

export function parsePositiveIntFromFrontmatter(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : parseInt(String(value), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function coerceDescriptionToString(value: unknown, componentName?: string, ownerName?: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const label = ownerName ? `${ownerName}:${componentName ?? 'unknown'}` : (componentName ?? 'unknown')
  logForDebugging(`frontmatter: invalid description for ${label} (expected a string, got ${Array.isArray(value) ? 'array' : typeof value})`, {
    level: 'warn',
  })
  return null
}

export function parseBooleanFrontmatter(value: unknown): boolean {
  return notBuilt('src/utils/frontmatterParser.ts:145')
}

export function parseShellFrontmatter(value: unknown, source: string): FrontmatterShell | undefined {
  return notBuilt('src/utils/frontmatterParser.ts:151')
}
