import { existsSync } from 'node:fs'
import { expandPath } from '../../utils/path.js'

export interface ReadQueryTarget {
  source: string
  suffix: string
  parameters: Record<string, string>
}

const TERMINAL_KEYS = new Set(['q', 'query', 'sql', 'compare'])
const MODIFIERS = new Set(['raw', 'compact', 'offset', 'limit', 'source', 'view', 'table', 'order', 'where'])

export function parseReadQueryTarget(raw: string): ReadQueryTarget | null {
  const at = raw.indexOf('#read?')
  if (at <= 0) return null
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) && existsSync(expandPath(raw))) return null
  const source = raw.slice(0, at)
  const suffix = raw.slice(at)
  const parameters: Record<string, string> = Object.create(null)
  let remaining = suffix.slice('#read?'.length)
  let recognized = false
  while (remaining !== '') {
    const equal = remaining.indexOf('=')
    if (equal < 0) break
    const amp = remaining.indexOf('&')
    if (amp >= 0 && amp < equal) {
      remaining = remaining.slice(amp + 1)
      continue
    }
    const key = remaining.slice(0, equal)
    if (TERMINAL_KEYS.has(key)) {
      parameters[key] = remaining.slice(equal + 1)
      recognized = true
      break
    }
    if (MODIFIERS.has(key)) {
      parameters[key] = remaining.slice(equal + 1, amp < 0 ? undefined : amp)
      recognized = true
    }
    if (amp < 0) break
    remaining = remaining.slice(amp + 1)
  }
  return recognized ? { source, suffix, parameters } : null
}

export function formatReadQueryTarget(source: string, parameters: Readonly<Record<string, string>>): string {
  const entries = Object.entries(parameters)
  const terminal = entries.find(([key]) => TERMINAL_KEYS.has(key))
  const modifiers = entries.filter(([key]) => !TERMINAL_KEYS.has(key)).map(([key, value]) => `${key}=${value}`)
  if (terminal) modifiers.push(`${terminal[0]}=${terminal[1]}`)
  return `${source}#read?${modifiers.join('&')}`
}
