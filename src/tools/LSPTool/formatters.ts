import { isAbsolute, relative } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { controlCharacterPathRefusal } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { readFileInRange } from '../../utils/readFileInRange.js'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getCwd } from '../../utils/cwd.js'
import { passedOver } from '../../utils/passedOver.js'


type Position = { line: number; character: number }
type Range = { start: Position; end: Position }
export type Location = { uri: string; range: Range }
type LocationLink = {
  targetUri: string
  targetRange: Range
  targetSelectionRange?: Range
}
type MarkupContent = { kind?: string; value: string }
type MarkedString = string | { language: string; value: string }
export type HoverResult = {
  contents: MarkupContent | MarkedString | Array<MarkupContent | MarkedString>
  range?: Range
}
export type DocumentSymbol = {
  name: string
  kind: number
  detail?: string
  range: Range
  selectionRange?: Range
  children?: DocumentSymbol[]
}
export type SymbolInformation = {
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
export type IncomingCall = { from?: CallHierarchyItem; fromRanges?: Range[] }
export type OutgoingCall = { to?: CallHierarchyItem; fromRanges?: Range[] }

export type Locationish = Location | LocationLink

const UNKNOWN_LOCATION = '<unknown location>'


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


export function uriToPath(uri: string): string {
  let path = uri.startsWith('file://') ? uri.slice('file://'.length) : uri
  try {
    path = decodeURIComponent(path)
  } catch (error) {
    passedOver(error)
  }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return path
}

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

export async function readLocationSourceLines(locations: Locationish[], tool: Pick<Tool, 'name' | 'getPath'>, context: ToolUseContext): Promise<Map<Locationish, string>> {
  const snippets = new Map<Locationish, string>()
  const reads = new Map<string, string>()
  for (const location of validLocations(locations).slice(0, 50)) {
    const { uri, range } = locationParts(location)
    const line = range?.start.line
    if (!uri || !Number.isInteger(line) || line! < 0 || (!uri.startsWith('file://') && !isAbsolute(uri))) continue
    const filePath = uriToPath(uri)
    if (controlCharacterPathRefusal(filePath)) continue
    if (checkReadPermissionForTool(tool, { filePath }, context.getAppState().toolPermissionContext).behavior !== 'allow') continue
    const key = `${filePath}\u0000${line}`
    try {
      if (!reads.has(key)) {
        const info = await stat(filePath)
        if (!info.isFile() || info.size > 10_000_000) continue
        const read = await readFileInRange(filePath, line, 1, undefined, context.abortController.signal)
        reads.set(key, read.content.trim().slice(0, 160))
      }
      const text = reads.get(key)!
      if (text) snippets.set(location, text)
    } catch {
      if (context.abortController.signal.aborted) throw context.abortController.signal.reason
    }
  }
  return snippets
}

const MAX_DISPLAY_ENTRIES = 50

export function formatGoToDefinitionResult(
  result: Locationish | Locationish[] | null,
  workingDirectory?: string,
  sourceLines?: ReadonlyMap<Locationish, string>,
): string {
  const list = result === null ? [] : Array.isArray(result) ? result : [result]
  const valid = validLocations(list)
  if (valid.length === 0) {
    return 'No definition found. The cursor may not be on a symbol, or the definition may be in an external library that is not indexed.'
  }
  if (valid.length === 1) {
    const loc = valid[0]!
    const snippet = sourceLines?.get(loc)
    return `Defined in ${formatLocation(loc, workingDirectory)}${snippet ? `\n    ${snippet}` : ''}`
  }
  const lines: string[] = [`Found ${valid.length} definitions:`]
  for (const loc of valid.slice(0, MAX_DISPLAY_ENTRIES)) {
    lines.push(`  ${formatLocation(loc, workingDirectory)}`)
    const snippet = sourceLines?.get(loc)
    if (snippet) lines.push(`    ${snippet}`)
  }
  if (valid.length > MAX_DISPLAY_ENTRIES) {
    lines.push(`${valid.length - MAX_DISPLAY_ENTRIES} more definitions.`)
  }
  return lines.join('\n')
}

export function formatFindReferencesResult(
  result: Location[] | null,
  workingDirectory?: string,
  sourceLines?: ReadonlyMap<Locationish, string>,
): string {
  const valid = validLocations(result ?? []) as Location[]
  if (valid.length === 0) {
    return 'No references found. The symbol may have no usages, or the workspace may not be fully indexed yet.'
  }
  if (valid.length === 1) {
    const loc = valid[0]!
    const snippet = sourceLines?.get(loc)
    return `Found 1 reference:\n  ${formatLocation(loc, workingDirectory)}${snippet ? `\n    ${snippet}` : ''}`
  }
  const uniqueFiles = new Set(valid.map(loc => displayPath(uriToPath(loc.uri), workingDirectory)))
  const grouped = new Map<string, Location[]>()
  for (const loc of valid.slice(0, MAX_DISPLAY_ENTRIES)) {
    const file = displayPath(uriToPath(loc.uri), workingDirectory)
    const entries = grouped.get(file)
    if (entries) entries.push(loc)
    else grouped.set(file, [loc])
  }
  const lines: string[] = [
    `Found ${valid.length} references in ${uniqueFiles.size} ${uniqueFiles.size === 1 ? 'file' : 'files'}:`,
  ]
  for (const [file, locs] of grouped) {
    lines.push('')
    lines.push(`${file}:`)
    for (const loc of locs) {
      lines.push(`  Line ${loc.range.start.line + 1}:${loc.range.start.character + 1}`)
      const snippet = sourceLines?.get(loc)
      if (snippet) lines.push(`    ${snippet}`)
    }
  }
  if (valid.length > MAX_DISPLAY_ENTRIES) {
    lines.push(`${valid.length - MAX_DISPLAY_ENTRIES} more references.`)
  }
  return lines.join('\n')
}

function extractHoverContents(contents: HoverResult['contents']): string {
  if (typeof contents === 'string') return contents.trim()
  if (Array.isArray(contents)) {
    return contents
      .map(item => (typeof item === 'string' ? item : item.value).trim())
      .filter(part => part.length > 0)
      .join('\n\n')
  }
  return contents.value.trim()
}

export function formatHoverResult(result: HoverResult | null, _workingDirectory?: string): string {
  const text = result ? extractHoverContents(result.contents) : ''
  if (!result || text === '') {
    return 'No hover information available. The cursor may not be on a symbol, or the server may not provide hover for this position.'
  }
  if (result.range) {
    return `Hover information at line ${result.range.start.line + 1}, character ${result.range.start.character + 1}:\n\n${text}`
  }
  return text
}

export function formatDocumentSymbolResult(
  result: Array<DocumentSymbol | SymbolInformation> | null,
  workingDirectory?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found. The file may be empty, the server may not support document symbols, or the file may not be indexed yet.'
  }
  const first: { name: string; location?: Location } = result[0]!
  if (first.location !== undefined) {
    return formatWorkspaceSymbolResult(result as SymbolInformation[], workingDirectory)
  }
  const lines: string[] = ['Document symbols:']
  const appendTree = (nodes: DocumentSymbol[], depth: number): void => {
    const indent = '  '.repeat(depth)
    for (const node of nodes) {
      const kind = symbolKindName(node.kind)
      const detail = node.detail ? ` ${node.detail}` : ''
      const line = (node.selectionRange ?? node.range).start.line + 1
      lines.push(`${indent}${node.name} (${kind})${detail} - line ${line}`)
      if (node.children && node.children.length > 0) {
        appendTree(node.children, depth + 1)
      }
    }
  }
  appendTree(result as DocumentSymbol[], 1)
  return lines.join('\n')
}

