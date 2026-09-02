// ============================================================================
//  structure/contracts — the structural code-intelligence vocabulary
// ONE typed shape for bounded structural queries,
//  write-nothing previews, and transactional applies over JS/TS/JSX/TSX.
//
//  Gate: MERCURY_STRUCTURE (default-on, registered in flagRegistry).
//  The Structure tool COMPLEMENTS the LSP semantic owners — true symbol
//  rename stays lsp.rename, file moves stay lsp.pathRename, server fixes
//  stay code actions. This surface owns SYNTAX-SHAPED work: pattern
//  queries, call-shape changes, import rewrites, template codemods.
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The structural-plane gate (MERCURY_STRUCTURE, default-on; re-read live). */
export function structureEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_STRUCTURE'))
}

/** The polyglot pattern lane (MERCURY_STRUCTURE_POLYGLOT, default-on;
 *  `=0` restores the baseline JS/TS-only surface byte-identically). */
export function structurePolyglotEnabled(): boolean {
  return structureEnabled() && !isEnvDefinedFalsy(flagEnv('MERCURY_STRUCTURE_POLYGLOT'))
}

export const STRUCTURE_LANGS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'] as const

/** What a query selects. Closed, documented vocabulary. */
export const STRUCTURE_SELECTS = [
  'function', // function declarations + arrow/function-expression variable initializers
  'class',
  'interface',
  'type-alias',
  'enum',
  'method',
  'variable',
  'call',
  'import',
  'export',
  'property', // object-literal properties
  'string', // string literals (incl. template heads without substitutions)
  'jsx-element',
] as const
export type StructureSelect = (typeof STRUCTURE_SELECTS)[number]

export interface StructureQuery {
  /** The JS/TS select-vocabulary lane (tsFacility). Exactly one of
   *  `select` / `pattern` per query — the tool layer enforces it. */
  select?: StructureSelect
  /** polyglot lane: an ast-grep-style metavariable pattern
   *  ($NAME · $_ · $$$NAME · $$$) matched via the packaged grammar engine
   *  with per-file language inference. */
  pattern?: string
  /** pattern: pin one engine language instead of per-file inference. */
  lang?: string
  /** the polyglot SYMBOL lane: document-symbol addressing by
   *  kind + name over the engine grammars (python/go/rust v1). Recorded on
   *  the query so preview/apply relocation re-runs the SAME address. */
  symbol?: { kind: 'function' | 'class' | 'method'; name: string }
  /** Name filter — exact, or a glob with `*` wildcards (case-sensitive). */
  name?: string
  /** call: dotted callee path glob ('console.log', 'fs.*', '*.push'). */
  callee?: string
  /** import/export: module-specifier glob ('./legacy/*', 'lodash*'). */
  module?: string
  /** string: literal text substring. */
  value?: string
  /** Ancestor constraint: 'class:Name' | 'function:Name' | a bare kind. */
  within?: string
  /** File scope: glob(s) relative to the project root. Default: the
   *  supported-language estate under the root (bounded walk). */
  files?: string[]
  /** Result bound (default 50, max 200). Deterministic order: path, position. */
  limit?: number
}

export interface StructureRange {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}

export interface StructureMatch {
  /** Stable content-derived id: sm-<hash(file · range · kind · text)>. */
  id: string
  /** Project-root-relative path. */
  file: string
  range: StructureRange
  /** ts.SyntaxKind name of the matched node. */
  kind: string
  /** The matched node's text (bounded). */
  text: string
  /** One bounded context line (the match's first line, trimmed). */
  context: string
  /** Content anchor for the WHOLE file at query time (staleness truth). */
  anchor: string
  /** Pattern lane: the inferred engine language for this file. */
  language?: string
}

export interface StructureQueryResult {
  /** Stable query-record id (sq-…). */
  id: string
  query: StructureQuery
  root: string
  /** Files scanned / parsed / failed-to-parse (bounds are named). */
  scanned: number
  parsed: number
  parseFailures: { file: string; message: string }[]
  matches: StructureMatch[]
  /** True when `limit` truncated the match set (never silent). */
  truncated: boolean
  elapsedMs: number
}

/** The transformation vocabulary — syntax-shaped, template-capable. */
export type StructureTransform =
  | {
      /** Replace each matched node's text. `$TEXT` interpolates the
       *  original node text (template codemod). */
      action: 'replace'
      replacement: string
    }
  | {
      /** Rename the NAME token of each matched named construct (a
       *  declaration name, a property key, a JSX tag). Syntax-scoped —
       *  for true cross-file symbol rename use lsp.rename. */
      action: 'rename'
      to: string
    }
  | {
      /** Remove each matched node (an import, a property, a statement). */
      action: 'remove'
    }
  | {
      /** import matches: rewrite the module specifier. */
      action: 'replace-import'
      module: string
    }
  | {
      /** call matches: rewrite the callee expression text. */
      action: 'replace-callee'
      to: string
    }
  | {
      /** object-literal property matches: set/replace the value text. */
      action: 'set-value'
      value: string
    }
  | {
      /** Pattern-lane rewrite: an `out` template with capture substitution
       *  ($NAME → the captured node's source text · $$$NAME → the exact
       *  captured span). Empty out deletes the matched node. */
      action: 'rewrite'
      out: string
    }
  | {
      /** insert NEW text on its own line(s) immediately above
       *  the matched node's first line. Zero-width, line-oriented: the
       *  matched node's bytes are never touched. */
      action: 'insert-before'
      text: string
    }
  | {
      /** Insert NEW text on its own line(s) immediately below the matched
       *  node's last line. Zero-width, line-oriented. */
      action: 'insert-after'
      text: string
    }

/** a real diff hunk (the `diff` package's structuredPatch
 *  shape) computed at BUILD time from the full old/new file text — the
 *  render layer must never re-read files to paint a diff. */
export interface StructureDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface StructureFileEdit {
  file: string
  /** Byte-offset edits, applied bottom-up (never overlapping). */
  edits: { start: number; end: number; newText: string }[]
  before: string[]
  after: string[]
  /** File content digest at preview time (the stale-refusal truth). */
  digest: string
  /** Expected anchor (change-transaction vocabulary) at preview time. */
  anchor: string
  changedLines: number
  /** Bounded syntax-ready hunks for the inline change view; a cut is NAMED
   *  (omittedHunks), never silent. */
  hunks?: StructureDiffHunk[]
  omittedHunks?: number
}

export type PreviewState = 'proposed' | 'applied' | 'stale' | 'cancelled' | 'failed'

export interface StructurePreview {
  /** sp-<hash> — content-derived, stable for identical previews. */
  id: string
  /** the apply lane, stamped at BUILD time — the router must
   *  never re-derive it from the query record (the query ring evicts
   *  independently of previews; a mis-derived lane parsed python with the
   *  TS parser — closing verify-wave finding). Absent on older
   *  records: the router keeps its transform/query fallbacks. */
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
  /** Diagnostics expected to be rerun after apply (changed-file set). */
  diagnosticsPlanned: string[]
  /** Set when applied: the observed outcome refs. */
  appliedAt?: number
  changedPaths?: string[]
  /** The canonical transaction ref, attached when the exactly-once receipt
   *  for the apply lands (subscribeChangeReceipts). */
  transactionRef?: string
  receiptRef?: string
  evidenceRefs?: string[]
  /** State-change note (why stale/failed/cancelled). */
  note?: string
}

/** Honest unavailability of the parser facility. */
export interface StructureUnavailable {
  state: 'unavailable'
  note: string
}
