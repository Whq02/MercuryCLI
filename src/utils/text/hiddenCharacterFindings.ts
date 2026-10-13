import { partiallySanitizeUnicode } from '../sanitization.js'
import {
  codePointLabel,
  describeHiddenCodePoint,
  findHiddenCodePoints,
  summarizeHiddenCodePoints,
  type HiddenCodePoint,
} from './hiddenCodePoints.js'

export type HiddenCharacterSource = 'instruction' | 'skill' | 'settings' | 'mcp'

export type HiddenCharacterRecord = {
  source: HiddenCharacterSource
  path: string
  group?: string
  findings: HiddenCodePoint[]
  removed: boolean
}

export const HIDDEN_CHARACTER_SOURCES: readonly HiddenCharacterSource[] = ['instruction', 'skill', 'settings', 'mcp']
export const HIDDEN_CHARACTER_LINE_LIMIT = 3

type Scan = { source: HiddenCharacterSource; path: string; group?: string }

const records = new Map<string, HiddenCharacterRecord>()
const scanned = new Map<string, Scan>()
const told = new Set<string>()

const keyOf = (source: HiddenCharacterSource, path: string): string => `${source}\u0000${path}`

const strippedAtDiscovery = (findings: readonly HiddenCodePoint[]): boolean =>
  findings.every(f => partiallySanitizeUnicode(String.fromCodePoint(f.codePoint)) === '')

export function recordHiddenCharacters(
  source: HiddenCharacterSource,
  path: string,
  text: string,
  options: { group?: string } = {},
): HiddenCodePoint[] {
  const findings = findHiddenCodePoints(text)
  const key = keyOf(source, path)
  const scan: Scan = { source, path, ...(options.group !== undefined ? { group: options.group } : {}) }
  scanned.set(key, scan)
  if (findings.length === 0) {
    records.delete(key)
    return findings
  }
  records.set(key, { ...scan, findings, removed: source === 'mcp' && strippedAtDiscovery(findings) })
  return findings
}

export function forgetHiddenCharacters(source: HiddenCharacterSource, where: { path?: string; group?: string } = {}): void {
  const matches = (scan: Scan): boolean =>
    scan.source === source && (where.path === undefined || scan.path === where.path) && (where.group === undefined || scan.group === where.group)
  for (const [key, scan] of scanned) if (matches(scan)) scanned.delete(key)
  for (const [key, record] of records) if (matches(record)) records.delete(key)
}

export function currentHiddenCharacterFindings(): HiddenCharacterRecord[] {
  return [...records.values()]
}

export function hiddenCharacterScanCounts(): Record<HiddenCharacterSource, number> {
  const counts: Record<HiddenCharacterSource, number> = { instruction: 0, skill: 0, settings: 0, mcp: 0 }
  for (const scan of scanned.values()) counts[scan.source]++
  return counts
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function hiddenCharacterLine(record: HiddenCharacterRecord): string {
  const count = plural(record.findings.length, 'hidden character')
  if (record.source === 'mcp') {
    const where = record.removed ? 'removed before the model read it' : 'the model reads the description as sent'
    return `MCP tool ${record.path} carried ${count} in its definition (${summarizeHiddenCodePoints(record.findings)}) — ${where}; see /health`
  }
  const shown = record.findings.slice(0, HIDDEN_CHARACTER_LINE_LIMIT).map(describeHiddenCodePoint)
  const more = record.findings.length - shown.length
  return `${record.path} carries ${count}: ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''} — loaded as written, nothing changed; see /health`
}

export function hiddenCharacterDetailLines(record: HiddenCharacterRecord): string[] {
  if (record.source === 'mcp') {
    return [`${record.path}: ${record.findings.map(f => `${f.class} (${codePointLabel(f.codePoint)})`).join(', ')}${record.removed ? ' — removed before the model read it' : ''}`]
  }
  return record.findings.map(f => `${record.path} · ${describeHiddenCodePoint(f)}`)
}

const recordKey = (record: HiddenCharacterRecord): string =>
  `${record.source}|${record.path}|${record.findings.map(f => `${f.line}:${f.column}:${f.codePoint}`).join(',')}`

export function currentHiddenCharacterLines(): string[] {
  return currentHiddenCharacterFindings().map(hiddenCharacterLine)
}

export function untoldHiddenCharacterLines(): string[] {
  const current = currentHiddenCharacterFindings()
  const present = new Set(current.map(recordKey))
  for (const key of told) if (!present.has(key)) told.delete(key)
  const fresh = current.filter(record => !told.has(recordKey(record)))
  for (const record of fresh) told.add(recordKey(record))
  return fresh.map(hiddenCharacterLine)
}

export function resetHiddenCharacterFindings(): void {
  records.clear()
  scanned.clear()
  told.clear()
}