export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  workingDirectory?: string,
): string {
  const valid: Array<SymbolInformation & { location: Location }> = []
  for (const sym of result ?? []) {
    const location = sym.location
    if (!location?.uri) {
      logForDebugging('LSP formatter: workspace symbol with no location URI')
      continue
    }
    valid.push({ ...sym, location })
  }
  if (valid.length === 0) {
    return 'No symbols found in the workspace. The workspace may be empty or indexing may not have completed.'
  }
  const grouped = new Map<string, Array<SymbolInformation & { location: Location }>>()
  for (const sym of valid) {
    const file = displayPath(uriToPath(sym.location.uri), workingDirectory)
    const entries = grouped.get(file)
    if (entries) entries.push(sym)
    else grouped.set(file, [sym])
  }
  const lines: string[] = [`Found ${valid.length} ${valid.length === 1 ? 'symbol' : 'symbols'}:`]
  for (const [file, syms] of grouped) {
    lines.push('')
    lines.push(`${file}:`)
    for (const sym of syms) {
      const kind = symbolKindName(sym.kind)
      const container = sym.containerName ? ` in ${sym.containerName}` : ''
      const line = sym.location.range.start.line + 1
      lines.push(`  ${sym.name} (${kind})${container} - line ${line}`)
    }
  }
  return lines.join('\n')
}

