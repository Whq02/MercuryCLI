// ============================================================================
//  ide/ideTransaction — the closed-loop coding transaction (idewave rebuild).
//
//  A typed, durable evidence LEDGER over the owners that already execute —
//  this module runs NOTHING. The agent works through the normal tools; each
//  step is NOTED here with mercury:// evidence refs that must RESOLVE at
//  note time (a fabricated or stale ref refuses the whole note), and the
//  completion verdict is MECHANICALLY gated against the last ok apply step:
//  a mercury://receipt ref on it, a stabilize step after it, an ok
//  test/build/verify step after it, no failed step after it — a completion
//  refusal names every missing leg. Failed/abandoned always land; unresolved
//  uncertainty is appended, never dropped.
//
//  Durability: revisioned JSON records under the adoptive project store
//  (<root>/.mercury/ide-transactions/) plus a latest.json
//  pointer, both through the durable atomic publisher. The store root is the
//  shared project-root resolution (findPythonProjectRoot) so every caller —
//  service, observer, adapter, doctor — lands on the same store for the
//  same input. Reads are null-not-throw; only genuine IO corruption reads
//  as null. Resume re-reads the durable record and reports per-apply-ref
//  liveness — nothing is ever replayed.
//
//  §DEPS-TDZ law: the resource registry is imported LAZILY inside the async
//  paths only. A top-level import would pull the adapter graph (transitively
//  the tool catalog) into module evaluation and TDZ-crash importers during
//  cycles.
//
//  Gate: MERCURY_IDE_LOOP (registered, default-on, re-read live through the
//  flag registry on every call).
//  Proofs: scripts/ide/prove-closed-loop.ts · scripts/edit-tools/prove-tx-autocapture.ts
// ============================================================================

import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { findPythonProjectRoot } from './pythonProject.js'

/** The closed-loop gate (tool catalog + resource adapter consume it). */
export function ideLoopEnabled(): boolean {
  return flagEnabled('MERCURY_IDE_LOOP')
}

// ── vocabulary ──────────────────────────────────────────────────────────────

/** The thirteen step kinds spanning the loop (the observer and the
 *  Transaction tool pin these spellings). */
export const TX_STEP_KINDS = [
  'profile',
  'diagnose',
  'select',
  'context',
  'propose',
  'preview',
  'apply',
  'stabilize',
  'format',
  'test',
  'build',
  'debug',
  'verify',
] as const

export type TxStepKind = (typeof TX_STEP_KINDS)[number]
export type TxStepOutcome = 'ok' | 'failed' | 'indeterminate' | 'info'
export type TxVerdict = 'open' | 'completed' | 'failed' | 'abandoned'

/** Auto-capture provenance. (toolUseId, kind) is the exactly-once dedup key
 *  — persisted on the step so a resumed session can never double-record.
 *  Manual steps never carry it. */
export interface TxStepAuto {
  toolUseId: string
}

export interface TxStep {
  kind: TxStepKind
  /** Noted-at, epoch ms. */
  at: number
  /** One line, bounded to 300 chars at note time. */
  summary: string
  /** mercury:// evidence refs — each one resolved at note time. */
  refs: string[]
  outcome: TxStepOutcome
  auto?: TxStepAuto
}

export interface TxRecord {
  /** Schema version (field value 1). */
  _v: 1
  id: string
  intent: string
  /** The opener's owner key — provenance, not an access gate. */
  owner: OwnerKey
  /** The resolved project root the store lives under. */
  projectRoot: string
  verdict: TxVerdict
  steps: TxStep[]
  /** Unresolved uncertainty — appended on finish, NEVER replaced or dropped. */
  unresolved: string[]
  openedAt: number
  finishedAt?: number
}

export interface TxListRow {
  id: string
  /** Bounded slice of the intent. */
  intent: string
  verdict: TxVerdict
  openedAt: number
}

// ── store constants ─────────────────────────────────────────────────────────

