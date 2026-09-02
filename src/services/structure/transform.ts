// ============================================================================
//  structure/transform — previewed structural transformations (
// Preview WRITES NOTHING: it re-locates matches by stable id,
//  computes non-overlapping byte edits, captures per-file digests +
//  expected anchors, and holds the original content for honest rollback.
//  Apply revalidates EVERY digest (stale ⇒ typed refusal), pre-validates
//  that transformed output still parses (a broken template never reaches
//  disk), writes atomically per file with rollback on midway failure,
//  verifies by re-read, reruns parse-level diagnostics, and reports the
//  mutation through the EXISTING exactly-once effect→receipt→transaction
//  seam (the tool returns the ToolEffect; no second lifecycle here).
// ============================================================================

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import type * as TS from 'typescript'
import { runVerbatimTextCommit } from '../changeTransaction/changeSetCommit.js'
import { buildDiffHunks } from '../changeTransaction/diffBudget.js'
import { mintFileAnchor } from '../changeTransaction/snapshotAnchor.js'
import { recordCanonicalEvidence } from '../primitives/evidencePlane.js'
import type { OwnerKey } from '../run/ownerKey.js'
import type {
  StructureFileEdit,
  StructureMatch,
  StructurePreview,
  StructureQueryResult,
  StructureTransform,
} from './contracts.js'
import { forEachQueryMatch } from './query.js'
import { loadTs, parseSource, resolveStructureTypescript, type TsModule } from './tsFacility.js'
import { getPreview, rememberPreview, setPreviewState } from './store.js'

export interface Edit {
  start: number
  end: number
  newText: string
}

export function digestOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

// ── per-node edit computation ────────────────────────────────────────────────

function nameNodeOf(ts: TsModule, node: TS.Node): TS.Node[] {
  const named = node as { name?: TS.Node }
  if (ts.isJsxElement(node)) {
    return [node.openingElement.tagName, node.closingElement.tagName]
  }
  if (ts.isJsxSelfClosingElement(node)) return [node.tagName]
  if (named.name) return [named.name]
  if (ts.isVariableDeclaration(node) && node.name) return [node.name]
  return []
}

export function lineExtendedRange(text: string, start: number, end: number): { start: number; end: number } {
  let s = start
  while (s > 0 && text[s - 1] !== '\n' && /\s/.test(text[s - 1]!)) s--
  if (s > 0 && text[s - 1] === '\n') s-- // swallow the preceding newline… no: keep line start
  if (text[s] === '\n') s++
  let e = end
  while (e < text.length && text[e] !== '\n' && /\s/.test(text[e]!)) e++
  if (e < text.length && text[e] === '\n') e++
  return { start: s, end: e }
}

