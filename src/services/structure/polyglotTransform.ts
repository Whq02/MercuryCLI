// ============================================================================
//  structure/polyglotTransform — previewed pattern-lane rewrites (
//  Family 1). The SAME laws as transform.ts, driven by the grammar engine:
//
//    preview  — WRITE-NOTHING: re-read + reparse every target, re-locate
//               matches by STABLE id (a changed file cannot reproduce them),
//               substitute the `out` template per match, compute
//               non-overlapping byte edits, capture per-file digests;
//    apply    — revalidate EVERY digest (stale ⇒ typed refusal + the fresh
//               preview hint), recompute the COMPLETE planned outputs and
//               compare input/output digests against the preview (never
//               replacement counts), parse-guard the transformed output (a
//               rewrite that breaks the syntax never reaches disk), write
//               atomically with rollback, verify by re-read, rerun parse
//               diagnostics, settle through the EXISTING exactly-once
//               effect→receipt→transaction seam + evidence plane.
//
//  Records ride the ONE structure store (store.ts) and the ONE preview
//  shape — mercury://structure/preview/<id> serves both lanes.
// ============================================================================

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { runVerbatimTextCommit } from '../changeTransaction/changeSetCommit.js'
import { mintFileAnchor } from '../changeTransaction/snapshotAnchor.js'
import { recordCanonicalEvidence } from '../primitives/evidencePlane.js'
import type { OwnerKey } from '../run/ownerKey.js'
import type {
  StructureFileEdit,
  StructureMatch,
  StructurePreview,
  StructureQueryResult,
} from './contracts.js'
import { languageForFile, loadGrammarEngine, parsePolyglot } from './grammarFacility.js'
import { substituteRewrite } from './pattern.js'
import { relocatePatternMatches, type RelocatedMatch } from './polyglotQuery.js'
import { getPreview, rememberPreview, setPreviewState } from './store.js'
import { applyEdits, buildDiffHunks, digestOf, insertionEdit, lineExtendedRange, type Edit, type PreviewRefusal } from './transform.js'
import { relocateSymbolMatches } from './polyglotSymbols.js'

// ── preview ──────────────────────────────────────────────────────────────────

/** the polyglot edit plan: the pattern lane's rewrite template
 *  plus the symbol lane's boundary actions (replace/$TEXT · remove ·
 *  insert-before/after), all settling through the SAME preview machinery. */
export type PolyglotEditPlan =
  | { kind: 'rewrite'; out: string }
  | { kind: 'replace'; text: string }
  | { kind: 'remove' }
  | { kind: 'insert-before'; text: string }
  | { kind: 'insert-after'; text: string }

