// ============================================================================
//  services/eval/kernelManager — retained kernels, keyed and governed.
//
//  Keying (spec'd): (owner, language, normalized cwd, interpreter). One cell
//  at a time per key — a per-key promise chain serializes callers even when
//  two arrive concurrently. Resets coalesce. A kernel that dies mid-cell is
//  replaced and the cell retried ONCE, annotated. Lifecycle writes journal
//  rows so a later boot can report (and reap) orphaned interpreters. A kernel
//  idle past EVAL_IDLE_TTL_MS is reaped through its own key chain (never
//  mid-cell) and the NEXT cell on the key says so — state loss is annotated,
//  never silent.
//
//  The budget law (spec'd, ruled): the cell's RUNTIME budget counts only
//  while the kernel computes — any in-flight bridge call pauses it. The
//  WALL ceiling bounds the whole call (bridge ping-pong livelock included)
//  but pauses while a PERMISSION ASK is pending: an operator-paced wait
//  must never kill a cell.
// ============================================================================

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logForDebugging } from '../../utils/debug.js'
import { killProcessGroup } from '../../utils/processGroup.js'
import { getToolResultsDir } from '../../utils/toolResultStorage.js'
import { BoundedStreamSink } from './outputSink.js'
import {
  isTerminalJournalState,
  isJournalWriterAlive,
  listJournalOperations,
  republishJournalOperation,
  type DurableOperation,
} from '../../substrate/operationJournal.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import {
  EVAL_DEFAULT_TIMEOUT_SECONDS,
  EVAL_IDLE_SWEEP_MS,
  EVAL_IDLE_TTL_MS,
  EVAL_INTERRUPT_ESCALATION_MS,
  EVAL_MAX_TIMEOUT_SECONDS,
  EVAL_WALL_CEILING_MS,
  unavailableLanguageMessage,
  type EvalCellInput,
  type EvalCellOutcome,
  type EvalDisplay,
  type EvalLanguage,
} from './contracts.js'
import { evalAvailability } from './interpreters.js'
import { buildKernelEnv } from './kernelEnv.js'
import { transformJsCell } from './jsCellTransform.js'
import { ensureJsRunner, ensurePyRunner } from './runnerCache.js'
import { ProcKernel, type CellEnd } from './procKernel.js'
import type { BridgeRequestFrame } from './protocol.js'

const MAX_DISPLAYS_PER_CELL = 24

// ── Journal ────────────────────────────────────────────────────────────────

export function evalJournalDir(): string {
  return join(getMercuryHome(), 'eval', 'journal')
}

async function journalKernel(
  operationId: string,
  state: 'applying' | 'committed' | 'aborted',
  payload: { pid?: number; language: EvalLanguage; interpreter: string; cwd: string; owner: string },
  failure?: string,
): Promise<void> {
  try {
    mkdirSync(evalJournalDir(), { recursive: true })
    const now = new Date().toISOString()
    const op: DurableOperation = {
      schema: 1,
      operationId,
      ownerKey: payload.owner,
      kind: 'eval.kernel',
      idempotencyKey: operationId,
      state,
      steps: [],
      createdAt: now,
      updatedAt: now,
      writerPid: process.pid,
      payload,
      ...(failure ? { failure } : {}),
    }
    await republishJournalOperation(evalJournalDir(), op)
  } catch (error) {
    logForDebugging(`eval journal write failed: ${String(error)}`)
  }
}

let recoveryRan = false
/** Lazy boot recovery: report rows whose writer died mid-flight, reap any
 *  interpreter still alive under them, close the rows. Returns the report. */