function editsForMatch(
  ts: TsModule,
  sourceFile: TS.SourceFile,
  text: string,
  node: TS.Node,
  match: StructureMatch,
  transform: StructureTransform,
): Edit[] | { refuse: string } {
  const start = node.getStart(sourceFile)
  const end = node.getEnd()
  const original = text.slice(start, end)

  switch (transform.action) {
    case 'replace':
      return [{ start, end, newText: transform.replacement.split('$TEXT').join(original) }]
    case 'rename': {
      const names = nameNodeOf(ts, node)
      if (names.length === 0) {
        return { refuse: `${match.id}: '${match.kind}' has no name token to rename` }
      }
      return names.map(n => ({
        start: n.getStart(sourceFile),
        end: n.getEnd(),
        newText: transform.to,
      }))
    }
    case 'remove': {
      // Statements/imports: remove whole lines. Properties: swallow a
      // trailing comma. Everything else: the exact node range.
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || node.parent === undefined || ts.isSourceFile(node.parent) || (ts.isBlock(node.parent) && ts.isStatement(node as TS.Statement))) {
        const r = lineExtendedRange(text, start, end)
        return [{ start: r.start, end: r.end, newText: '' }]
      }
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        let e = end
        while (e < text.length && /\s/.test(text[e]!)) e++
        if (text[e] === ',') e++
        return [{ start, end: e, newText: '' }]
      }
      return [{ start, end, newText: '' }]
    }
    case 'replace-import': {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
        return { refuse: `${match.id}: replace-import needs an import-declaration match` }
      }
      const spec = node.moduleSpecifier
      // inner range (keep the quote characters)
      return [{ start: spec.getStart(sourceFile) + 1, end: spec.getEnd() - 1, newText: transform.module }]
    }
    case 'replace-callee': {
      if (!ts.isCallExpression(node)) {
        return { refuse: `${match.id}: replace-callee needs a call match` }
      }
      return [
        {
          start: node.expression.getStart(sourceFile),
          end: node.expression.getEnd(),
          newText: transform.to,
        },
      ]
    }
    case 'set-value': {
      if (!ts.isPropertyAssignment(node)) {
        return { refuse: `${match.id}: set-value needs an object-property match` }
      }
      return [
        {
          start: node.initializer.getStart(sourceFile),
          end: node.initializer.getEnd(),
          newText: transform.value,
        },
      ]
    }
    case 'insert-before':
    case 'insert-after':
      // symbol-boundary insertion: zero-width, line-oriented,
      // the matched node's bytes never touched.
      return [insertionEdit(text, start, end, transform.action, transform.text)]
    case 'rewrite':
      // Pattern-lane rewrites ride polyglotTransform.ts — a select-query
      // preview can never reach here (the tool layer routes), but refuse
      // honestly if one does.
      return { refuse: `${match.id}: 'rewrite' applies to pattern queries (use a pattern query, or replace/$TEXT here)` }
  }
}

/** line-oriented zero-width insertion at a node's boundary:
 *  before = at the start of the node's FIRST line; after = just past the
 *  node's LAST line's newline (EOF-safe). Shared by the select lane and
 *  the polyglot symbol lane so insertion semantics can never drift. */
export function insertionEdit(
  text: string,
  nodeStart: number,
  nodeEnd: number,
  action: 'insert-before' | 'insert-after',
  insert: string,
): Edit {
  const block = insert.endsWith('\n') ? insert : insert + '\n'
  if (action === 'insert-before') {
    let s = nodeStart
    while (s > 0 && text[s - 1] !== '\n') s--
    return { start: s, end: s, newText: block }
  }
  let e = nodeEnd
  while (e < text.length && text[e] !== '\n') e++
  if (e < text.length) e++
  const prefix = e >= text.length && text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  return { start: e, end: e, newText: prefix + block }
}

// ── preview ──────────────────────────────────────────────────────────────────

export interface PreviewRefusal {
  state: 'refused'
  reason: string
}

