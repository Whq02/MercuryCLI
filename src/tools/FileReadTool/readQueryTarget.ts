import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { getCwd } from '../../utils/cwd.js'

export interface ReadQueryTarget {
  source: string
  suffix: string
  parameters: Record<string, string>
}

const TERMINAL_KEYS = new Set(['q', 'query', 'sql', 'compare'])
const MODIFIERS = new Set(['raw', 'compact', 'offset', 'limit', 'source', 'view', 'table', 'order', 'where'])

function literalExists(raw: string): boolean {
  if (process.platform === 'win32') return false
  const path = raw.trim()
  return existsSync(path.startsWith('/') ? path : path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : `${getCwd()}/${path}`)
}

export function parseReadQueryTarget(raw: string): ReadQueryTarget | null {
  let at = raw.indexOf('#read?')
  if (at <= 0) return null
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    if (literalExists(raw)) return null
    for (let candidate = raw.lastIndexOf('#read?'); candidate > at; candidate = raw.lastIndexOf('#read?', candidate - 1)) {
      if (literalExists(raw.slice(0, candidate))) { at = candidate; break }
    }
  }
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

export function jsonQueryName(path: string): boolean {
  return /\.(?:json|jsonl|ndjson)(?:(?:\.(?:bak|backup|old|orig|save|tmp|\d+))|~)*$/i.test(path)
}

export function jsonQueryDiscovery(path: string): string {
  return `To ask a question of it instead: Read(file_path: ${JSON.stringify(`${path}#read?q=<jq filter>`)})`
}
