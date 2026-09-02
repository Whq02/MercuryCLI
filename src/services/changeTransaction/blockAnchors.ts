// ============================================================================
//  changeTransaction/blockAnchors — syntactic block resolution for the patch
//  dialect's replace-block / insert-after-block ops.
//
//  Bounded v1: the TS-family languages Mercury already parses (the ONE
//  structure tsFacility — no new parser framework). Every other language
//  gets a typed "use explicit ranges" refusal naming the reason; a broken
//  tree refuses (never a guess over parse errors); a single-line node
//  redirects to explicit-line ops; a line where no node STARTS (a closing
//  brace, a blank) refuses with the nearest candidates. Multi-grammar
//  resolution is a NAMED scope fence (a tree-sitter-class decision the
//  operator owns).
// ============================================================================

import * as path from 'node:path'
import {
  isSupportedSourceFile,
  loadTs,
  parseSource,
  resolveStructureTypescript,
  type TsModule,
} from '../structure/tsFacility.js'

export type BlockResolution =
  | { ok: true; startLine: number; endLine: number; kindLabel: string }
  | {
      ok: false
      code: 'unsupported-language' | 'parse-error' | 'no-block' | 'single-line'
      reason: string
    }

/**
 * Resolve the syntactic block OPENING at `line` (1-based) in `content`.
 * The outermost node whose first non-trivia token sits on that line wins.
 */
export function resolveBlockAt(filePath: string, content: string, line: number): BlockResolution {
  if (!isSupportedSourceFile(filePath)) {
    return {
      ok: false,
      code: 'unsupported-language',
      reason: `block ops resolve TS-family files only (${path.extname(filePath) || 'no extension'} is not parsed) — use explicit line ranges`,
    }
  }
  const resolution = resolveStructureTypescript(path.dirname(filePath))
  if (resolution.state !== 'ok') {
    return {
      ok: false,
      code: 'unsupported-language',
      reason: `no typescript parser facility: ${resolution.note} — use explicit line ranges`,
    }
  }
  let ts: TsModule
  try {
    ts = loadTs(resolution.modulePath)
  } catch (e) {
    return { ok: false, code: 'unsupported-language', reason: (e as Error).message }
  }
  const { sourceFile, parseErrors } = parseSource(ts, filePath, content)
  if (parseErrors.length > 0) {
    return {
      ok: false,
      code: 'parse-error',
      reason: `the file does not parse (${parseErrors[0]}) — block anchors never guess over a broken tree; use explicit line ranges`,
    }
  }

  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1

  // Outermost node starting on the target line: walk from the root; the
  // FIRST node in document order whose start line matches wins, and we do
  // not descend into it (outermost by construction).
  let found: { start: number; end: number; kind: string } | null = null
  const visit = (node: import('typescript').Node): void => {
    if (found) return
    const start = node.getStart(sourceFile)
    const startLine = lineOf(start)
    if (startLine === line && node !== (sourceFile as unknown as import('typescript').Node)) {
      found = { start, end: node.getEnd(), kind: ts.SyntaxKind[node.kind] ?? String(node.kind) }
      return
    }
    if (startLine > line) return // document order — nothing later starts earlier
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)

  if (!found) {
    return {
      ok: false,
      code: 'no-block',
      reason: `no syntactic node OPENS at line ${line} (a closing line, a blank, or mid-node) — block anchors take the block's first line; use explicit line ranges otherwise`,
    }
  }
  const hit = found as { start: number; end: number; kind: string }
  const startLine = lineOf(hit.start)
  const endLine = lineOf(hit.end)
  if (startLine === endLine) {
    return {
      ok: false,
      code: 'single-line',
      reason: `the node at line ${line} (${hit.kind}) is single-line — use the explicit-line ops (replace ${line})`,
    }
  }
  return { ok: true, startLine, endLine, kindLabel: hit.kind }
}