export async function recoverEvalKernels(): Promise<string[]> {
  const notes: string[] = []
  try {
    const ops = await listJournalOperations(evalJournalDir())
    for (const op of ops) {
      if (op.kind !== 'eval.kernel' || isTerminalJournalState(op.state)) continue
      if (isJournalWriterAlive(op)) continue
      const payload = (op.payload ?? {}) as { pid?: number; language?: string; interpreter?: string }
      let reaped = false
      if (typeof payload.pid === 'number') {
        try {
          // The one cross-platform kill owner: group/tree semantics reap the
          // orphaned kernel's own descendants too, on POSIX and win32 alike.
          const pid = payload.pid
          killProcessGroup({ pid, kill: signal => (process.kill(pid, signal), true) })
          reaped = true
        } catch {
          /* already gone */
        }
      }
      notes.push(
        `orphaned ${payload.language ?? '?'} kernel from pid ${op.writerPid} (kernel pid ${payload.pid ?? '?'}) — ${reaped ? 'reaped' : 'already gone'}`,
      )
      await republishJournalOperation(evalJournalDir(), {
        ...op,
        state: 'aborted',
        failure: reaped ? 'orphan reaped at recovery' : 'orphan already gone at recovery',
      })
    }
  } catch (error) {
    logForDebugging(`eval kernel recovery failed: ${String(error)}`)
  }
  return notes
}

// ── The pauseable deadline ─────────────────────────────────────────────────

class PauseableDeadline {
  private consumedMs = 0
  private runningSince: number | null = null
  private pauseDepth = 0
  constructor(private readonly limitMs: number | null) {}

  start(): void {
    if (this.limitMs !== null && this.runningSince === null && this.pauseDepth === 0) {
      this.runningSince = Date.now()
    }
  }

  pause(): void {
    this.pauseDepth += 1
    if (this.runningSince !== null) {
      this.consumedMs += Date.now() - this.runningSince
      this.runningSince = null
    }
  }

  resume(): void {
    this.pauseDepth = Math.max(0, this.pauseDepth - 1)
    if (this.pauseDepth === 0 && this.limitMs !== null && this.runningSince === null) {
      this.runningSince = Date.now()
    }
  }

  consumed(): number {
    return this.consumedMs + (this.runningSince !== null ? Date.now() - this.runningSince : 0)
  }

  expired(): boolean {
    return this.limitMs !== null && this.consumed() >= this.limitMs
  }

  /** Milliseconds until expiry from NOW while running (null: disabled or
   *  paused). */
  msLeft(): number | null {
    if (this.limitMs === null) return null
    if (this.runningSince === null) return null
    return Math.max(0, this.limitMs - this.consumed())
  }
}

// ── The manager ────────────────────────────────────────────────────────────

export interface CellBudgetHooks {
  bridgeBegin: () => void
  bridgeEnd: () => void
  /** Operator-paced permission waits — pause the WALL ceiling too. */
  askBegin: () => void
  askEnd: () => void
}

export type BridgeServer = (
  frame: BridgeRequestFrame,
  budget: CellBudgetHooks,
) => Promise<{ ok: boolean; value?: unknown; error?: string }>

export interface RunCellRequest {
  owner: string
  cwd: string
  input: EvalCellInput
  abortSignal: AbortSignal
  serveBridge: BridgeServer
  onLiveOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

interface KernelEntry {
  kernel: ProcKernel
  language: EvalLanguage
  interpreter: string
  cwd: string
  owner: string
  operationId: string
  /** Stamped at spawn and at every cell's settle — the idle reaper's clock. */
  lastUsedAt: number
}

/** Exported for proof injection only — the product uses the singleton. */
export class EvalKernelManager {
  private kernels = new Map<string, KernelEntry>()
  private chains = new Map<string, Promise<unknown>>()
  private exitHookInstalled = false
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** Keys whose kernel the idle reaper disposed, with the idle span and the
   *  owner (owner-disposal clears its rows) — the next cell on the key
   *  consumes the row into an honesty annotation. */
  private reapedIdle = new Map<string, { idleMs: number; owner: string }>()

  constructor(private readonly tuning: { idleTtlMs?: number; idleSweepMs?: number } = {}) {}

  private get idleTtlMs(): number {
    return this.tuning.idleTtlMs ?? EVAL_IDLE_TTL_MS
  }