function formatCallList(
  entries: Array<{ item: CallHierarchyItem; fromRanges?: Range[] }>,
  emptyMessage: string,
  singularLabel: string,
  pluralLabel: string,
  rangePrefix: string,
  workingDirectory?: string,
): string {
  if (entries.length === 0) return emptyMessage
  const grouped = new Map<string, Array<{ item: CallHierarchyItem; fromRanges?: Range[] }>>()
  for (const entry of entries) {
    const file = entry.item.uri
      ? displayPath(uriToPath(entry.item.uri), workingDirectory)
      : UNKNOWN_LOCATION
    const list = grouped.get(file)
    if (list) list.push(entry)
    else grouped.set(file, [entry])
  }
  const lines: string[] = [
    `Found ${entries.length} ${entries.length === 1 ? singularLabel : pluralLabel}:`,
  ]
  for (const [file, group] of grouped) {
    lines.push('')
    lines.push(`${file}:`)
    for (const { item, fromRanges } of group) {
      const kind = symbolKindName(item.kind)
      const line = (item.selectionRange ?? item.range).start.line + 1
      const callSites =
        fromRanges && fromRanges.length > 0
          ? ` (${rangePrefix} ${fromRanges.map(r => `${r.start.line + 1}:${r.start.character + 1}`).join(', ')})`
          : ''
      lines.push(`  ${item.name} (${kind}) - line ${line}${callSites}`)
    }
  }
  return lines.join('\n')
}

type CallEntry = {
  from?: CallHierarchyItem
  to?: CallHierarchyItem
  fromRanges?: Range[]
}

function extractCallEntries(
  result: readonly CallEntry[] | null,
  direction: 'incoming' | 'outgoing',
): Array<{ item: CallHierarchyItem; fromRanges?: Range[] }> {
  const entries: Array<{ item: CallHierarchyItem; fromRanges?: Range[] }> = []
  for (const call of result ?? []) {
    const item = call.from ?? call.to
    if (!item) {
      logForDebugging(`LSP formatter: ${direction} call entry missing its item`)
      continue
    }
    entries.push({ item, fromRanges: call.fromRanges })
  }
  return entries
}

export function formatIncomingCallsResult(
  result: IncomingCall[] | null,
  workingDirectory?: string,
): string {
  const entries = extractCallEntries(result, 'incoming')
  return formatCallList(
    entries,
    'No incoming calls: nothing in the indexed workspace calls this symbol.',
    'caller',
    'callers',
    'calls at',
    workingDirectory,
  )
}

export function formatOutgoingCallsResult(
  result: OutgoingCall[] | null,
  workingDirectory?: string,
): string {
  const entries = extractCallEntries(result, 'outgoing')
  return formatCallList(
    entries,
    'No outgoing calls: this symbol calls nothing the server can resolve.',
    'callee',
    'callees',
    'called from',
    workingDirectory,
  )
}
