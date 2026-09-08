
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
import { primeEvalAvailability } from './interpreters.js'
import { buildKernelEnv } from './kernelEnv.js'
import { transformJsCell } from './jsCellTransform.js'
import { ensureJsRunner, ensurePyRunner } from './runnerCache.js'
import { ProcKernel, type CellEnd } from './procKernel.js'
import type { BridgeRequestFrame } from './protocol.js'

const MAX_DISPLAYS_PER_CELL = 24


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
          const pid = payload.pid
          killProcessGroup({ pid, kill: signal => (process.kill(pid, signal), true) })
          reaped = true
        } catch {
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

  msLeft(): number | null {
    if (this.limitMs === null) return null
    if (this.runningSince === null) return null
    return Math.max(0, this.limitMs - this.consumed())
  }
}


export interface CellBudgetHooks {
  bridgeBegin: () => void
  bridgeEnd: () => void
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
  lastUsedAt: number
}

export class EvalKernelManager {
  private kernels = new Map<string, KernelEntry>()
  private chains = new Map<string, Promise<unknown>>()
  private exitHookInstalled = false
  private sweepTimer: ReturnType<typeof setInterval> | null = null
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

  private async disposeKey(key: string): Promise<void> {
    const entry = this.kernels.get(key)
    if (!entry) return
    this.kernels.delete(key)
    this.syncSweepTimer()
    await entry.kernel.dispose()
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.kernels.values()]
    this.kernels.clear()
    this.reapedIdle.clear()
    this.syncSweepTimer()
    await Promise.all(entries.map(entry => entry.kernel.dispose()))
  }

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
    const availability = await primeEvalAvailability(cwd)
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
        this.reapedIdle.delete(key)
        annotations.push(`the ${input.language} kernel was reset before this cell (other languages keep their state)`)
      }
      try {
        return await this.runCellOnce(request, key, interpreter, annotations,  1)
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

    const stdout = new BoundedStreamSink()
    const stderr = new BoundedStreamSink()
    const displays: EvalDisplay[] = []
    let displaysDropped = 0
    let resultRepr: string | undefined
    let cellError: { name: string; value: string; traceback: string; survived?: string[] } | undefined
    const nested: { seq: number; name: string; ok: boolean; error?: string }[] = []

    const cellId = `cell-${entry.kernel.executionCount + 1}-${Date.now().toString(36)}`
    const transformed = input.language === 'js' ? transformJsCell(input.code) : null
    const code = transformed !== null ? transformed.code : input.code

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
        const seq = nested.length + 1
        const called = nestedCallName(frame)
        if (called !== null) nested.push({ seq, name: called, ok: true })
        void serveBridge(frame, budget)
          .then(result => {
            if (called !== null) {
              const row = nested.find(r => r.seq === seq)
              if (row !== undefined) {
                row.ok = result.ok
                if (!result.ok) row.error = String(result.error ?? 'failed').slice(0, 160)
              }
            }
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
    }, transformed !== null ? transformed.persistedNames : undefined)

    runtime.start()
    wall.start()

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

    if (end.kind === 'kernel-exit') {
      if (interruptRequested !== null) {
        annotations.push(
          escalated
            ? 'the interrupt was not honoured in time (stuck native code?) — the kernel was killed and will be recreated on the next call'
            : 'the kernel exited while being interrupted — it will be recreated on the next call',
        )
        annotations.push(cancelReasonNote(interruptRequested, timeoutSeconds))
        return this.composeOutcome('cancelled', stdout, stderr, displays, displaysDropped, resultRepr, cellError, annotations, runtimeMs, bridgeMs, entry, cellId)
      }
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

    let status = end.status
    if (interruptRequested !== null && status !== 'cancelled') {
      annotations.push('an interrupt was requested but the cell had already settled')
    }
    if (status === 'cancelled') {
      annotations.push(cancelReasonNote(interruptRequested ?? 'abort', timeoutSeconds))
      if (input.language === 'js') {
        await this.disposeKey(key)
        annotations.push('the JS kernel was recreated after the interrupt: kernel state was reset (re-run your setup cell)')
      } else {
        annotations.push('the kernel survived: variables are intact; pass reset:true if you want a clean runtime')
      }
    }
    if (status === 'error') {
      annotations.push(...stateAfterFailure(input.language, transformed?.persistedNames ?? [], cellError))
    }
    if (status === 'error' || nested.some(r => !r.ok)) {
      const line = nestedCallsLine(nested)
      if (line !== null) annotations.push(line)
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

export function nestedCallName(frame: { kind: string; payload?: unknown }): string | null {
  if (frame.kind === 'tool') {
    const name = (frame.payload as { name?: unknown } | undefined)?.name
    return typeof name === 'string' && name !== '' ? name : 'tool'
  }
  if (frame.kind === 'agent' || frame.kind === 'completion') return frame.kind
  return null
}

export function nestedCallsLine(rows: readonly { seq: number; name: string; ok: boolean; error?: string }[]): string | null {
  if (rows.length === 0) return null
  const shown = rows.slice(0, 20).map(r => `${r.seq} ${r.name} ${r.ok ? 'ok' : `failed (${r.error ?? 'failed'})`}`)
  const more = rows.length > 20 ? ` · +${rows.length - 20} more` : ''
  const failed = rows.filter(r => !r.ok).length
  return `nested calls (${rows.length}, ${failed} failed): ${shown.join(' · ')}${more}`
}

export function stateAfterFailure(
  language: string,
  declared: readonly string[],
  error: { survived?: string[] } | undefined,
): string[] {
  const survived = error?.survived
  if (survived === undefined) return []
  const lost = declared.filter(n => !survived.includes(n))
  if (language === 'js') {
    const kept = survived.length > 0 ? `bindings that survived this failed cell: ${survived.join(', ')}` : 'no top-level binding of this cell survived'
    return [lost.length > 0 ? `${kept}; never bound (declared after the throw or uninitialised): ${lost.join(', ')}` : kept]
  }
  return [survived.length > 0 ? `bindings this failed cell made before the error (the kernel keeps them): ${survived.join(', ')}` : 'this failed cell bound no new name before the error']
}

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

export const evalKernelManager = new EvalKernelManager()

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
