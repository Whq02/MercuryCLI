
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function structureEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_STRUCTURE'))
}

export function structurePolyglotEnabled(): boolean {
  return structureEnabled() && !isEnvDefinedFalsy(flagEnv('MERCURY_STRUCTURE_POLYGLOT'))
}

export const STRUCTURE_LANGS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'] as const

export const STRUCTURE_SELECTS = [
  'function',
  'class',
  'interface',
  'type-alias',
  'enum',
  'method',
  'variable',
  'call',
  'import',
  'export',
  'property',
  'string',
  'jsx-element',
] as const
export type StructureSelect = (typeof STRUCTURE_SELECTS)[number]

export interface StructureQuery {
  select?: StructureSelect
  pattern?: string
  lang?: string
  symbol?: { kind: 'function' | 'class' | 'method'; name: string }
  name?: string
  callee?: string
  module?: string
  value?: string
  within?: string
  files?: string[]
  limit?: number
}

export interface StructureRange {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}

export interface StructureMatch {
  id: string
  file: string
  range: StructureRange
  kind: string
  text: string
  context: string
  anchor: string
  language?: string
}

export interface StructureQueryResult {
  id: string
  query: StructureQuery
  root: string
  scanned: number
  parsed: number
  parseFailures: { file: string; message: string }[]
  matches: StructureMatch[]
  truncated: boolean
  elapsedMs: number
}

export type StructureTransform =
  | {
      action: 'replace'
      replacement: string
    }
  | {
      action: 'rename'
      to: string
    }
  | {
      action: 'remove'
    }
  | {
      action: 'replace-import'
      module: string
    }
  | {
      action: 'replace-callee'
      to: string
    }
  | {
      action: 'set-value'
      value: string
    }
  | {
      action: 'rewrite'
      out: string
    }
  | {
      action: 'insert-before'
      text: string
    }
  | {
      action: 'insert-after'
      text: string
    }

export interface StructureDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface StructureFileEdit {
  file: string
  edits: { start: number; end: number; newText: string }[]
  before: string[]
  after: string[]
  digest: string
  anchor: string
  changedLines: number
  hunks?: StructureDiffHunk[]
  omittedHunks?: number
}

export type PreviewState = 'proposed' | 'applied' | 'stale' | 'cancelled' | 'failed'

export interface StructurePreview {
  id: string
  lane?: 'select' | 'polyglot'
  createdAt: number
  state: PreviewState
  root: string
  queryId: string
  matchIds: string[]
  transform: StructureTransform
  files: StructureFileEdit[]
  matchCount: number
  totalChangedLines: number
  diagnosticsPlanned: string[]
  appliedAt?: number
  changedPaths?: string[]
  transactionRef?: string
  receiptRef?: string
  evidenceRefs?: string[]
  note?: string
}

export interface StructureUnavailable {
  state: 'unavailable'
  note: string
}
