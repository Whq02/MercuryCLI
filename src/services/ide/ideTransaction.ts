import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { projectHomeStore } from '../../utils/projectHomeStores.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { workspaceVerifiable } from '../../utils/verification/verificationState.js'
import { findPythonProjectRoot } from './pythonProject.js'

export function ideLoopEnabled(): boolean {
  return flagEnabled('MERCURY_IDE_LOOP')
}


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

export interface TxStepAuto {
  toolUseId: string
}

export interface TxStep {
  kind: TxStepKind
  at: number
  summary: string
  refs: string[]
  outcome: TxStepOutcome
  auto?: TxStepAuto
}

export interface TxRecord {
  _v: 1
  id: string
  intent: string
  owner: OwnerKey
  projectRoot: string
  verdict: TxVerdict
  steps: TxStep[]
  unresolved: string[]
  openedAt: number
  finishedAt?: number
  elided?: number
}

export interface TxListRow {
  id: string
  intent: string
  verdict: TxVerdict
  openedAt: number
}


const STORE_SEGMENT = 'ide-transactions'
const RECORD_PREFIX = 'tx-'
const POINTER_FILE = 'latest.json'
const STEP_CAP = 100
const SUMMARY_MAX = 300
const LIST_MAX = 50
const INTENT_ROW_MAX = 120
const RECEIPT_REF_PREFIX = 'mercury://receipt'
const ID_PATTERN = /^[a-z][a-z0-9-]{2,79}$/

function isRecordId(id: string): boolean {
  return id !== 'latest' && ID_PATTERN.test(id)
}


const rootMemo = new Map<string, string>()
const ROOT_MEMO_CAP = 256

export function resolveRoot(from?: string): string {
  const key = from ?? getCwd()
  const memoized = rootMemo.get(key)
  if (memoized !== undefined) return memoized
  const root = findPythonProjectRoot(key).root
  if (rootMemo.size >= ROOT_MEMO_CAP) rootMemo.clear()
  rootMemo.set(key, root)
  return root
}

function storeDir(root: string): string {
  return projectHomeStore(root, STORE_SEGMENT)
}


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
    ...(typeof r.elided === 'number' && Number.isSafeInteger(r.elided) && r.elided > 0 ? { elided: r.elided } : {}),
  }
}

function readRecordFile(dir: string, file: string, root: string): TxRecord | null {
  try {
    const record = decodeRecord(JSON.parse(readFileSync(path.join(dir, file), 'utf8')))
    if (record !== null && record.projectRoot === '') record.projectRoot = root
    return record
  } catch {
    return null
  }
}


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
      if (record === null) continue
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


async function persist(record: TxRecord, root: string): Promise<void> {
  const dir = storeDir(root)
  const body = JSON.stringify(record, null, 2) + '\n'
  await durableAtomicPublish(path.join(dir, `${record.id}.json`), body)
  await durableAtomicPublish(path.join(dir, POINTER_FILE), body)
}


export interface OpenTransactionOptions {
  owner: OwnerKey
  intent: string
  from?: string
  steps?: TxStep[]
  elided?: number
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
    steps: (opts.steps ?? []).slice(-STEP_CAP),
    unresolved: [],
    openedAt: now,
    ...((opts.elided ?? 0) + Math.max(0, (opts.steps?.length ?? 0) - STEP_CAP) > 0
      ? { elided: (opts.elided ?? 0) + Math.max(0, (opts.steps?.length ?? 0) - STEP_CAP) }
      : {}),
  }
  await persist(record, root)
  openIndex.set(root, record.id)
  return record
}


export interface NoteStepOptions {
  id: string
  owner: OwnerKey
  kind: TxStepKind
  summary: string
  refs?: string[]
  outcome?: TxStepOutcome
  from?: string
  auto?: TxStepAuto
  getAppState?: () => unknown
}

