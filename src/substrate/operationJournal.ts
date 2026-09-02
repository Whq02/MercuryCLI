/**
 * operationJournal — the Mercury operation journal (the crash-consistency
 * program): crash-consistent, idempotent multi-record state changes
 * above FileStore/durableAtomicPublish.
 *
 * A DURABLE OPERATION is any state change spanning more than one durable
 * record (team file + task root + registrations; run outcome + artifact +
 * handoff; …). The journal contract:
 *
 *   1. every operation derives a canonical owner + IDEMPOTENCY KEY;
 *   2. `prepared` is durably published BEFORE the first external step;
 *   3. every step is idempotent (safe to re-run) and is durably recorded
 *      as applied;
 *   4. the `committed` marker is durably published before the operation is
 *      exposed as complete; materialized files/UI are VIEWS of committed
 *      operations and can be rebuilt;
 *   5. startup/resume recovery scans incomplete operations and
 *      deterministically ROLLS FORWARD (kind declares its steps re-runnable)
 *      or COMPENSATES (undo, also idempotent) — recovery itself is
 *      resumable if the process dies again;
 *   6. re-running the same idempotency key returns the prior committed
 *      result — never duplicated work;
 *   7. committed/aborted history is bounded (compaction) without ever
 *      touching an incomplete operation.
 *
 * NOT distributed consensus: Mercury is local/private — one op-file per
 * operation under `<journalDir>/op-<id>.json` (each transition re-published
 * through the durable primitive), a `.lock` around scan/prepare, and pid
 * liveness for in-flight detection are sufficient. React-free, IO-tiny,
 * inspectable with `cat`.
 */

import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logForDebugging } from '../utils/debug.js'
import { getErrnoCode } from '../utils/errors.js'
import * as lockfile from '../utils/lockfile.js'
import { durableAtomicPublish, faultPoint } from './durablePublish.js'

export type DurableOperationState =
  | 'prepared'
  | 'applying'
  | 'committed'
  | 'compensating'
  | 'aborted'

export interface DurableOperationStep {
  id: string
  target: string
  expectedRevision?: number
  state: 'pending' | 'applied' | 'compensated'
  resultDigest?: string
}

export interface DurableOperation {
  schema: 1
  operationId: string
  ownerKey: string
  kind: string
  idempotencyKey: string
  state: DurableOperationState
  steps: readonly DurableOperationStep[]
  createdAt: string
  updatedAt: string
  /** The committing process — liveness distinguishes "in flight" from
   *  "died mid-operation" when a second caller hits the same key. */
  writerPid: number
  /** Small JSON-serializable committed result, replayed on an idempotent
   *  re-run of the same key. */
  result?: unknown
  /** Why the operation aborted/compensated (diagnostics). */
  failure?: string
  /** Small JSON-serializable kind-owned payload recorded at prepare time —
   *  what a recovery walker needs to reconcile from the record alone
   *  (the text-change-set target digests + staged temp + bundle
   *  paths — digests and paths only, NEVER file content). */
  payload?: unknown
}

const OP_PREFIX = 'op-'
const OP_SUFFIX = '.json'
/** Committed/aborted history kept per journal dir after compaction. */
const KEEP_TERMINAL_OPS = 20

const opPath = (dir: string, id: string): string => join(dir, `${OP_PREFIX}${id}${OP_SUFFIX}`)

/** The canonical on-disk path of one journal operation (kind-owned recovery
 *  walkers address records through this — the format stays ONE owner). */
export function journalOperationPath(dir: string, operationId: string): string {
  return opPath(dir, operationId)
}

function isTerminal(state: DurableOperationState): boolean {
  return state === 'committed' || state === 'aborted'
}

