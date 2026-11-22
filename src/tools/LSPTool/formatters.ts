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
import { notBuilt } from '../../pi/holes.js'


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

export function formatGoToDefinitionResult(
  result: Locationish | Locationish[] | null,
  workingDirectory?: string,
  sourceLines?: ReadonlyMap<Locationish, string>,
): string {
  return notBuilt('src/tools/LSPTool/formatters.ts:195')
}

export function formatFindReferencesResult(
  result: Location[] | null,
  workingDirectory?: string,
  sourceLines?: ReadonlyMap<Locationish, string>,
): string {
  return notBuilt('src/tools/LSPTool/formatters.ts:217')
}

export function formatHoverResult(result: HoverResult | null, _workingDirectory?: string): string {
  return notBuilt('src/tools/LSPTool/formatters.ts:260')
}

export function formatDocumentSymbolResult(
  result: Array<DocumentSymbol | SymbolInformation> | null,
  workingDirectory?: string,
): string {
  return notBuilt('src/tools/LSPTool/formatters.ts:286')
}

export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  workingDirectory?: string,
): string {
  return notBuilt('src/tools/LSPTool/formatters.ts:302')
}

export function formatIncomingCallsResult(
  result: IncomingCall[] | null,
  workingDirectory?: string,
): string {
  return notBuilt('src/tools/LSPTool/formatters.ts:383')
}

export function formatOutgoingCallsResult(
  result: OutgoingCall[] | null,
  workingDirectory?: string,
): string {
  return notBuilt('src/tools/LSPTool/formatters.ts:390')
}