  private get idleSweepMs(): number {
    return this.tuning.idleSweepMs ?? EVAL_IDLE_SWEEP_MS
  }

  private key(owner: string, language: EvalLanguage, cwd: string, interpreter: string): string {
    return [owner, language, resolve(cwd), interpreter].join('\u0000')
  }

  /** Serialize work per (owner,language,cwd,interpreter) — cells never
   *  overlap on one kernel. */
  private enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(work, work)
    this.chains.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    process.on('exit', () => {
      // Synchronous last resort: kernels are children and must die with the
      // session (kill-the-whole-descendant-tree law).
      for (const entry of this.kernels.values()) entry.kernel.kill()
    })
  }

  private async spawnKernel(
    owner: string,
    language: EvalLanguage,
    cwd: string,
    interpreter: string,
  ): Promise<KernelEntry | { spawnError: string }> {
    this.installExitHook()
    if (!recoveryRan) {
      recoveryRan = true
      const notes = await recoverEvalKernels()
      for (const note of notes) logForDebugging(`eval recovery: ${note}`)
    }
    const runner = language === 'py' ? ensurePyRunner() : ensureJsRunner()
    const kernel = new ProcKernel({
      command: interpreter,
      args: [runner],
      cwd,
      env: buildKernelEnv(),
    })
    if (kernel.pid === undefined) return { spawnError: `failed to spawn ${interpreter}` }
    const operationId = `kernel-${process.pid}-${kernel.pid}-${Date.now()}`
    const entry: KernelEntry = { kernel, language, interpreter, cwd, owner, operationId, lastUsedAt: Date.now() }
    await journalKernel(operationId, 'applying', {
      pid: kernel.pid,
      language,
      interpreter,
      cwd,
      owner,
    })
    const ready = await kernel.handshake(cwd)
    if (!ready) {
      await kernel.dispose()
      await journalKernel(operationId, 'aborted', { pid: kernel.pid, language, interpreter, cwd, owner }, 'handshake failed')
      return { spawnError: `${interpreter} started but the kernel handshake failed` }
    }
    kernel.onExit(() => {
      void journalKernel(operationId, 'committed', { pid: kernel.pid, language, interpreter, cwd, owner })
      const key = this.key(owner, language, cwd, interpreter)
      if (this.kernels.get(key) === entry) this.kernels.delete(key)
      this.syncSweepTimer()
    })
    this.kernels.set(this.key(owner, language, cwd, interpreter), entry)
    this.syncSweepTimer()
    return entry
  }