export function isTerminalJournalState(state: DurableOperationState): boolean {
  return isTerminal(state)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Liveness of the process that owns an in-flight operation. */
/** Operation ids currently INSIDE runJournaledOperation in this process.
 *  The pid test alone cannot see them: an op recorded by THIS pid is
 *  otherwise classified dead-by-default (the pid-reuse rule), so a sweep
 *  running beside a live same-process sibling — two multi-file applies in
 *  parallel sub-agents, whose path locks cover only their own files and
 *  whose per-directory chain serialises only the journalled section, not
 *  the sweep preceding it — rolled the sibling back mid-flight
 *  (release-hardening audit rank 27). */
const liveInProcessOperations = new Set<string>()

/** @internal registration bracket for runJournaledOperation. */
function markOperationLiveInProcess(operationId: string): void {
  liveInProcessOperations.add(operationId)
}
function clearOperationLiveInProcess(operationId: string): void {
  liveInProcessOperations.delete(operationId)
}

export function isJournalWriterAlive(op: DurableOperation): boolean {
  // A sibling executing in THIS process right now is alive — the registry
  // is the authority the pid test lacks. An unregistered same-pid record
  // is a leftover from a prior process generation (pid reuse) and stays
  // classified dead.
  if (liveInProcessOperations.has(op.operationId)) return true
  return pidAlive(op.writerPid) && op.writerPid !== process.pid
}

/** Durably re-publish an operation record (kind-owned recovery walkers use
 *  this for their transitions so the file format keeps ONE owner). */
export async function republishJournalOperation(
  dir: string,
  op: DurableOperation,
): Promise<void> {
  await publishOp(dir, op)
}

async function publishOp(dir: string, op: DurableOperation): Promise<void> {
  await durableAtomicPublish(
    opPath(dir, op.operationId),
    JSON.stringify({ ...op, updatedAt: new Date().toISOString() }, null, 2),
  )
}

function decodeOp(raw: string): DurableOperation | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DurableOperation>
    if (
      parsed &&
      parsed.schema === 1 &&
      typeof parsed.operationId === 'string' &&
      typeof parsed.kind === 'string' &&
      typeof parsed.idempotencyKey === 'string' &&
      typeof parsed.state === 'string' &&
      Array.isArray(parsed.steps)
    ) {
      return parsed as DurableOperation
    }
  } catch {
    /* fall through */
  }
  return null
}

