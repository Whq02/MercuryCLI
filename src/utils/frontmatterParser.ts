import { logForDebugging } from './debug.js'
import type { HooksSettings } from './settings/types.js'
import { parseYaml } from './yaml.js'
import { isRecord as isPlainObject } from './isRecord.js'

const SHELL_VALUES = ['bash', 'powershell'] as const

export type FrontmatterShell = (typeof SHELL_VALUES)[number]

export type FrontmatterData = {
  [key: string]: unknown
  'allowed-tools'?: string | string[] | null
  paths?: string | string[] | null
  globs?: string | string[] | null
  description?: string | null
  type?: string | null
  'argument-hint'?: string | null
  'when-to-use'?: string | null
  version?: string | null
  'hide-from-slash-command-tool'?: string | null
  model?: string | null
  skills?: string | null
  'user-invocable'?: string | null
  agent?: string | null
  shell?: string | null
  hooks?: HooksSettings | null
  effort?: string | number | null
  context?: 'inline' | 'fork' | null
}

type ParsedMarkdown = {
  frontmatter: FrontmatterData
  content: string
  parseError?: { message: string }
}

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
  const match = FRONTMATTER_REGEX.exec(markdown)
  if (!match) return { frontmatter: {}, content: markdown }
  const block = match[1] ?? ''
  const content = markdown.slice(match[0].length)
  let data: unknown
  try {
    data = parseYaml(block)
  } catch {
    try {
      data = parseYaml(quoteSpecialValues(block))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logForDebugging(`frontmatter: failed to parse${sourcePath ? ` ${sourcePath}` : ''}: ${message}`, { level: 'warn' })
      return { frontmatter: {}, content, parseError: { message } }
    }
  }
  return { frontmatter: isPlainObject(data) ? data : {}, content }
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  const close = pattern.indexOf('}', open + 1)
  if (open < 0 || close < 0) return [pattern]
  return pattern.slice(open + 1, close).split(',').flatMap(part =>
    expandBraces(pattern.slice(0, open) + part.trim() + pattern.slice(close + 1)),
  )
}

function splitOutsideBraces(input: string): string[] {
  const pieces: string[] = []
  let start = 0
  let depth = 0
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '{') depth++
    else if (input[i] === '}') depth = Math.max(0, depth - 1)
    else if (input[i] === ',' && depth === 0) {
      pieces.push(input.slice(start, i).trim())
      start = i + 1
    }
  }
  pieces.push(input.slice(start).trim())
  return pieces.filter(Boolean)
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
  return value === true || value === 'true'
}

export function parseShellFrontmatter(value: unknown, source: string): FrontmatterShell | undefined {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const lower = text.toLowerCase()
  const shell = SHELL_VALUES.find(word => word === lower)
  if (!shell) {
    logForDebugging(`frontmatter: unrecognised shell "${text}" in ${source}; valid values are ${SHELL_VALUES.join(', ')}; falling back to bash`, { level: 'warn' })
  }
  return shell
}