export async function buildPolyglotPreview(
  owner: OwnerKey,
  queryResult: StructureQueryResult,
  matchIds: string[] | undefined,
  plan: PolyglotEditPlan,
): Promise<StructurePreview | PreviewRefusal> {
  if (!queryResult.query.pattern && !queryResult.query.symbol) {
    return { state: 'refused', reason: `${queryResult.id} is a select query — this lane needs a pattern or symbol query` }
  }
  if (plan.kind === 'rewrite' && !queryResult.query.pattern) {
    return { state: 'refused', reason: `'rewrite' takes a PATTERN query (capture substitution) — symbol queries take replace/remove/insert-before/insert-after` }
  }
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return { state: 'refused', reason: engine.note }

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

    const relocated = queryResult.query.symbol
      ? await relocateSymbolMatches(rel, text, queryResult.query)
      : await relocatePatternMatches(rel, text, queryResult.query)
    if (relocated.state === 'refused') {
      return { state: 'refused', reason: `${rel}: ${relocated.note} — re-query` }
    }
    const missing = fileMatches.filter(m => !relocated.byId.has(m.id)).map(m => m.id)
    if (missing.length > 0) {
      return {
        state: 'refused',
        reason: `${rel}: match(es) ${missing.join(', ')} no longer reproduce — the file changed since the query; re-query`,
      }
    }

    // Per-match edits. rewrite = full node replacement with the substituted
    // template; the symbol-lane actions synthesize boundary edits (shared
    // insertion/removal semantics with the select lane — one definition).
    // Nested selected matches would overlap — refuse, never guess.
    const edits: Edit[] = []
    for (const m of fileMatches) {
      const hit: RelocatedMatch = relocated.byId.get(m.id)!
      if (plan.kind === 'rewrite') {
        const substituted = substituteRewrite(plan.out, hit.captures, patternCaptureNames(hit))
        if (typeof substituted !== 'string') return { state: 'refused', reason: `${m.id}: ${substituted.refuse}` }
        edits.push({ start: hit.startIndex, end: hit.endIndex, newText: substituted })
      } else if (plan.kind === 'replace') {
        edits.push({ start: hit.startIndex, end: hit.endIndex, newText: plan.text.split('$TEXT').join(hit.nodeText) })
      } else if (plan.kind === 'remove') {
        const r = lineExtendedRange(text, hit.startIndex, hit.endIndex)
        edits.push({ start: r.start, end: r.end, newText: '' })
      } else {
        edits.push(insertionEdit(text, hit.startIndex, hit.endIndex, plan.kind, plan.text))
      }
    }
    edits.sort((a, b) => a.start - b.start)
    for (let i = 1; i < edits.length; i++) {
      if (edits[i]!.start < edits[i - 1]!.end) {
        return {
          state: 'refused',
          reason: `${rel}: overlapping rewrites (nested matches selected) — narrow matchIds to disjoint matches`,
        }
      }
    }

    const beforeLines: string[] = []
    const afterLines: string[] = []
    let changedLines = 0
    for (const e of edits.slice(0, 8)) {
      beforeLines.push(text.slice(e.start, e.end).split('\n')[0]?.slice(0, 140) ?? '')
      afterLines.push(e.newText.split('\n')[0]?.slice(0, 140) ?? '')
    }
    for (const e of edits) {
      changedLines += Math.max(text.slice(e.start, e.end).split('\n').length, e.newText.split('\n').length)
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
    .update(JSON.stringify({ q: queryResult.id, ids: [...wanted].sort(), plan, digests: files.map(f => f.digest) }))
    .digest('hex')
    .slice(0, 12)}`

  const preview: StructurePreview & { _originals?: Map<string, string> } = {
    id,
    lane: 'polyglot',
    createdAt: Date.now(),
    state: 'proposed',
    root: queryResult.root,
    queryId: queryResult.id,
    matchIds: [...wanted].sort(),
    transform:
      plan.kind === 'rewrite'
        ? { action: 'rewrite', out: plan.out }
        : plan.kind === 'replace'
          ? { action: 'replace', replacement: plan.text }
          : plan.kind === 'remove'
            ? { action: 'remove' }
            : { action: plan.kind, text: plan.text },
    files,
    matchCount: wanted.size,
    totalChangedLines: files.reduce((n, f) => n + f.changedLines, 0),
    diagnosticsPlanned: files.map(f => f.file),
  }
  Object.defineProperty(preview, '_originals', { value: originals, enumerable: false })
  rememberPreview(owner, preview)
  return preview
}

/** The capture-name universe of a relocated match (validation surface for
 *  the `out` template). */
function patternCaptureNames(hit: RelocatedMatch): string[] {
  return hit.captures.map(c => c.key)
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface PolyglotApplyOutcome {
  state: 'applied'
  preview: StructurePreview
  changedPaths: string[]
  diagnostics: { file: string; ok: boolean; message?: string }[]
  evidenceRefs: string[]
}

export interface PolyglotApplyRefusal {
  state: 'refused'
  code: 'absent' | 'stale' | 'already-applied' | 'cancelled' | 'parse-guard' | 'io'
  reason: string
}

// The apply pipeline AWAITS between the state gate and the writes (engine
// load · parse guards) — a concurrent second apply of the SAME preview must
// refuse at entry, not double-write (the select lane is synchronous and
// immune; this lane keeps parity with an explicit in-flight latch).
const applying = new Set<string>()

export async function applyPolyglotPreview(
  owner: OwnerKey,
  previewId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PolyglotApplyOutcome | PolyglotApplyRefusal> {
  const latchKey = `${owner}␟${previewId}`
  if (applying.has(latchKey)) {
    return {
      state: 'refused',
      code: 'already-applied',
      reason: `${previewId}: an apply of this preview is already in flight — a second apply would double-write`,
    }
  }
  applying.add(latchKey)
  try {
    return await applyPolyglotPreviewInner(owner, previewId, opts)
  } finally {
    applying.delete(latchKey)
  }
}

async function applyPolyglotPreviewInner(
  owner: OwnerKey,
  previewId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PolyglotApplyOutcome | PolyglotApplyRefusal> {
  const preview = getPreview(owner, previewId)
  if (!preview) {
    return { state: 'refused', code: 'absent', reason: `no preview '${previewId}' in this conversation` }
  }
  // this lane applies rewrite (pattern) AND the symbol-lane
  // boundary actions — the select-vocabulary actions stay with the select
  // lane's applier.
  const POLYGLOT_APPLY_ACTIONS = ['rewrite', 'replace', 'remove', 'insert-before', 'insert-after']
  if (!POLYGLOT_APPLY_ACTIONS.includes(preview.transform.action)) {
    return { state: 'refused', code: 'io', reason: `${previewId} is a ${preview.transform.action} preview — apply it through the select lane` }
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
  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') {
    return { state: 'refused', code: 'io', reason: engine.note }
  }

  // 1. revalidate EVERY digest before touching anything (input-digest law).
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
    setPreviewState(owner, previewId, 'stale', { note: `changed since preview: ${staleFiles.join(', ')}` })
    return {
      state: 'refused',
      code: 'stale',
      reason: `stale preview — changed since preview: ${staleFiles.join(', ')}; re-query and re-preview`,
    }
  }

  // 2. recompute the COMPLETE planned outputs from the previewed byte edits
  //    (the inputs are digest-identical, so the recomputation is exact) and
  //    parse-guard each: a rewrite that breaks the syntax never lands.
  const transformed = new Map<string, string>()
  for (const f of preview.files) {
    const next = applyEdits(current.get(f.file)!, f.edits)
    const lang = languageForFile(f.file)
    if (!lang) {
      return { state: 'refused', code: 'io', reason: `${f.file}: no engine grammar for this extension (the preview should not exist)` }
    }
    const reparsed = await parsePolyglot(engine, lang, next)
    if ('state' in reparsed) {
      return { state: 'refused', code: 'io', reason: `${f.file}: ${reparsed.note}` }
    }
    const broken = reparsed.parseErrors.length > 0
    reparsed.tree.delete()
    if (broken) {
      return {
        state: 'refused',
        code: 'parse-guard',
        reason: `${f.file}: the transformed output would not parse as ${lang.name} — files untouched; adjust the transformation`,
      }
    }
    transformed.set(f.file, next)
  }

  if (opts.signal?.aborted) {
    setPreviewState(owner, previewId, 'cancelled', { note: 'cancelled before applying' })
    return { state: 'refused', code: 'cancelled', reason: 'cancelled before applying — nothing written' }
  }

  // 3+4. the ONE shared journaled commit walk — same core as
  //      the select lane and the ChangeSet tool: ordered path locks,
  //      revalidation, bundle + staged temps + the text-change-set journal
  //      record, rename walk, compensation VERIFIED by reread.
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

  // 5. rerun parse-level diagnostics on every changed file.
  const diagnostics: { file: string; ok: boolean; message?: string }[] = []
  for (const f of preview.files) {
    const lang = languageForFile(f.file)!
    const reparsed = await parsePolyglot(engine, lang, transformed.get(f.file)!)
    if ('state' in reparsed) {
      diagnostics.push({ file: f.file, ok: false, message: reparsed.note })
      continue
    }
    diagnostics.push(
      reparsed.parseErrors.length === 0
        ? { file: f.file, ok: true }
        : { file: f.file, ok: false, message: reparsed.parseErrors[0]! },
    )
    reparsed.tree.delete()
  }

  // 6. canonical observed evidence (same seam as the select lane).
  const evidenceRefs: string[] = []
  try {
    const applied = recordCanonicalEvidence({
      owner,
      kind: 'change',
      origin: 'observed',
      claim: `structure.apply ${previewId} (pattern rewrite): ${preview.matchCount} match(es) across ${preview.files.length} file(s), re-read verified`,
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
