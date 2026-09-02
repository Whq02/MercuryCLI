import { relative } from 'node:path'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getCwd } from '../../utils/cwd.js'

/**
 * Human-readable formatting of LSP responses: pure functions from a
 * (possibly null) response to display text, with all line and character
 * numbers converted to 1-based, plus the deterministic workspace-symbol
 * bounding. Malformed entries degrade loudly (placeholder + debug warning),
 * never silently.
 */

// ── protocol shapes (structural — the wire is the contract) ────────────────

type Position = { line: number; character: number }
type Range = { start: Position; end: Position }
type Location = { uri: string; range: Range }
type LocationLink = {
  targetUri: string
  targetRange: Range
  targetSelectionRange?: Range
}
type MarkupContent = { kind?: string; value: string }
type MarkedString = string | { language: string; value: string }
type HoverResult = {
  contents: MarkupContent | MarkedString | Array<MarkupContent | MarkedString>
  range?: Range
}
type DocumentSymbol = {
  name: string
  kind: number
  detail?: string
  range: Range
  selectionRange?: Range
  children?: DocumentSymbol[]
}
type SymbolInformation = {
  name: string
  kind: number
  location?: Location
  containerName?: string
}
type CallHierarchyItem = {
  name: string
  kind: number
  uri?: string
  range: Range
  selectionRange?: Range
  detail?: string
}
type IncomingCall = { from?: CallHierarchyItem; fromRanges?: Range[] }
type OutgoingCall = { to?: CallHierarchyItem; fromRanges?: Range[] }

export type Locationish = Location | LocationLink

const UNKNOWN_LOCATION = '<unknown location>'

// ── symbol kinds (contract data: the LSP SymbolKind numeric values) ────────

const SYMBOL_KINDS: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
}

function symbolKindName(kind: number): string {
  return SYMBOL_KINDS[kind] ?? 'Unknown'
}

// ── paths and URIs ─────────────────────────────────────────────────────────

/** file:// URI → path: prefix strip, Windows-drive slash drop, decode with
 *  an undecoded fallback. */
export function uriToPath(uri: string): string {
  let path = uri.startsWith('file://') ? uri.slice('file://'.length) : uri
  // DECODE FIRST (FC-052): pyright publishes file:///c%3A/… — the drive
  // colon percent-encoded — so stripping the drive slash BEFORE decoding
  // could never match, and every go-to-definition/find-references location
  // rendered as an unopenable /c:/… path. Decode, then strip.
  try {
    path = decodeURIComponent(path)
  } catch {
    /* undecodable spellings pass through raw */
  }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return path
}

/**
 * Display form: relative to the working directory only when strictly
 * shorter and not opening with two levels of parent traversal; separators
 * normalised to forward slashes either way.
 */
function displayPath(absolutePath: string, workingDirectory?: string): string {
  const cwd = workingDirectory ?? getCwd()
  const rel = relative(cwd, absolutePath)
  const chosen = rel.length < absolutePath.length && !rel.startsWith(`..${'/'}..`) && !rel.startsWith('..\\..') ? rel : absolutePath
  return chosen.split('\\').join('/')
}

function locationParts(location: Locationish): { uri?: string; range?: Range } {
  if ('targetUri' in location) {
    return { uri: location.targetUri, range: location.targetSelectionRange ?? location.targetRange }
  }
  return { uri: location.uri, range: location.range }
}

function formatLocation(location: Locationish, workingDirectory?: string): string {
  const { uri, range } = locationParts(location)
  if (!uri) {
    logForDebugging('LSP formatter: location with no URI')
    return UNKNOWN_LOCATION
  }
  const path = displayPath(uriToPath(uri), workingDirectory)
  if (!range) return path
  return `${path}:${range.start.line + 1}:${range.start.character + 1}`
}

/** Locations with a defined URI, error-logged when malformed at this level. */
function validLocations(locations: Locationish[]): Locationish[] {
  const valid: Locationish[] = []
  for (const location of locations) {
    const { uri } = locationParts(location)
    if (uri === undefined) {
      logError(new Error('LSP result contained a location with no URI'))
      continue
    }
    valid.push(location)
  }
  return valid
}

// ── workspace-symbol bounding ──────────────────────────────────────────────

/**
 * Deterministic bounding: dedupe on (name, uri, start line, start
 * character), sort by name → uri → start line, cap at the limit with a
 * floor of one, and report the truncation honestly.
 */