// Store segment field-pinned by existing deployments (records live under
// `<root>/.mercury/ide-transactions/`). The record prefix distinguishes record files from the
// pointer file for NEW mints; reads tolerate any slug-named record file so
// an existing store keeps reading regardless of its historical prefix.
const STORE_SEGMENT = 'ide-transactions'
const RECORD_PREFIX = 'tx-'
const POINTER_FILE = 'latest.json'
const STEP_CAP = 100
const SUMMARY_MAX = 300
const LIST_MAX = 50
const INTENT_ROW_MAX = 120
const RECEIPT_REF_PREFIX = 'mercury://receipt'
// Conservative lowercase slug — ids are embedded into file paths, so
// anything outside this shape is rejected before it can touch the fs.
const ID_PATTERN = /^[a-z][a-z0-9-]{2,79}$/

function isRecordId(id: string): boolean {
  return id !== 'latest' && ID_PATTERN.test(id)
}

// ── store resolution ────────────────────────────────────────────────────────

// cwd → resolved root memo. The observer asks "is a loop open here" on
// EVERY terminal tool event; the marker walk must not run per event. The
// resolver is a fixpoint (resolveRoot(resolveRoot(x)) === resolveRoot(x)),
// so memoized entries can never disagree with a fresh walk within a session.
const rootMemo = new Map<string, string>()
const ROOT_MEMO_CAP = 256

function resolveRoot(from?: string): string {
  const key = from ?? getCwd()
  const memoized = rootMemo.get(key)
  if (memoized !== undefined) return memoized
  const root = findPythonProjectRoot(key).root
  if (rootMemo.size >= ROOT_MEMO_CAP) rootMemo.clear()
  rootMemo.set(key, root)
  return root
}

/** The adoptive store directory. Throws only on the canonical-root alias
 *  refusal — reads wrap it, writes let a broken home surface. */
function storeDir(root: string): string {
  return adoptiveProjectPath(root, STORE_SEGMENT)
}

// ── decode (field-tolerant, corruption-honest) ──────────────────────────────

const KIND_SET: ReadonlySet<string> = new Set(TX_STEP_KINDS)
const OUTCOME_SET: ReadonlySet<string> = new Set(['ok', 'failed', 'indeterminate', 'info'])
const VERDICT_SET: ReadonlySet<string> = new Set(['open', 'completed', 'failed', 'abandoned'])

function decodeStep(raw: unknown): TxStep | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  if (typeof s.kind !== 'string' || !KIND_SET.has(s.kind)) return null
  if (typeof s.summary !== 'string') return null
  const auto =
    s.auto !== null &&
    typeof s.auto === 'object' &&
    typeof (s.auto as Record<string, unknown>).toolUseId === 'string'
      ? { toolUseId: (s.auto as { toolUseId: string }).toolUseId }
      : undefined
  return {
    kind: s.kind as TxStepKind,
    at: typeof s.at === 'number' ? s.at : 0,
    summary: s.summary,
    refs: Array.isArray(s.refs) ? s.refs.filter((r): r is string => typeof r === 'string') : [],
    outcome:
      typeof s.outcome === 'string' && OUTCOME_SET.has(s.outcome)
        ? (s.outcome as TxStepOutcome)
        : 'ok',
    ...(auto ? { auto } : {}),
  }
}

/** Any historical shape in, a TxRecord or null out. A malformed step fails
 *  the WHOLE record — the completion gate must never run over a silently
 *  truncated step list. */