export type NoteStepResult =
  | { state: 'ok'; record: TxRecord }
  | { state: 'refused'; reason: string }

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
    if (already) return { state: 'ok', record }
  }
  const refs = opts.refs ?? []
  if (refs.length > 0) {
    const { resolveResource } = await import('../resources/registry.js')
    const cwd = opts.from ?? getCwd()
    for (const ref of refs) {
      const resolved = await resolveResource(ref, {
        owner: opts.owner,
        cwd,
        ...(opts.getAppState ? { getAppState: opts.getAppState } : {}),
      })
      if (resolved.state !== 'ok') {
        const note = resolved.note ? ` — ${resolved.note.slice(0, 160)}` : ''
        return {
          state: 'refused',
          reason: `evidence ref ${ref} does not resolve (${resolved.state}${note}); every ref must resolve at note time`,
        }
      }
    }
  }
  appendTransactionStep(record, {
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


export function appendTransactionStep(record: Pick<TxRecord, 'steps' | 'elided'>, step: TxStep): boolean {
  if (step.auto && record.steps.some(row => row.kind === step.kind && row.auto?.toolUseId === step.auto!.toolUseId)) return false
  record.steps.push(step)
  const dropped = Math.max(0, record.steps.length - STEP_CAP)
  if (dropped) {
    record.steps.splice(0, dropped)
    record.elided = (record.elided ?? 0) + dropped
  }
  return true
}

export function lastLandedChangeIndex(steps: readonly TxStep[]): number {
  return steps.findLastIndex(step => step.kind === 'apply' && step.outcome === 'ok')
}

export function isCheckStep(step: TxStep): boolean {
  return (step.kind === 'test' || step.kind === 'build' || step.kind === 'verify') &&
    (step.outcome === 'ok' || step.outcome === 'failed')
}

function shortStep(step: TxStep): string {
  const text = step.summary.replace(/^\[auto\] /, '').split(' — ')[0] ?? ''
  return text.length > 100 ? `${text.slice(0, 99)}…` : text
}

export function completionGapsFor(record: TxRecord): string[] {
  const last = lastLandedChangeIndex(record.steps)
  if (last === -1) {
    return ['no change has landed on this record — finish it with verdict "abandoned"; the next change starts a new record']
  }
  const anchor = record.steps[last]!
  const after = record.steps.slice(last + 1)
  const gaps: string[] = []
  if (!anchor.refs.some(ref => ref.startsWith(`${RECEIPT_REF_PREFIX}/`))) {
    gaps.push('the last change carries no mercury://receipt ref (a record from an older build) — finish it with verdict "abandoned"; the next change starts a new record')
  }
  const check = after.findLast(isCheckStep)
  if (!check) {
    const next = workspaceVerifiable(record.projectRoot, record.owner)
      ? "run the project's tests or build through Bash or Test; the result is recorded here by itself"
      : 'Mercury finds no test or build setup here, so read each changed file back in full (Read without offset or limit), or run a check through Bash or Test; either is recorded here by itself'
    gaps.push(`no check has run since the last change (${shortStep(anchor)}) — ${next}`)
  } else if (check.outcome === 'failed') {
    gaps.push(`the newest check since the last change failed (${shortStep(check)}) — fix the cause and run it again, or finish with verdict "failed"`)
  }
  const failed = after.find(step => step.kind === 'apply' && (step.outcome === 'failed' || step.outcome === 'indeterminate'))
  if (failed) {
    gaps.push(`a change after the last landed one ended ${failed.outcome} (${shortStep(failed)}) — re-read the file, then redo or undo that change`)
  }
  return gaps
}


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
    record.unresolved.push(...opts.unresolved)
  }
  record.verdict = opts.verdict
  record.finishedAt = Date.now()
  await persist(record, root)
  openIndex.set(root, null)
  const { clearTxJournal } = await import('./txAutoCapture.js')
  clearTxJournal(root)
  return { state: 'ok', record }
}


export interface ResumeTransactionOptions {
  id: string
  owner: OwnerKey
  from?: string
  getAppState?: () => unknown
}

export interface ApplyRefCheck {
  ref: string
  resolves: boolean
  note: string
}

export async function resumeTransaction(
  opts: ResumeTransactionOptions,
): Promise<{ record: TxRecord; applyRefChecks: ApplyRefCheck[] } | null> {
  const record = getTransaction(opts.id, opts.from)
  if (record === null) return null
  const applyRefs = record.steps.filter(s => s.kind === 'apply').flatMap(s => s.refs)
  const applyRefChecks: ApplyRefCheck[] = []
  if (applyRefs.length > 0) {
    const { resolveResource } = await import('../resources/registry.js')
    const cwd = opts.from ?? getCwd()
    for (const ref of applyRefs) {
      const resolved = await resolveResource(ref, {
        owner: opts.owner,
        cwd,
        ...(opts.getAppState ? { getAppState: opts.getAppState } : {}),
      })
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
