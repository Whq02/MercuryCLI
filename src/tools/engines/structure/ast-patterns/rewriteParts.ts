import { createHash } from 'node:crypto'
import { structuredPatch } from 'diff'
import type { BoundedDiffHunk } from '../../change-transaction/diffBudget.js'
import type { ParseErrorRegion, TSNode } from '../../../../platform/grammars/grammarFacility.js'
import { COMMENT_TYPES, findExactSpanNode, metavarOf, significantChildren } from '../pattern.js'
import type { Edit } from '../transform.js'
import { AST_BOUNDS } from './languages.js'
import type { AstScope } from './scope.js'
import type { AstCapture, AstMatch, AstSearchResult } from './search.js'

export interface AstRewriteRule {
  pattern: string
  rewrite: string
}

export interface AstBatchRuleSummary {
  ruleIndex: number
  pattern: string
  rewrite: string
  changedMatches: number
  unchangedMatches: number
  filesChanged: number
  patternRefusals: Array<{ lang: string; files: number; note: string }>
}

export interface AstBatchCoalescedEdit {
  rel: string
  line: number
  col: number
  ruleIndices: number[]
}

export interface AstBatchFileChange {
  line: number
  col: number
  ruleIndices: number[]
}

interface AstBatchDetails {
  rules: AstBatchRuleSummary[]
  coalesced: AstBatchCoalescedEdit[]
  unmatchedRules: number[]
  fileChanges: Map<string, AstBatchFileChange[]>
}

export interface AstRewriteFile {
  rel: string
  abs: string
  lang: string
  matchCount: number
  before: string
  after: string
  digestBefore: string
  digestAfter: string
  diff: string
  diffOmittedLines: number
  hunks: BoundedDiffHunk[]
  omittedHunks: number
  changedLines: number
  edits: Edit[]
}

export interface AstLeftOutFile {
  rel: string
  note: string
  refusal: string
}

export interface AstRewritePlan {
  token: string
  files: AstRewriteFile[]
  matchCount: number
  unchangedMatches: number
  inPlaceMatches: number
  search: AstSearchResult
  batch?: AstBatchDetails
  leftOut?: AstLeftOutFile[]
}


function normalisedText(node: TSNode): string {
  return node.text.replace(/\s+/g, '')
}

export function sameShape(p: TSNode, r: TSNode, pStandIn?: RegExp, rStandIn?: RegExp): boolean {
  const mp = metavarOf(p, false, pStandIn)
  const mr = metavarOf(r, false, rStandIn)
  if (mp || mr) return mp !== null && mr !== null && mp.kind === mr.kind && mp.name === mr.name
  if (p.type !== r.type) return false
  const pk = significantChildren(p)
  const rk = significantChildren(r)
  if (pk.length !== rk.length) return false
  if (pk.length === 0) {
    if (p.childCount === 0 && r.childCount === 0) return true
    return normalisedText(p) === normalisedText(r)
  }
  return pk.every((child, i) => sameShape(child, rk[i]!, pStandIn, rStandIn))
}

export function alignEdits(p: TSNode, r: TSNode, c: TSNode, captures: AstCapture[], out: Edit[], standIn?: RegExp): boolean {
  if (metavarOf(p, false, standIn)) return true
  const pk = significantChildren(p)
  const rk = significantChildren(r)
  const ck = significantChildren(c)
  if (pk.length === 0) {
    if (p.childCount === 0 && c.childCount === 0) {
      if (p.text.trim() !== r.text.trim()) out.push({ start: c.startIndex, end: c.endIndex, newText: r.text.trim() })
      return true
    }
    return normalisedText(p) === normalisedText(r)
  }
  let ci = 0
  for (let pi = 0; pi < pk.length; pi++) {
    const pc = pk[pi]!
    const rc = rk[pi]!
    const mv = metavarOf(pc, false, standIn)
    if (mv?.kind === 'multi') {
      if (mv.name) {
        const cap = captures.find(x => x.key === `$$$${mv.name}`)
        if (!cap) return false
        while (ci < ck.length && cap.endIndex > cap.startIndex && ck[ci]!.startIndex >= cap.startIndex && ck[ci]!.endIndex <= cap.endIndex) ci++
      } else {
        const rest = pk.slice(pi + 1)
        if (rest.some(x => metavarOf(x, false, standIn)?.kind === 'multi')) return false
        const take = ck.length - ci - rest.length
        if (take < 0) return false
        ci += take
      }
      continue
    }
    if (ci >= ck.length) return false
    if (mv) {
      ci++
      continue
    }
    if (!alignEdits(pc, rc, ck[ci]!, captures, out, standIn)) return false
    ci++
  }
  return ci === ck.length
}