/** Every decodable operation in a journal dir (missing dir ⇒ []). */
export async function listJournalOperations(dir: string): Promise<DurableOperation[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: DurableOperation[] = []
  for (const name of names) {
    if (!name.startsWith(OP_PREFIX) || !name.endsWith(OP_SUFFIX)) continue
    try {
      const op = decodeOp(await readFile(join(dir, name), 'utf-8'))
      if (op) out.push(op)
    } catch {
      /* unreadable op file — recovery reports it as waiting */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

// Same-process journal ops serialize per dir (mirrors the FileStore opChain).
const dirChains = new Map<string, Promise<void>>()

async function withJournalLock<R>(dir: string, fn: () => Promise<R>): Promise<R> {
  mkdirSync(dir, { recursive: true })
  const lockTarget = join(dir, '.lock')
  try {
    await writeFile(lockTarget, '', { flag: 'wx' })
  } catch (e) {
    if (getErrnoCode(e) !== 'EEXIST') throw e
  }
  const release = await lockfile.lock(lockTarget, {
    retries: { retries: 30, minTimeout: 5, maxTimeout: 100, randomize: true },
  })
  try {
    return await fn()
  } finally {
    await release()
  }
}

export interface JournalStepSpec {
  id: string
  target: string
  /** Idempotent apply — safe to re-run on recovery roll-forward. */
  run: () => Promise<{ digest?: string } | void>
}

export interface JournaledOperationSpec<R> {
  journalDir: string
  ownerKey: string
  kind: string
  idempotencyKey: string
  /** Kind-owned payload durably recorded in the `prepared` publication. */
  payload?: unknown
  steps: JournalStepSpec[]
  /** Idempotent undo of any partial effects (invoked on failure AND by
   *  recovery compensation — must tolerate half-applied state). */
  compensate?: () => Promise<void>
  /** The small committed result recorded for idempotent replay. */
  result?: () => R
}

export type JournaledOperationOutcome<R> =
  | { outcome: 'committed'; operationId: string; result: R | undefined; replayed: false }
  | { outcome: 'replayed'; operationId: string; result: R | undefined; replayed: true }
  | { outcome: 'in-flight'; operationId: string; result?: undefined; replayed?: undefined }

/**
 * Run a multi-record state change as ONE journaled operation. See the module
 * header for the contract. Throws (after durable compensation bookkeeping)
 * when a step or the compensation fails — the journal then holds the exact
 * state recovery needs.
 */
export async function runJournaledOperation<R>(
  spec: JournaledOperationSpec<R>,
): Promise<JournaledOperationOutcome<R>> {
  const { journalDir } = spec
  // Serialize same-process operations per journal dir.
  const prev = dirChains.get(journalDir) ?? Promise.resolve()
  let done!: () => void
  const gate = new Promise<void>(r => {
    done = r
  })
  dirChains.set(
    journalDir,
    prev.then(
      () => gate,
      () => gate,
    ),
  )
  await prev.catch(() => {})
  try {
    return await runJournaledOperationInner(spec)
  } finally {
    done()
  }
}

async function runJournaledOperationInner<R>(
  spec: JournaledOperationSpec<R>,
): Promise<JournaledOperationOutcome<R>> {
  const { journalDir } = spec
  // ── scan + prepare under the journal lock (idempotency is decided here) ──
  const prepared = await withJournalLock(journalDir, async (): Promise<
    | { action: 'run'; op: DurableOperation }
    | JournaledOperationOutcome<R>
  > => {
    const existing = (await listJournalOperations(journalDir)).filter(
      o => o.idempotencyKey === spec.idempotencyKey,
    )
    const committed = existing.filter(o => o.state === 'committed').at(-1)
    if (committed) {
      return {
        outcome: 'replayed',
        operationId: committed.operationId,
        result: committed.result as R | undefined,
        replayed: true,
      }
    }
    const incomplete = existing.find(o => !isTerminal(o.state))
    if (incomplete) {
      if (isJournalWriterAlive(incomplete)) {
        // A live process — or a registered live sibling in THIS process —
        // owns this key right now: never race it. (The bare pid test here
        // called a prior generation's same-pid leftover live too; the one
        // liveness owner classifies that dead and recovers it below.)
        return { outcome: 'in-flight', operationId: incomplete.operationId }
      }
      // The writer died mid-operation: recover THIS op before proceeding —
      // compensation is the deterministic default for a fresh re-run (the
      // caller is about to redo the work through its own steps).
      if (spec.compensate) {
        await transition(journalDir, incomplete, 'compensating', {
          failure: 'writer died mid-operation; compensated before re-run',
        })
        await spec.compensate()
        await transition(journalDir, incomplete, 'aborted')
      } else {
        await transition(journalDir, incomplete, 'aborted', {
          failure: 'writer died mid-operation; no compensation declared',
        })
      }
    }
    const op: DurableOperation = {
      schema: 1,
      operationId: randomUUID(),
      ownerKey: spec.ownerKey,
      kind: spec.kind,
      idempotencyKey: spec.idempotencyKey,
      state: 'prepared',
      steps: spec.steps.map(s => ({ id: s.id, target: s.target, state: 'pending' })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      writerPid: process.pid,
      ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
    }
    // Registered live-in-process BEFORE the first durable record exists, so
    // no sweep can ever observe the record without the registration.
    markOperationLiveInProcess(op.operationId)
    try {
      // Rule 2: `prepared` is durable BEFORE the first external step.
      await publishOp(journalDir, op)
      faultPoint('journal-after-prepare', opPath(journalDir, op.operationId))
    } catch (e) {
      clearOperationLiveInProcess(op.operationId)
      throw e
    }
    return { action: 'run', op }
  })
  if (!('action' in prepared)) return prepared

  let op = prepared.op
  try {
    op = { ...op, state: 'applying' }
    await publishOp(journalDir, op)
    for (const stepSpec of spec.steps) {
      faultPoint('journal-before-step', `${opPath(journalDir, op.operationId)}#${stepSpec.id}`)
      const res = await stepSpec.run()
      op = {
        ...op,
        steps: op.steps.map(s =>
          s.id === stepSpec.id
            ? { ...s, state: 'applied' as const, ...(res?.digest ? { resultDigest: res.digest } : {}) }
            : s,
        ),
      }
      // Rule 4: applied steps are durable.
      await publishOp(journalDir, op)
      faultPoint('journal-after-step', `${opPath(journalDir, op.operationId)}#${stepSpec.id}`)
    }
    const result = spec.result?.()
    op = { ...op, state: 'committed', ...(result !== undefined ? { result } : {}) }
    faultPoint('journal-before-commit', opPath(journalDir, op.operationId))
    // Rule 5: the commit marker is durable before the op is exposed complete.
    await publishOp(journalDir, op)
    // Opportunistic bounded compaction (never touches incomplete ops).
    void compactJournalDir(journalDir).catch(() => {})
    return { outcome: 'committed', operationId: op.operationId, result, replayed: false }
  } catch (e) {
    // Durable compensation bookkeeping — recovery can resume it on re-crash.
    try {
      op = { ...op, state: 'compensating', failure: String(e).slice(0, 300) }
      await publishOp(journalDir, op)
      if (spec.compensate) await spec.compensate()
      op = {
        ...op,
        state: 'aborted',
        steps: op.steps.map(s => (s.state === 'applied' ? { ...s, state: 'compensated' as const } : s)),
      }
      await publishOp(journalDir, op)
    } catch (inner) {
      logForDebugging(
        `[journal] compensation for ${op.kind}/${op.operationId} incomplete (recovery will resume): ${inner}`,
      )
    }
    throw e
  } finally {
    // The operation reached a terminal state (or its failure is recorded
    // for recovery): it is no longer live in this process.
    clearOperationLiveInProcess(prepared.op.operationId)
  }
}

async function transition(
  dir: string,
  op: DurableOperation,
  state: DurableOperationState,
  extra?: Partial<Pick<DurableOperation, 'failure' | 'result'>>,
): Promise<void> {
  await publishOp(dir, { ...op, ...extra, state })
}

// ── recovery ─────────────────────────────────────────────────────────────────

export interface JournalRecoveryHandler {
  /** Re-run the kind's materialization idempotently to completion (the op's
   *  steps were all applied — only the commit marker is missing, or the kind
   *  declares its steps re-runnable from the journal record alone). */
  rollForward?: (op: DurableOperation) => Promise<void>
  /** Idempotent undo of the kind's partial effects. */
  compensate?: (op: DurableOperation) => Promise<void>
}

export interface JournalRecoverySummary {
  scanned: number
  rolledForward: string[]
  compensated: string[]
  /** Incomplete ops with a LIVE writer or no registered handler — left
   *  untouched, reported. */
  waiting: string[]
  unrecoverable: string[]
}

/**
 * Deterministic startup/resume recovery for one journal dir:
 *   · committed/aborted ⇒ terminal (skipped);
 *   · a live writer's op ⇒ waiting (never raced);
 *   · applying with EVERY step applied ⇒ roll forward (commit);
 *   · prepared/applying (partial) ⇒ handler rollForward if declared, else
 *     compensate ⇒ aborted;
 *   · compensating ⇒ resume compensation ⇒ aborted;
 *   · unknown kind ⇒ waiting (a newer build's op is never guessed at).
 * Idempotent across repeated starts; resumable mid-recovery.
 */
export async function recoverJournalDir(
  dir: string,
  handlers: Record<string, JournalRecoveryHandler>,
): Promise<JournalRecoverySummary> {
  const summary: JournalRecoverySummary = {
    scanned: 0,
    rolledForward: [],
    compensated: [],
    waiting: [],
    unrecoverable: [],
  }
  const ops = await listJournalOperations(dir)
  for (const op of ops) {
    summary.scanned++
    if (isTerminal(op.state)) continue
    // Through the ONE liveness owner — the in-process registry included, so
    // a live same-process sibling is 'waiting', never compensated under it.
    if (isJournalWriterAlive(op)) {
      summary.waiting.push(op.operationId)
      continue
    }
    const handler = handlers[op.kind]
    if (!handler) {
      summary.waiting.push(op.operationId)
      continue
    }
    try {
      faultPoint('journal-recover-op', opPath(dir, op.operationId))
      if (op.state === 'compensating') {
        if (handler.compensate) await handler.compensate(op)
        await transition(dir, op, 'aborted')
        summary.compensated.push(op.operationId)
        continue
      }
      const allApplied = op.steps.length > 0 && op.steps.every(s => s.state === 'applied')
      if (allApplied && handler.rollForward) {
        await handler.rollForward(op)
        await transition(dir, op, 'committed')
        summary.rolledForward.push(op.operationId)
        continue
      }
      if (handler.compensate) {
        await transition(dir, op, 'compensating', {
          failure: op.failure ?? 'recovered: writer died mid-operation',
        })
        await handler.compensate(op)
        await transition(dir, op, 'aborted')
        summary.compensated.push(op.operationId)
        continue
      }
      if (handler.rollForward) {
        // The kind declares full re-runnability from the record alone.
        await handler.rollForward(op)
        await transition(dir, op, 'committed')
        summary.rolledForward.push(op.operationId)
        continue
      }
      summary.waiting.push(op.operationId)
    } catch (e) {
      logForDebugging(`[journal] recovery of ${op.kind}/${op.operationId} failed: ${e}`)
      summary.unrecoverable.push(op.operationId)
    }
  }
  return summary
}

/**
 * Bound committed/aborted history: keep the newest {@link KEEP_TERMINAL_OPS}
 * terminal ops, delete older ones. NEVER touches an incomplete operation or
 * an undecodable file (recovery evidence).
 */
export async function compactJournalDir(
  dir: string,
  opts?: { keepTerminal?: number },
): Promise<number> {
  const keep = opts?.keepTerminal ?? KEEP_TERMINAL_OPS
  const ops = await listJournalOperations(dir)
  const terminal = ops.filter(o => isTerminal(o.state))
  const excess = Math.max(0, terminal.length - keep)
  let removed = 0
  for (const op of terminal.slice(0, excess)) {
    try {
      await unlink(opPath(dir, op.operationId))
      removed++
    } catch {
      /* raced — fine */
    }
  }
  return removed
}