function decodeRecord(raw: unknown): TxRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.intent !== 'string') return null
  if (typeof r.verdict !== 'string' || !VERDICT_SET.has(r.verdict)) return null
  if (!Array.isArray(r.steps)) return null
  const steps: TxStep[] = []
  for (const s of r.steps) {
    const step = decodeStep(s)
    if (step === null) return null
    steps.push(step)
  }
  return {
    _v: 1,
    id: r.id,
    intent: r.intent,
    owner: String(r.owner ?? '') as OwnerKey,
    projectRoot: typeof r.projectRoot === 'string' ? r.projectRoot : '',
    verdict: r.verdict as TxVerdict,
    steps,
    unresolved: Array.isArray(r.unresolved)
      ? r.unresolved.filter((u): u is string => typeof u === 'string')
      : [],
    openedAt: typeof r.openedAt === 'number' ? r.openedAt : 0,
    ...(typeof r.finishedAt === 'number' ? { finishedAt: r.finishedAt } : {}),
  }
}

function readRecordFile(dir: string, file: string, root: string): TxRecord | null {
  try {
    const record = decodeRecord(JSON.parse(readFileSync(path.join(dir, file), 'utf8')))
    // A field record missing its root key persists back to the store it was
    // FOUND in, not to a phantom ''-rooted path.
    if (record !== null && record.projectRoot === '') record.projectRoot = root
    return record
  } catch {
    return null
  }
}

// ── reads (null-not-throw; optional from defaults to the live cwd) ──────────

export function getTransaction(id: string, from?: string): TxRecord | null {
  if (!isRecordId(id)) return null
  try {
    const root = resolveRoot(from)
    return readRecordFile(storeDir(root), `${id}.json`, root)
  } catch {
    return null
  }
}

export function latestTransaction(from?: string): TxRecord | null {
  try {
    const root = resolveRoot(from)
    return readRecordFile(storeDir(root), POINTER_FILE, root)
  } catch {
    return null
  }
}

export function listTransactions(from?: string): TxListRow[] {
  try {
    const root = resolveRoot(from)
    const dir = storeDir(root)
    const rows: TxListRow[] = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json') || file === POINTER_FILE) continue
      if (!isRecordId(file.slice(0, -'.json'.length))) continue
      const record = readRecordFile(dir, file, root)
      if (record === null) continue // unreadable rows are skipped, never fatal
      rows.push({
        id: record.id,
        intent: record.intent.slice(0, INTENT_ROW_MAX),
        verdict: record.verdict,
        openedAt: record.openedAt,
      })
    }
    rows.sort((a, b) => b.openedAt - a.openedAt)
    return rows.slice(0, LIST_MAX)
  } catch {
    return []
  }
}

// ── the open-loop index ─────────────────────────────────────────────────────

// root → open transaction id (null = seeded, none open). The observer calls
// openTransactionIdFor on EVERY terminal tool event: after the one-time seed
// from the durable latest record (crash/resume survives), the answer is a
// single map hit. open/finish keep the entry true.
const openIndex = new Map<string, string | null>()

export function openTransactionIdFor(from?: string): string | null {
  let root: string
  try {
    root = resolveRoot(from)
  } catch {
    return null
  }
  const seeded = openIndex.get(root)
  if (seeded !== undefined) return seeded
  const latest = latestTransaction(root)
  const id = latest !== null && latest.verdict === 'open' ? latest.id : null
  openIndex.set(root, id)
  return id
}

// ── persistence (two atomic writes per persist) ─────────────────────────────

async function persist(record: TxRecord, root: string): Promise<void> {
  const dir = storeDir(root)
  const body = JSON.stringify(record, null, 2) + '\n'
  await durableAtomicPublish(path.join(dir, `${record.id}.json`), body)
  await durableAtomicPublish(path.join(dir, POINTER_FILE), body)
}

// ── open ────────────────────────────────────────────────────────────────────

export interface OpenTransactionOptions {
  owner: OwnerKey
  intent: string
  from?: string
}

export async function openTransaction(opts: OpenTransactionOptions): Promise<TxRecord> {
  const root = resolveRoot(opts.from)
  const now = Date.now()
  const record: TxRecord = {
    _v: 1,
    id: `${RECORD_PREFIX}${now}-${randomBytes(3).toString('hex')}`,
    intent: opts.intent,
    owner: opts.owner,
    projectRoot: root,
    verdict: 'open',
    steps: [],
    unresolved: [],
    openedAt: now,
  }
  await persist(record, root)
  openIndex.set(root, record.id)
  return record
}