  /** The idle reaper's timer follows the kernel map: alive only while a
   *  kernel exists, unref'd so it never holds the process open. */
  private syncSweepTimer(): void {
    if (this.kernels.size > 0) {
      if (this.sweepTimer === null) {
        this.sweepTimer = setInterval(() => this.sweep(), this.idleSweepMs)
        this.sweepTimer.unref?.()
      }
    } else if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /** Reap kernels idle past the TTL. Disposal rides the per-key chain, so a
   *  RUNNING cell is never reaped mid-flight; the chain slot re-checks
   *  idleness because a cell may have settled between scan and slot. */
  private sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.kernels) {
      if (now - entry.lastUsedAt < this.idleTtlMs) continue
      void this.enqueue(key, async () => {
        const current = this.kernels.get(key)
        if (current !== entry) return
        const idleMs = Date.now() - current.lastUsedAt
        if (idleMs < this.idleTtlMs) return
        await this.disposeKey(key)
        this.reapedIdle.set(key, { idleMs, owner: current.owner })
      })
    }
  }

  private async getOrSpawn(
    owner: string,
    language: EvalLanguage,
    cwd: string,
    interpreter: string,
    annotations: string[],
  ): Promise<KernelEntry | { spawnError: string }> {
    const key = this.key(owner, language, cwd, interpreter)
    const existing = this.kernels.get(key)
    if (existing) {
      if (existing.kernel.alive) return existing
      this.kernels.delete(key)
      this.syncSweepTimer()
      annotations.push('the retained kernel had died and was replaced before execution')
    }
    const reapNote = this.reapedIdle.get(key)
    if (reapNote !== undefined) {
      this.reapedIdle.delete(key)
      annotations.push(
        `the retained ${language} kernel had been reaped after ${formatIdleNote(reapNote.idleMs)} idle — state was reset (re-run your setup cell)`,
      )
    }
    return this.spawnKernel(owner, language, cwd, interpreter)
  }

  /** Dispose one language's kernel for an owner+cwd (the reset path —
   *  other languages keep their state). Coalesces trivially by running in
   *  the same per-key chain as execution. */
  private async disposeKey(key: string): Promise<void> {
    const entry = this.kernels.get(key)
    if (!entry) return
    this.kernels.delete(key)
    this.syncSweepTimer()
    await entry.kernel.dispose()
  }

  /** Dispose every kernel this process holds (session teardown; tests). */
  async disposeAll(): Promise<void> {
    const entries = [...this.kernels.values()]
    this.kernels.clear()
    this.reapedIdle.clear()
    this.syncSweepTimer()
    await Promise.all(entries.map(entry => entry.kernel.dispose()))
  }

  /** Tear ONE owner's kernels out NOW (session close, /clear, switch). The
   *  removal is synchronous and only the drain is deferred — the two-pass
   *  disposal law: fire-and-forget callers may rely on the state being gone
   *  the moment this returns. Pending idle-reap notes die with the owner
   *  (a fresh session must not inherit a dead one's annotation). */
  disposeOwner(owner: string): Promise<void> {
    const removed: KernelEntry[] = []
    for (const [key, entry] of this.kernels) {
      if (entry.owner !== owner) continue
      this.kernels.delete(key)
      removed.push(entry)
    }
    for (const [key, note] of this.reapedIdle) {
      if (note.owner === owner) this.reapedIdle.delete(key)
    }
    this.syncSweepTimer()
    if (removed.length === 0) return Promise.resolve()
    return Promise.all(removed.map(entry => entry.kernel.dispose())).then(() => undefined)
  }

  /** Synchronous last-resort kill of every kernel (the shutdown sweep). */
  killAllForShutdown(): void {
    for (const entry of this.kernels.values()) entry.kernel.kill()
    this.kernels.clear()
    this.reapedIdle.clear()
    this.syncSweepTimer()
  }

  kernelCount(): number {
    return this.kernels.size
  }

  async runCell(request: RunCellRequest): Promise<EvalCellOutcome> {
    const { owner, cwd, input } = request
    const availability = evalAvailability(cwd)
    const row = availability.find(a => a.language === input.language)
    if (!row || !row.available || !row.interpreterPath) {
      return refusalOutcome(unavailableLanguageMessage(input.language, availability))
    }
    const interpreter = row.interpreterPath
    const key = this.key(owner, input.language, cwd, interpreter)
    return this.enqueue(key, async () => {
      const annotations: string[] = []
      if (input.reset) {
        await this.disposeKey(key)
        // A reset asked for fresh state — an earlier idle reap on this key
        // is subsumed, not worth a second annotation.
        this.reapedIdle.delete(key)
        annotations.push(`the ${input.language} kernel was reset before this cell (other languages keep their state)`)
      }
      try {
        return await this.runCellOnce(request, key, interpreter, annotations, /*retriesLeft*/ 1)
      } finally {
        const entry = this.kernels.get(key)
        if (entry) entry.lastUsedAt = Date.now()
      }
    })
  }

  private async runCellOnce(
    request: RunCellRequest,
    key: string,
    interpreter: string,
    annotations: string[],
    retriesLeft: number,
  ): Promise<EvalCellOutcome> {
    const { owner, cwd, input, abortSignal, serveBridge } = request
    const spawned = await this.getOrSpawn(owner, input.language, cwd, interpreter, annotations)
    if ('spawnError' in spawned) return refusalOutcome(spawned.spawnError, annotations)
    const entry = spawned

    // Budgets.
    const timeoutSeconds =
      input.timeoutSeconds === 0
        ? null
        : Math.min(Math.max(input.timeoutSeconds ?? EVAL_DEFAULT_TIMEOUT_SECONDS, 1), EVAL_MAX_TIMEOUT_SECONDS)
    const runtime = new PauseableDeadline(timeoutSeconds === null ? null : timeoutSeconds * 1000)
    const wall = new PauseableDeadline(EVAL_WALL_CEILING_MS)
    let bridgeMs = 0
    let bridgeDepth = 0
    const budget: CellBudgetHooks = {
      bridgeBegin: (): void => {
        bridgeDepth += 1
        if (bridgeDepth === 1) runtime.pause()
      },
      bridgeEnd: (): void => {
        bridgeDepth = Math.max(0, bridgeDepth - 1)
        if (bridgeDepth === 0) runtime.resume()
      },
      askBegin: (): void => wall.pause(),
      askEnd: (): void => wall.resume(),
    }

    // Sinks and displays.
    const stdout = new BoundedStreamSink()
    const stderr = new BoundedStreamSink()
    const displays: EvalDisplay[] = []
    let displaysDropped = 0
    let resultRepr: string | undefined
    let cellError: { name: string; value: string; traceback: string } | undefined

    const cellId = `cell-${entry.kernel.executionCount + 1}-${Date.now().toString(36)}`
    const code = input.language === 'js' ? transformJsCell(input.code).code : input.code

    let interruptRequested: 'budget' | 'wall' | 'abort' | null = null
    let escalated = false

    const execPromise = entry.kernel.exec(cellId, code, {
      onStdout: chunk => {
        stdout.push(chunk)
        request.onLiveOutput?.('stdout', chunk)
      },
      onStderr: chunk => {
        stderr.push(chunk)
        request.onLiveOutput?.('stderr', chunk)
      },
      onDisplay: frame => {
        if (displays.length >= MAX_DISPLAYS_PER_CELL) {
          displaysDropped += 1
          return
        }
        const mime = frame.mime
        if (
          mime === 'text/plain' ||
          mime === 'text/markdown' ||
          mime === 'application/json' ||
          mime === 'image/png' ||
          mime === 'image/jpeg'
        ) {
          displays.push({ mime, data: frame.data, ...(frame.b64 ? { b64: true } : {}) })
        } else {
          displaysDropped += 1
        }
      },
      onResult: repr => {
        resultRepr = repr
      },
      onError: error => {
        cellError = error
      },
      onBridge: frame => {
        const startedAt = Date.now()
        budget.bridgeBegin()
        void serveBridge(frame, budget)
          .then(result => {
            entry.kernel.answerBridge(frame.bridgeId, result.ok, result.value, result.error)
          })
          .catch(error => {
            entry.kernel.answerBridge(frame.bridgeId, false, undefined, String(error))
          })
          .finally(() => {
            bridgeMs += Date.now() - startedAt
            budget.bridgeEnd()
          })
      },
    })

    runtime.start()
    wall.start()

    // The watch loop: abort, runtime budget, wall ceiling → interrupt, then
    // escalation kill if the runner does not settle.
    let watchStop = false
    const watcher = (async (): Promise<void> => {
      let interruptAt: number | null = null
      while (!watchStop) {
        await sleep(100)
        if (watchStop) return
        if (interruptRequested === null) {
          if (abortSignal.aborted) interruptRequested = 'abort'
          else if (runtime.expired()) interruptRequested = 'budget'
          else if (wall.expired()) interruptRequested = 'wall'
          if (interruptRequested !== null) {
            interruptAt = Date.now()
            entry.kernel.interrupt()
          }
        } else if (interruptAt !== null && Date.now() - interruptAt > EVAL_INTERRUPT_ESCALATION_MS) {
          escalated = true
          entry.kernel.kill()
          return
        }
      }
    })()

    const end: CellEnd = await execPromise
    watchStop = true
    await watcher.catch(() => undefined)
    runtime.pause()
    wall.pause()

    const runtimeMs = runtime.consumed()

    // Kernel died mid-cell (the exit hook journals the row).
    if (end.kind === 'kernel-exit') {
      if (interruptRequested !== null) {
        // Our own escalation (or the interrupt raced the exit): a cancelled
        // cell on a kernel we then replaced.
        annotations.push(
          escalated
            ? 'the interrupt was not honoured in time (stuck native code?) — the kernel was killed and will be recreated on the next call'
            : 'the kernel exited while being interrupted — it will be recreated on the next call',
        )
        annotations.push(cancelReasonNote(interruptRequested, timeoutSeconds))
        return this.composeOutcome('cancelled', stdout, stderr, displays, displaysDropped, resultRepr, cellError, annotations, runtimeMs, bridgeMs, entry, cellId)
      }
      // An aborted call never retries: session teardown kills kernels out
      // from under a mid-flight cell, and the retry arm must not resurrect
      // a disposed owner's kernel.
      if (retriesLeft > 0 && !abortSignal.aborted) {
        annotations.push(
          `the kernel died mid-cell (${end.signal ?? `exit ${end.code}`}) — replaced and the cell retried once on a fresh kernel`,
        )
        return this.runCellOnce(request, key, interpreter, annotations, retriesLeft - 1)
      }
      annotations.push(
        abortSignal.aborted
          ? `the kernel died mid-cell (${end.signal ?? `exit ${end.code}`}) while the call was aborting — not retried`
          : `the kernel died mid-cell again (${end.signal ?? `exit ${end.code}`}) — giving up after one retry`,
      )
      const outcome = this.composeOutcome('error', stdout, stderr, displays, displaysDropped, resultRepr, cellError ?? { name: 'KernelDied', value: `the kernel exited with ${end.signal ?? `code ${end.code}`}`, traceback: '' }, annotations, runtimeMs, bridgeMs, entry, cellId)
      return outcome
    }

    // A cancelled cell (runner honoured the interrupt), or clean done.
    let status = end.status
    if (interruptRequested !== null && status !== 'cancelled') {
      // The interrupt landed between the cell finishing and our watch —
      // honest: report the cell's own status, note the near-miss.
      annotations.push('an interrupt was requested but the cell had already settled')
    }
    if (status === 'cancelled') {
      annotations.push(cancelReasonNote(interruptRequested ?? 'abort', timeoutSeconds))
      if (input.language === 'js') {
        // Residual async work from a cancelled JS cell cannot be stopped
        // inside one runtime — a fresh kernel is the honest state.
        await this.disposeKey(key)
        annotations.push('the JS kernel was recreated after the interrupt: kernel state was reset (re-run your setup cell)')
      } else {
        annotations.push('the kernel survived: variables are intact; pass reset:true if you want a clean runtime')
      }
    }
    return this.composeOutcome(status, stdout, stderr, displays, displaysDropped, resultRepr, cellError, annotations, runtimeMs, bridgeMs, entry, cellId)
  }

  private composeOutcome(
    status: 'ok' | 'error' | 'cancelled',
    stdout: BoundedStreamSink,
    stderr: BoundedStreamSink,
    displays: EvalDisplay[],
    displaysDropped: number,
    resultRepr: string | undefined,
    cellError: { name: string; value: string; traceback: string } | undefined,
    annotations: string[],
    runtimeMs: number,
    bridgeMs: number,
    entry: KernelEntry,
    cellId: string,
  ): EvalCellOutcome {
    const out = stdout.finalize()
    const err = stderr.finalize()
    let spillPath: string | undefined
    if (out.truncated || err.truncated) {
      spillPath = writeSpill(cellId, stdout, stderr, annotations)
    }
    if (displaysDropped > 0) {
      annotations.push(`${displaysDropped} display(s) beyond the per-cell bounds were dropped`)
    }
    return {
      status,
      stdout: out,
      stderr: err,
      displays,
      ...(resultRepr !== undefined ? { resultRepr } : {}),
      ...(cellError !== undefined ? { error: cellError } : {}),
      ...(spillPath !== undefined ? { spillPath } : {}),
      annotations,
      runtimeMs,
      bridgeMs,
      executionCount: entry.kernel.executionCount,
    }
  }
}