export function boundWorkspaceSymbols(
  symbols: SymbolInformation[],
  limit: number,
): { shown: SymbolInformation[]; total: number; truncated: boolean } {
  const seen = new Set<string>()
  const deduped: SymbolInformation[] = []
  for (const symbol of symbols) {
    const start = symbol.location?.range?.start
    const key = `${symbol.name}\u0000${symbol.location?.uri ?? ''}\u0000${start?.line ?? -1}\u0000${start?.character ?? -1}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(symbol)
  }
  deduped.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    const uriA = a.location?.uri ?? ''
    const uriB = b.location?.uri ?? ''
    if (uriA !== uriB) return uriA < uriB ? -1 : 1
    return (a.location?.range?.start?.line ?? 0) - (b.location?.range?.start?.line ?? 0)
  })
  const cap = Math.max(1, limit)
  const shown = deduped.slice(0, cap)
  return { shown, total: deduped.length, truncated: deduped.length > shown.length }
}

// ── formatters ─────────────────────────────────────────────────────────────

export function formatGoToDefinitionResult(
  result: Locationish | Locationish[] | null,
  workingDirectory?: string,
): string {
  const list = result === null ? [] : Array.isArray(result) ? result : [result]
  const valid = validLocations(list)
  if (valid.length === 0) {
    return 'No definition found. The cursor may not be on a symbol, or the definition may be in an external library that is not indexed.'
  }
  if (valid.length === 1) {
    return `Defined in ${formatLocation(valid[0]!, workingDirectory)}`
  }
  const lines = [`Found ${valid.length} definitions:`]
  for (const location of valid) {
    lines.push(`  ${formatLocation(location, workingDirectory)}`)
  }
  return lines.join('\n')
}

export function formatFindReferencesResult(
  result: Location[] | null,
  workingDirectory?: string,
): string {
  const valid = validLocations(result ?? []) as Location[]
  if (valid.length === 0) {
    return 'No references found. The symbol may have no usages, or the workspace may not be fully indexed yet.'
  }
  if (valid.length === 1) {
    return `Found 1 reference:\n  ${formatLocation(valid[0]!, workingDirectory)}`
  }
  const byFile = new Map<string, Location[]>()
  for (const location of valid) {
    const path = displayPath(uriToPath(location.uri), workingDirectory)
    const list = byFile.get(path) ?? []
    list.push(location)
    byFile.set(path, list)
  }
  const lines = [`Found ${valid.length} references in ${byFile.size} files:`]
  for (const [path, locations] of byFile) {
    lines.push('', `${path}:`)
    for (const location of locations) {
      lines.push(
        `  Line ${location.range.start.line + 1}:${location.range.start.character + 1}`,
      )
    }
  }
  return lines.join('\n')
}

function extractMarkup(contents: HoverResult['contents']): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map(part => extractMarkup(part)).join('\n\n')
  }
  if ('value' in contents) return contents.value
  return ''
}

export function formatHoverResult(result: HoverResult | null, _workingDirectory?: string): string {
  if (!result || !result.contents) {
    return 'No hover information available. The cursor may not be on a symbol, or the server may not provide hover for this position.'
  }
  const text = extractMarkup(result.contents)
  if (result.range) {
    return `Hover information at line ${result.range.start.line + 1}, character ${result.range.start.character + 1}:\n\n${text}`
  }
  return text
}

function formatDocumentSymbolTree(symbols: DocumentSymbol[], depth: number): string[] {
  const lines: string[] = []
  for (const symbol of symbols) {
    const indent = '  '.repeat(depth)
    const detail = symbol.detail ? ` ${symbol.detail}` : ''
    lines.push(
      `${indent}${symbol.name} (${symbolKindName(symbol.kind)})${detail} - line ${symbol.range.start.line + 1}`,
    )
    if (symbol.children && symbol.children.length > 0) {
      lines.push(...formatDocumentSymbolTree(symbol.children, depth + 1))
    }
  }
  return lines
}

export function formatDocumentSymbolResult(
  result: Array<DocumentSymbol | SymbolInformation> | null,
  workingDirectory?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found. The file may be empty, the server may not support document symbols, or the file may not be indexed yet.'
  }
  // The response may legally be hierarchical or flat; detect from the first
  // entry and delegate the flat shape to the workspace-symbol formatter.
  const first = result[0] as SymbolInformation & DocumentSymbol
  if (first.location !== undefined) {
    return formatWorkspaceSymbolResult(result as SymbolInformation[], workingDirectory)
  }
  const lines = ['Document symbols:']
  lines.push(...formatDocumentSymbolTree(result as DocumentSymbol[], 1))
  return lines.join('\n')
}

export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  workingDirectory?: string,
): string {
  const valid = (result ?? []).filter(symbol => {
    if (symbol.location?.uri === undefined) {
      logForDebugging('LSP formatter: workspace symbol with no location URI')
      return false
    }
    return true
  })
  if (valid.length === 0) {
    return 'No symbols found in the workspace. The workspace may be empty or indexing may not have completed.'
  }
  const byFile = new Map<string, SymbolInformation[]>()
  for (const symbol of valid) {
    const path = displayPath(uriToPath(symbol.location!.uri), workingDirectory)
    const list = byFile.get(path) ?? []
    list.push(symbol)
    byFile.set(path, list)
  }
  const lines = [`Found ${valid.length} ${valid.length === 1 ? 'symbol' : 'symbols'}:`]
  for (const [path, symbols] of byFile) {
    lines.push('', `${path}:`)
    for (const symbol of symbols) {
      const container = symbol.containerName ? ` in ${symbol.containerName}` : ''
      lines.push(
        `  ${symbol.name} (${symbolKindName(symbol.kind)})${container} - line ${(symbol.location!.range?.start?.line ?? 0) + 1}`,
      )
    }
  }
  return lines.join('\n')
}

function formatHierarchyItem(item: CallHierarchyItem, workingDirectory?: string): string {
  const detail = item.detail ? ` [${item.detail}]` : ''
  if (!item.uri) {
    logForDebugging('LSP formatter: call-hierarchy item with no URI')
    return `${item.name} (${symbolKindName(item.kind)}) ${UNKNOWN_LOCATION}${detail}`
  }
  const path = displayPath(uriToPath(item.uri), workingDirectory)
  return `${item.name} (${symbolKindName(item.kind)}) ${path}:${item.range.start.line + 1}${detail}`
}

export function formatPrepareCallHierarchyResult(
  result: CallHierarchyItem[] | null,
  workingDirectory?: string,
): string {
  if (!result || result.length === 0) {
    return 'No call-hierarchy item found at this position.'
  }
  if (result.length === 1) {
    return `Call hierarchy item: ${formatHierarchyItem(result[0]!, workingDirectory)}`
  }
  const lines = [`Call-hierarchy items at this position (${result.length}):`]
  for (const item of result) {
    lines.push(`  ${formatHierarchyItem(item, workingDirectory)}`)
  }
  return lines.join('\n')
}

function formatCalls(
  calls: Array<IncomingCall | OutgoingCall>,
  direction: 'incoming' | 'outgoing',
  workingDirectory?: string,
): string {
  const entries = calls
    .map(call => {
      const item = 'from' in call ? call.from : (call as OutgoingCall).to
      if (!item) {
        logForDebugging(`LSP formatter: ${direction} call entry missing its item`)
        return null
      }
      return { item, ranges: call.fromRanges ?? [] }
    })
    .filter((entry): entry is { item: CallHierarchyItem; ranges: Range[] } => entry !== null)
  if (entries.length === 0) {
    return direction === 'incoming'
      ? 'No incoming calls: nothing in the indexed workspace calls this symbol.'
      : 'No outgoing calls: this symbol calls nothing the server can resolve.'
  }
  const label = direction === 'incoming' ? 'callers' : 'callees'
  const sites = direction === 'incoming' ? 'calls at' : 'called from'
  const byFile = new Map<string, Array<{ item: CallHierarchyItem; ranges: Range[] }>>()
  for (const entry of entries) {
    const path = entry.item.uri
      ? displayPath(uriToPath(entry.item.uri), workingDirectory)
      : UNKNOWN_LOCATION
    const list = byFile.get(path) ?? []
    list.push(entry)
    byFile.set(path, list)
  }
  const lines = [`Found ${entries.length} ${label}:`]
  for (const [path, list] of byFile) {
    lines.push('', `${path}:`)
    for (const { item, ranges } of list) {
      const rangeText =
        ranges.length > 0
          ? ` (${sites} ${ranges.map(range => `${range.start.line + 1}:${range.start.character + 1}`).join(', ')})`
          : ''
      lines.push(
        `  ${item.name} (${symbolKindName(item.kind)}) - line ${item.range.start.line + 1}${rangeText}`,
      )
    }
  }
  return lines.join('\n')
}

export function formatIncomingCallsResult(
  result: IncomingCall[] | null,
  workingDirectory?: string,
): string {
  return formatCalls(result ?? [], 'incoming', workingDirectory)
}

export function formatOutgoingCallsResult(
  result: OutgoingCall[] | null,
  workingDirectory?: string,
): string {
  return formatCalls(result ?? [], 'outgoing', workingDirectory)
}