// ── note ────────────────────────────────────────────────────────────────────

export interface NoteStepOptions {
  id: string
  owner: OwnerKey
  kind: TxStepKind
  summary: string
  refs?: string[]
  outcome?: TxStepOutcome
  from?: string
  auto?: TxStepAuto
}

export type NoteStepResult =
  | { state: 'ok'; record: TxRecord }
  | { state: 'refused'; reason: string }

/** Contract violations refuse with a typed reason — they never throw. */
export async function noteStep(opts: NoteStepOptions): Promise<NoteStepResult> {
  const root = resolveRoot(opts.from)
  const record = getTransaction(opts.id, root)
  if (record === null) {
    return { state: 'refused', reason: `no transaction ${opts.id}` }
  }
  if (record.verdict !== 'open') {
    return {
      state: 'refused',
      reason: `transaction ${opts.id} is ${record.verdict} — open a new transaction to keep working`,
    }
  }
  if (opts.auto !== undefined) {
    const toolUseId = opts.auto.toolUseId
    const already = record.steps.some(
      s => s.kind === opts.kind && s.auto !== undefined && s.auto.toolUseId === toolUseId,
    )
    // Exactly-once: a resumed/replayed event is ACCEPTED without a second row.
    if (already) return { state: 'ok', record }
  }
  if (record.steps.length >= STEP_CAP) {
    return {
      state: 'refused',
      reason: `transaction ${opts.id} is at the ${STEP_CAP}-step cap — finish it (completed/failed/abandoned) and open a new one`,
    }
  }
  const refs = opts.refs ?? []
  if (refs.length > 0) {
    // LAZY import (§DEPS-TDZ): the registry pulls the adapter graph.
    const { resolveResource } = await import('../resources/registry.js')
    const cwd = opts.from ?? getCwd()
    for (const ref of refs) {
      const resolved = await resolveResource(ref, { owner: opts.owner, cwd })
      if (resolved.state !== 'ok') {
        const note = resolved.note ? ` — ${resolved.note.slice(0, 160)}` : ''
        return {
          state: 'refused',
          reason: `evidence ref ${ref} does not resolve (${resolved.state}${note}); every ref must resolve at note time`,
        }
      }
    }
  }
  record.steps.push({
    kind: opts.kind,
    at: Date.now(),
    summary: opts.summary.slice(0, SUMMARY_MAX),
    refs,
    outcome: opts.outcome ?? 'ok',
    ...(opts.auto !== undefined ? { auto: opts.auto } : {}),
  })
  await persist(record, root)
  return { state: 'ok', record }
}

// ── the mechanical completion gate ──────────────────────────────────────────

/** The outstanding completion legs, computed against the LAST ok apply step.
 *  Pure — the tool prints it for open records; finish(completed) refuses on
 *  a non-empty result. One human-readable line per missing leg. */
export function completionGapsFor(record: TxRecord): string[] {
  const steps = record.steps
  let lastOkApply = -1
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (s !== undefined && s.kind === 'apply' && s.outcome === 'ok') lastOkApply = i
  }
  if (lastOkApply === -1) {
    // The remaining legs anchor on the apply — without one they are
    // indeterminate, so the honest report is this single line.
    return ["no ok 'apply' step — the loop never landed a change through the executing owners"]
  }
  const gaps: string[] = []
  const anchor = steps[lastOkApply]
  const after = steps.slice(lastOkApply + 1)
  if (anchor !== undefined && !anchor.refs.some(r => r.startsWith(RECEIPT_REF_PREFIX))) {
    gaps.push(
      "the last ok 'apply' step carries no mercury://receipt ref — bind the real change receipt",
    )
  }
  if (!after.some(s => s.kind === 'stabilize')) {
    gaps.push(
      "no 'stabilize' step after the last apply — the post-apply diagnostics barrier is unrecorded",
    )
  }
  if (
    !after.some(
      s => (s.kind === 'test' || s.kind === 'build' || s.kind === 'verify') && s.outcome === 'ok',
    )
  ) {
    gaps.push(
      "no ok 'test' | 'build' | 'verify' step after the last apply — run the real check and note it",
    )
  }
  const failedKinds = [...new Set(after.filter(s => s.outcome === 'failed').map(s => s.kind))]
  if (failedKinds.length > 0) {
    gaps.push(
      `failed step(s) after the last apply (${failedKinds.join(', ')}) — resolve them or finish as failed/abandoned`,
    )
  }
  return gaps
}