export function buildPreview(
  owner: OwnerKey,
  queryResult: StructureQueryResult,
  matchIds: string[] | undefined,
  transform: StructureTransform,
): StructurePreview | PreviewRefusal {
  const resolution = resolveStructureTypescript(queryResult.root)
  if (resolution.state === 'unavailable') return { state: 'refused', reason: resolution.note }
  const ts = loadTs(resolution.modulePath)

  const wanted = new Set(matchIds ?? queryResult.matches.map(m => m.id))
  const unknown = [...wanted].filter(id => !queryResult.matches.some(m => m.id === id))
  if (unknown.length > 0) {
    return { state: 'refused', reason: `unknown match id(s): ${unknown.join(', ')}` }
  }
  if (wanted.size === 0) {
    return { state: 'refused', reason: 'no matches selected — an empty preview would be a no-op claim' }
  }

  const byFile = new Map<string, StructureMatch[]>()
  for (const m of queryResult.matches) {
    if (!wanted.has(m.id)) continue
    const list = byFile.get(m.file) ?? []
    list.push(m)
    byFile.set(m.file, list)
  }

  const files: StructureFileEdit[] = []
  let totalBytes = 0
  const originals = new Map<string, string>()

  for (const [rel, fileMatches] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const full = path.join(queryResult.root, rel)
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch (err) {
      return { state: 'refused', reason: `${rel}: unreadable — ${(err as Error).message}` }
    }
    totalBytes += text.length
    if (totalBytes > 4_000_000) {
      return { state: 'refused', reason: 'preview exceeds the 4MB bounded working set — narrow the match set' }
    }
    const { sourceFile, parseErrors } = parseSource(ts, full, text)
    if (parseErrors.length > 0) {
      return { state: 'refused', reason: `${rel}: no longer parses (${parseErrors[0]}) — re-query` }
    }

    // Re-locate matches by STABLE id — a changed file cannot reproduce the
    // id, so staleness is mechanical, never guessed.
    const located = new Map<string, { match: StructureMatch; node: TS.Node }>()
    forEachQueryMatch(ts, sourceFile, text, rel, queryResult.query, (m, node) => {
      if (wanted.has(m.id) && !located.has(m.id)) located.set(m.id, { match: m, node })
    })
    const missing = fileMatches.filter(m => !located.has(m.id)).map(m => m.id)
    if (missing.length > 0) {
      return {
        state: 'refused',
        reason: `${rel}: match(es) ${missing.join(', ')} no longer reproduce — the file changed since the query; re-query`,
      }
    }

    const edits: Edit[] = []
    for (const m of fileMatches) {
      const { match, node } = located.get(m.id)!
      const result = editsForMatch(ts, sourceFile, text, node, match, transform)
      if ('refuse' in result) return { state: 'refused', reason: result.refuse }
      edits.push(...result)
    }
    edits.sort((a, b) => a.start - b.start)
    for (let i = 1; i < edits.length; i++) {
      if (edits[i]!.start < edits[i - 1]!.end) {
        return {
          state: 'refused',
          reason: `${rel}: overlapping edits (nested matches?) — narrow the match set`,
        }
      }
    }

    // before/after snippets, bounded
    const beforeLines: string[] = []
    const afterLines: string[] = []
    let changedLines = 0
    for (const e of edits.slice(0, 8)) {
      const beforeText = text.slice(e.start, e.end)
      beforeLines.push(beforeText.split('\n')[0]?.slice(0, 140) ?? '')
      afterLines.push(e.newText.split('\n')[0]?.slice(0, 140) ?? '')
    }
    for (const e of edits) {
      changedLines +=
        Math.max(text.slice(e.start, e.end).split('\n').length, e.newText.split('\n').length)
    }

    originals.set(rel, text)
    const { hunks, omittedHunks } = buildDiffHunks(rel, text, applyEdits(text, edits))
    files.push({
      file: rel,
      edits,
      before: beforeLines,
      after: afterLines,
      digest: digestOf(text),
      anchor: mintFileAnchor(text),
      changedLines,
      hunks,
      ...(omittedHunks > 0 ? { omittedHunks } : {}),
    })
  }

  const id = `sp-${createHash('sha1')
    .update(JSON.stringify({ q: queryResult.id, ids: [...wanted].sort(), transform, digests: files.map(f => f.digest) }))
    .digest('hex')
    .slice(0, 12)}`

  const preview: StructurePreview & { _originals?: Map<string, string> } = {
    id,
    lane: 'select',
    createdAt: Date.now(),
    state: 'proposed',
    root: queryResult.root,
    queryId: queryResult.id,
    matchIds: [...wanted].sort(),
    transform,
    files,
    matchCount: wanted.size,
    totalChangedLines: files.reduce((n, f) => n + f.changedLines, 0),
    diagnosticsPlanned: files.map(f => f.file),
  }
  // Original content rides the in-memory record (never serialized to the
  // resource view) — the honest-rollback working set.
  Object.defineProperty(preview, '_originals', { value: originals, enumerable: false })
  rememberPreview(owner, preview)
  return preview
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface ApplyOutcome {
  state: 'applied'
  preview: StructurePreview
  changedPaths: string[]
  /** Parse-level diagnostics rerun on every changed file (the built-in
   *  check; semantic diagnostics stay with the LSP owner). */
  diagnostics: { file: string; ok: boolean; message?: string }[]
  evidenceRefs: string[]
}

export interface ApplyRefusal {
  state: 'refused'
  code: 'absent' | 'stale' | 'already-applied' | 'cancelled' | 'parse-guard' | 'io'
  reason: string
}

export function applyEdits(text: string, edits: Edit[]): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end)
  }
  return out
}

