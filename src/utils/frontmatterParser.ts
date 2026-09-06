import { logForDebugging } from './debug.js'
import type { HooksSettings } from './settings/types.js'
import { parseYaml } from './yaml.js'


export type FrontmatterShell = 'bash' | 'powershell'

export type FrontmatterData = {
  'allowed-tools'?: string | string[] | null
  description?: string | null
  type?: string | null
  'argument-hint'?: string | null
  'when-to-use'?: string | null
  version?: string | null
  'hide-from-slash-command-tool'?: string | null
  model?: string | null
  skills?: string | null
  'user-invocable'?: string | null
  hooks?: HooksSettings | null
  effort?: string | number | null
  context?: 'inline' | 'fork' | null
  agent?: string | null
  paths?: string | string[] | null
  shell?: string | null
  [key: string]: unknown
}

export type ParsedMarkdown = {
  frontmatter: FrontmatterData
  content: string
  parseError?: { message: string }
}

export const FRONTMATTER_REGEX = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)---[ \t]*\r?\n?(?:[ \t]*\r?\n)?/

const YAML_SPECIAL = /[{}[\]*&#!|>%@`]|: /

function quoteSpecialValues(block: string): string {
  return block
    .split('\n')
    .map(line => {
      const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
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
      return `${key}: "${escaped}"`
    })
    .join('\n')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFrontmatter(markdown: string, sourcePath?: string): ParsedMarkdown {
  const match = FRONTMATTER_REGEX.exec(markdown)
  if (!match) return { frontmatter: {}, content: markdown }
  const block = match[1] as string
  const content = markdown.slice(match[0].length)
  let parsed: unknown
  try {
    parsed = parseYaml(block)
  } catch (firstError) {
    try {
      parsed = parseYaml(quoteSpecialValues(block))
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError)
      logForDebugging(
        `frontmatter: failed to parse${sourcePath ? ` ${sourcePath}` : ''}: ${message}`,
        { level: 'warn' },
      )
      return { frontmatter: {}, content, parseError: { message } }
    }
  }
  if (!isPlainObject(parsed)) return { frontmatter: {}, content }
  return { frontmatter: parsed as FrontmatterData, content }
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  const close = pattern.indexOf('}', open)
  if (close === -1) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const alternatives = pattern
    .slice(open + 1, close)
    .split(',')
    .map(alternative => alternative.trim())
  return alternatives.flatMap(alternative => expandBraces(`${prefix}${alternative}${suffix}`))
}

function splitOutsideBraces(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of input) {
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part.length > 0)
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

const SHELL_VALUES: readonly FrontmatterShell[] = ['bash', 'powershell']

export function parseShellFrontmatter(value: unknown, source: string): FrontmatterShell | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  const lowered = text.toLowerCase()
  if ((SHELL_VALUES as readonly string[]).includes(lowered)) return lowered as FrontmatterShell
  logForDebugging(
    `frontmatter: unrecognised shell "${text}" in ${source}; valid values are ${SHELL_VALUES.join(', ')}; falling back to bash`,
    { level: 'warn' },
  )
  return undefined
}