// ── finish ──────────────────────────────────────────────────────────────────

export interface FinishTransactionOptions {
  id: string
  owner: OwnerKey
  verdict: Exclude<TxVerdict, 'open'>
  unresolved?: string[]
  from?: string
}

export type FinishTransactionResult =
  | { state: 'ok'; record: TxRecord }
  | { state: 'refused'; reason: string; missing: string[] }

export async function finishTransaction(
  opts: FinishTransactionOptions,
): Promise<FinishTransactionResult> {
  const root = resolveRoot(opts.from)
  const record = getTransaction(opts.id, root)
  if (record === null) {
    return { state: 'refused', reason: `no transaction ${opts.id}`, missing: [] }
  }
  if (record.verdict !== 'open') {
    return {
      state: 'refused',
      reason: `transaction ${opts.id} already finished as ${record.verdict}`,
      missing: [],
    }
  }
  if (opts.verdict === 'completed') {
    const missing = completionGapsFor(record)
    if (missing.length > 0) {
      return {
        state: 'refused',
        reason: `completion refused — ${missing.length} missing leg(s): ${missing.join('; ')}`,
        missing,
      }
    }
  }
  if (opts.unresolved !== undefined && opts.unresolved.length > 0) {
    record.unresolved.push(...opts.unresolved) // append — never replace
  }
  record.verdict = opts.verdict
  record.finishedAt = Date.now()
  await persist(record, root)
  openIndex.set(root, null)
  return { state: 'ok', record }
}

// ── resume (report, never replay) ───────────────────────────────────────────

export interface ResumeTransactionOptions {
  id: string
  owner: OwnerKey
  from?: string
}

export interface ApplyRefCheck {
  ref: string
  resolves: boolean
  note: string
}

/** Reload the durable record after a restart and re-verify each apply step's
 *  refs against the CALLER's owner+cwd right now. Owner-scoped evidence
 *  (receipt rings) does not survive a new process — staleness is reported,
 *  never repaired, and NOTHING is replayed. Missing id ⇒ null. */
export async function resumeTransaction(
  opts: ResumeTransactionOptions,
): Promise<{ record: TxRecord; applyRefChecks: ApplyRefCheck[] } | null> {
  const record = getTransaction(opts.id, opts.from)
  if (record === null) return null
  const applyRefs = record.steps.filter(s => s.kind === 'apply').flatMap(s => s.refs)
  const applyRefChecks: ApplyRefCheck[] = []
  if (applyRefs.length > 0) {
    // LAZY import (§DEPS-TDZ) — same law as the note path.
    const { resolveResource } = await import('../resources/registry.js')
    const cwd = opts.from ?? getCwd()
    for (const ref of applyRefs) {
      const resolved = await resolveResource(ref, { owner: opts.owner, cwd })
      const live = resolved.state === 'ok'
      applyRefChecks.push({
        ref,
        resolves: live,
        note: live
          ? 'live: resolves for this owner now — nothing was replayed'
          : `stale (${resolved.state}): owner-scoped evidence does not survive a new process — re-verify against current files; nothing was replayed`,
      })
    }
  }
  return { record, applyRefChecks }
}