/** Human idle span for the reap annotation (minutes at product TTLs; the
 *  seconds arm keeps proof-injected short TTLs honest). */
function formatIdleNote(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.max(1, Math.round(ms / 1000))} s`
}

function cancelReasonNote(reason: 'budget' | 'wall' | 'abort', timeoutSeconds: number | null): string {
  switch (reason) {
    case 'budget':
      return `the cell hit its ${timeoutSeconds ?? '?'}s runtime budget (bridge time excluded) and was interrupted — raise timeoutSeconds or pass 0 to disable`
    case 'wall':
      return 'the cell hit the hard wall-clock ceiling for one Eval call and was interrupted'
    case 'abort':
      return 'the cell was interrupted by the session (user abort)'
  }
}

function writeSpill(
  cellId: string,
  stdout: { rawCapture(): { text: string; capped: boolean } },
  stderr: { rawCapture(): { text: string; capped: boolean } },
  annotations: string[],
): string | undefined {
  try {
    // One shared implementation with the tool-result persistence plane: the
    // session's tool-results directory (readable back with the Read tool).
    // Pre-boot callers (proof scripts, print mode) have no session id —
    // the spill degrades to the eval home, never to a lost stream.
    let dir: string
    try {
      dir = getToolResultsDir()
    } catch {
      dir = join(getMercuryHome(), 'eval', 'spill')
    }
    mkdirSync(dir, { recursive: true })
    const outCapture = stdout.rawCapture()
    const errCapture = stderr.rawCapture()
    const base = join(dir, `eval-${cellId}`)
    const stdoutPath = `${base}.stdout.txt`
    writeFileSync(stdoutPath, outCapture.text, 'utf8')
    if (errCapture.text.length > 0) writeFileSync(`${base}.stderr.txt`, errCapture.text, 'utf8')
    if (outCapture.capped || errCapture.capped) {
      annotations.push('the spill artifact itself was capped (stream exceeded the spill ceiling)')
    }
    annotations.push(`full output spilled: ${stdoutPath}${errCapture.text.length > 0 ? ` (+ .stderr.txt)` : ''} — read it back with the Read tool`)
    return stdoutPath
  } catch (error) {
    annotations.push(`output was truncated and the spill write failed: ${String(error)}`)
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

function refusalOutcome(message: string, annotations: string[] = []): EvalCellOutcome {
  return {
    status: 'error',
    stdout: { text: '', truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: '', truncated: false, totalBytes: 0, totalLines: 0 },
    displays: [],
    error: { name: 'EvalUnavailable', value: message, traceback: '' },
    annotations,
    runtimeMs: 0,
    bridgeMs: 0,
    executionCount: 0,
  }
}

/** The process-wide manager (kernels are per-process resources). */
export const evalKernelManager = new EvalKernelManager()

// The session-close cascade: the manager joins the owner-disposal registry,
// so the standing callers (REPL /clear, session switch, QueryEngine/headless
// teardown, resume reactivation, process exit) reap a closed session's
// kernels with the rest of its owner state — no interpreter outlives its
// chat. disposeAsync removes synchronously and defers only the drain, per
// the registry's two-pass law.
registerOwnerScopedStore({
  name: 'eval-kernels',
  dispose(owner) {
    void evalKernelManager.disposeOwner(String(owner))
  },
  disposeAsync(owner) {
    return evalKernelManager.disposeOwner(String(owner))
  },
  clearAllForShutdown() {
    evalKernelManager.killAllForShutdown()
  },
  get size() {
    return evalKernelManager.kernelCount()
  },
})
