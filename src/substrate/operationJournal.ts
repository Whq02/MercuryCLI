
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
  writerPid: number
  result?: unknown
  failure?: string
  payload?: unknown
}

const OP_PREFIX = 'op-'
const OP_SUFFIX = '.json'
const KEEP_TERMINAL_OPS = 20

const opPath = (dir: string, id: string): string => join(dir, `${OP_PREFIX}${id}${OP_SUFFIX}`)

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

const liveInProcessOperations = new Set<string>()

function markOperationLiveInProcess(operationId: string): void {
  liveInProcessOperations.add(operationId)
}
function clearOperationLiveInProcess(operationId: string): void {
  liveInProcessOperations.delete(operationId)
}

export function isJournalWriterAlive(op: DurableOperation): boolean {
  if (liveInProcessOperations.has(op.operationId)) return true
  return pidAlive(op.writerPid) && op.writerPid !== process.pid
}

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
  }
  return null
}

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
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

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
  run: () => Promise<{ digest?: string } | void>
}

export interface JournaledOperationSpec<R> {
  journalDir: string
  ownerKey: string
  kind: string
  idempotencyKey: string
  payload?: unknown
  steps: JournalStepSpec[]
  compensate?: () => Promise<void>
  result?: () => R
}

export type JournaledOperationOutcome<R> =
  | { outcome: 'committed'; operationId: string; result: R | undefined; replayed: false }
  | { outcome: 'replayed'; operationId: string; result: R | undefined; replayed: true }
  | { outcome: 'in-flight'; operationId: string; result?: undefined; replayed?: undefined }

export async function runJournaledOperation<R>(
  spec: JournaledOperationSpec<R>,
): Promise<JournaledOperationOutcome<R>> {
  const { journalDir } = spec
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
        return { outcome: 'in-flight', operationId: incomplete.operationId }
      }
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
    markOperationLiveInProcess(op.operationId)
    try {
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
      await publishOp(journalDir, op)
      faultPoint('journal-after-step', `${opPath(journalDir, op.operationId)}#${stepSpec.id}`)
    }
    const result = spec.result?.()
    op = { ...op, state: 'committed', ...(result !== undefined ? { result } : {}) }
    faultPoint('journal-before-commit', opPath(journalDir, op.operationId))
    await publishOp(journalDir, op)
    void compactJournalDir(journalDir).catch(() => {})
    return { outcome: 'committed', operationId: op.operationId, result, replayed: false }
  } catch (e) {
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


export interface JournalRecoveryHandler {
  rollForward?: (op: DurableOperation) => Promise<void>
  compensate?: (op: DurableOperation) => Promise<void>
}

export interface JournalRecoverySummary {
  scanned: number
  rolledForward: string[]
  compensated: string[]
  waiting: string[]
  unrecoverable: string[]
}

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
    }
  }
  return removed
}