// F2 / F1: the bounded diff builder is the SHARED budget law
// (changeTransaction/diffBudget.ts) — re-exported here so every existing
// import site keeps its seam.
export { buildDiffHunks }

export async function applyPreview(
  owner: OwnerKey,
  previewId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ApplyOutcome | ApplyRefusal> {
  const preview = getPreview(owner, previewId) as
    | (StructurePreview & { _originals?: Map<string, string> })
    | undefined
  if (!preview) {
    return { state: 'refused', code: 'absent', reason: `no preview '${previewId}' in this conversation` }
  }
  if (preview.state === 'applied') {
    return { state: 'refused', code: 'already-applied', reason: `${previewId} already applied — a second apply would double-write` }
  }
  if (preview.state !== 'proposed') {
    return { state: 'refused', code: 'stale', reason: `${previewId} is '${preview.state}'${preview.note ? ` — ${preview.note}` : ''}` }
  }
  if (opts.signal?.aborted) {
    setPreviewState(owner, previewId, 'cancelled', { note: 'cancelled before applying' })
    return { state: 'refused', code: 'cancelled', reason: 'cancelled before applying — nothing written' }
  }

  const resolution = resolveStructureTypescript(preview.root)
  if (resolution.state === 'unavailable') {
    return { state: 'refused', code: 'io', reason: resolution.note }
  }
  const ts = loadTs(resolution.modulePath)

  // 1. revalidate EVERY digest before touching anything.
  const current = new Map<string, string>()
  const staleFiles: string[] = []
  for (const f of preview.files) {
    let text: string
    try {
      text = readFileSync(path.join(preview.root, f.file), 'utf8')
    } catch (err) {
      return { state: 'refused', code: 'io', reason: `${f.file}: unreadable — ${(err as Error).message}` }
    }
    if (digestOf(text) !== f.digest) staleFiles.push(f.file)
    current.set(f.file, text)
  }
  if (staleFiles.length > 0) {
    setPreviewState(owner, previewId, 'stale', {
      note: `changed since preview: ${staleFiles.join(', ')}`,
    })
    return {
      state: 'refused',
      code: 'stale',
      reason: `stale preview — changed since preview: ${staleFiles.join(', ')}; re-query and re-preview`,
    }
  }

  // 2. transform in memory + parse guard (a broken template never lands).
  const transformed = new Map<string, string>()
  for (const f of preview.files) {
    const next = applyEdits(current.get(f.file)!, f.edits)
    const { parseErrors } = parseSource(ts, path.join(preview.root, f.file), next)
    if (parseErrors.length > 0) {
      return {
        state: 'refused',
        code: 'parse-guard',
        reason: `${f.file}: the transformed output would not parse (${parseErrors[0]}) — files untouched`,
      }
    }
    transformed.set(f.file, next)
  }

  if (opts.signal?.aborted) {
    setPreviewState(owner, previewId, 'cancelled', { note: 'cancelled before applying' })
    return { state: 'refused', code: 'cancelled', reason: 'cancelled before applying — nothing written' }
  }

  // 3+4. the ONE shared journaled commit walk: ordered path
  //      locks, current-byte revalidation, recovery bundle + staged temps +
  //      the text-change-set journal record before the first rename, and
  //      digest-guarded compensation VERIFIED by reread. (The previous
  //      per-file write loop with best-effort UNVERIFIED rollback is
  //      deleted — a deliberate improvement, named in the record.)
  const outcome = await runVerbatimTextCommit({
    ownerKey: owner,
    source: 'structure',
    files: preview.files.map(f => ({
      canonicalPath: path.join(preview.root, f.file),
      originalText: current.get(f.file)!,
      plannedText: transformed.get(f.file)!,
    })),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  })
  if (outcome.kind === 'stale') {
    const rels = outcome.stalePaths.map(p => path.relative(preview.root, p))
    setPreviewState(owner, previewId, 'stale', { note: `changed since preview: ${rels.join(', ')}` })
    return {
      state: 'refused',
      code: 'stale',
      reason: `stale preview — changed since preview: ${rels.join(', ')}; re-query and re-preview`,
    }
  }
  if (outcome.kind === 'cancelled') {
    setPreviewState(owner, previewId, 'cancelled', { note: 'cancelled before applying' })
    return { state: 'refused', code: 'cancelled', reason: 'cancelled before applying — nothing written' }
  }
  if (outcome.kind === 'in-flight') {
    return {
      state: 'refused',
      code: 'io',
      reason: `another live Mercury process is committing this exact change set (operation ${outcome.operationId}) — nothing written here`,
    }
  }
  if (outcome.kind === 'failed-restored') {
    setPreviewState(owner, previewId, 'failed', {
      note: `apply failed (${outcome.reason}); original content restored and verified`,
    })
    return {
      state: 'refused',
      code: 'io',
      reason: `apply FAILED (${outcome.reason}) — partial application is failure; every touched file was restored to its original bytes and VERIFIED by reread`,
    }
  }
  if (outcome.kind === 'indeterminate') {
    const rels = outcome.divergedPaths.map(p => path.relative(preview.root, p))
    setPreviewState(owner, previewId, 'failed', {
      note: `apply indeterminate: final state differs at ${rels.join(', ')}`,
    })
    return {
      state: 'refused',
      code: 'io',
      reason: `apply INDETERMINATE (${outcome.reason}) — final state differs from both plan and original at: ${rels.join(', ')}; re-read before relying on those files`,
    }
  }
  const changedPaths = outcome.changedPaths

  // 5. rerun parse-level diagnostics on every changed file (the built-in
  //    diagnostics pass; semantic diagnostics ride the LSP owner).
  const diagnostics = preview.files.map(f => {
    const { parseErrors } = parseSource(
      ts,
      path.join(preview.root, f.file),
      transformed.get(f.file)!,
    )
    return parseErrors.length === 0
      ? { file: f.file, ok: true as const }
      : { file: f.file, ok: false as const, message: parseErrors[0]! }
  })

  // 6. canonical observed evidence for the apply + the diagnostics rerun.
  const evidenceRefs: string[] = []
  try {
    const applied = recordCanonicalEvidence({
      owner,
      kind: 'change',
      origin: 'observed',
      claim: `structure.apply ${previewId}: ${preview.matchCount} match(es) across ${preview.files.length} file(s), re-read verified`,
      refs: [`mercury://structure/preview/${previewId}`],
      details: { changedPaths: preview.files.map(f => f.file) },
    })
    evidenceRefs.push(`mercury://evidence/${applied.id}`)
    const diagOk = diagnostics.every(d => d.ok)
    const checked = recordCanonicalEvidence({
      owner,
      kind: 'check',
      origin: 'observed',
      claim: `structure.apply ${previewId}: post-apply parse diagnostics ${diagOk ? 'clean' : 'FAILED'} on ${diagnostics.length} file(s)`,
      refs: [`mercury://structure/preview/${previewId}`],
      details: { diagnostics },
    })
    evidenceRefs.push(`mercury://evidence/${checked.id}`)
  } catch {
    /* evidence never blocks the observed outcome report */
  }

  const updated = setPreviewState(owner, previewId, 'applied', {
    appliedAt: Date.now(),
    changedPaths,
    evidenceRefs,
  })!

  return { state: 'applied', preview: updated, changedPaths, diagnostics, evidenceRefs }
}