export function uncapturedCommentSpans(node: TSNode, captures: AstCapture[]): Edit[] {
  const out: Edit[] = []
  const stack: TSNode[] = [node]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (COMMENT_TYPES.has(cur.type)) {
      const inCapture = captures.some(c => c.endIndex > c.startIndex && cur.startIndex >= c.startIndex && cur.endIndex <= c.endIndex)
      if (!inCapture) out.push({ start: cur.startIndex, end: cur.endIndex, newText: '' })
      continue
    }
    for (let i = cur.childCount - 1; i >= 0; i--) stack.push(cur.children[i]!)
  }
  return out
}

export function locateMatchNode(root: TSNode, m: AstMatch, text: string): TSNode | null {
  let node = findExactSpanNode(root, m.startIndex, m.endIndex, text)
  while (node && node.type !== m.nodeType) {
    const parent = node.parent
    if (!parent || parent.startIndex !== m.startIndex || parent.endIndex !== m.endIndex) return null
    node = parent
  }
  return node
}

export const ANON_IN_REWRITE = /\$\$\$(?![A-Z_])|(?<!\$)\$_(?![A-Za-z0-9_])/

export function rewritePlanToken(pattern: string, rewrite: string, files: Array<[rel: string, digestBefore: string, digestAfter: string]>, leftOut: string[] = []): string {
  return `ae-${createHash('sha1')
    .update(JSON.stringify({ p: pattern, r: rewrite, f: files, ...(leftOut.length > 0 ? { l: leftOut } : {}) }))
    .digest('hex')
    .slice(0, 12)}`
}

export function unifiedDiff(rel: string, before: string, after: string, lineBudget = AST_BOUNDS.diffLinesPerFile): { text: string; omittedLines: number } {
  const patch = structuredPatch(rel, rel, before, after, '', '', { context: 3 })
  const lines: string[] = [`--- a/${rel}`, `+++ b/${rel}`]
  let omitted = 0
  let budget = lineBudget
  for (const h of patch.hunks) {
    const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
    if (budget <= 0) {
      omitted += h.lines.length + 1
      continue
    }
    lines.push(header)
    budget--
    for (const line of h.lines) {
      if (budget <= 0) {
        omitted++
        continue
      }
      lines.push(line)
      budget--
    }
  }
  return { text: lines.join('\n'), omittedLines: omitted }
}

export function countChangedLines(before: string, after: string, edits: Edit[]): number {
  let n = 0
  for (const e of edits) {
    n += Math.max(before.slice(e.start, e.end).split('\n').length, e.newText.split('\n').length)
  }
  return after === before ? 0 : n
}

export function touchesParseError(start: number, end: number, error: ParseErrorRegion): boolean {
  return error.startIndex === error.endIndex
    ? start <= error.startIndex && end >= error.startIndex
    : start < error.endIndex && end > error.startIndex
}

export function introducedParseError(before: string, after: string, edits: Edit[], previous: ParseErrorRegion[], current: ParseErrorRegion[]): ParseErrorRegion | undefined {
  const shifted = (index: number): number => index + edits.reduce((delta, edit) => delta + (edit.end <= index ? edit.newText.length - (edit.end - edit.start) : 0), 0)
  const key = (error: ParseErrorRegion, start = error.startIndex, end = error.endIndex) => JSON.stringify([error.type, error.missing, start, end])
  const remaining = new Map<string, ParseErrorRegion[]>()
  for (const error of previous) {
    const identity = key(error, shifted(error.startIndex), shifted(error.endIndex))
    const found = remaining.get(identity) ?? []
    found.push(error)
    remaining.set(identity, found)
  }
  for (const error of current) {
    const original = remaining.get(key(error))?.shift()
    if (!original || before.slice(original.startIndex, original.endIndex) !== after.slice(error.startIndex, error.endIndex)) return error
  }
  return undefined
}

export function batchRewritePlanToken(
  rules: ReadonlyArray<AstRewriteRule>,
  scope: Pick<AstScope, 'target' | 'glob' | 'lang'>,
  files: Array<[rel: string, digestBefore: string, digestAfter: string]>,
  leftOut: string[] = [],
): string {
  return `ae-${createHash('sha1')
    .update(
      JSON.stringify({
        rules: rules.map(r => [r.pattern, r.rewrite]),
        scope: [scope.target, scope.glob ?? null, scope.lang?.name ?? null],
        f: files,
        ...(leftOut.length > 0 ? { l: leftOut } : {}),
      }),
    )
    .digest('hex')
    .slice(0, 12)}`
}
