// ============================================================================
//  workshop/pythonRuntime — the host side of the Python Workshop lane
// Mirrors the JS runtime's contracts over a
//  `python3 -u -c <embedded runner>` child speaking NDJSON protocol v1:
//    · one interpreter per owner × cwd (state persists naturally);
//    · honest unavailability when no python3 resolves (cached probe);
//    · cancellation = SIGINT first (KeyboardInterrupt — state RETAINED),
//      SIGKILL after a bounded escalation window (state loss reported);
//    · a dead kernel restarts fresh for the NEXT cell — never a silent
//      replay of the cell that died;
//    · reset clears globals in place (generation bump, visible);
//    · owner disposal + process-exit sweep reap kernels.
// ============================================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  _resetPythonProjectForTesting,
  selectPythonInterpreter,
} from '../ide/pythonProject.js'
import { storeArtifact } from '../../utils/artifacts/store.js'
import { logForDebugging } from '../../utils/debug.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import {
  DEFAULT_CELL_TIMEOUT_MS,
  MAX_CELL_TIMEOUT_MS,
  OUTPUT_SPILL_THRESHOLD_LINES,
  OUTPUT_TAIL_LINES,
  OVERALL_CELL_CEILING_MS,
  type WorkshopCellInput,
  type WorkshopCellResult,
  type WorkshopDisplayItem,
} from './contracts.js'
import type { WorkshopBridge } from './runtime.js'
import { WORKSHOP_PYTHON_RUNNER_SOURCE } from './pythonRunnerSource.js'
import { registerExecutionDomain } from '../primitives/executionPlane.js'
import {
  projectRuntimeBusy,
  projectRuntimeIdle,
  projectRuntimeSettled,
  projectRuntimeSpawned,
  projectRuntimeUnavailable,
  recordWorkshopCell,
} from './executionProjection.js'

const INTERRUPT_ESCALATION_MS = 2_000

// ── interpreter discovery ─────────
// The kernel no longer guesses `python3` alone: selection lives in
// services/ide/pythonProject.ts (explicit MERCURY_PYTHON pin → active
// venv/conda → project .venv/venv → PATH), shared with the Debug tool,
// tests and the type-checker lane. Same honest return shape as before —
// the availability laws (prove-workshop-python §V) hold unchanged.

export function probePythonInterpreter():
  | { command: string; version: string }
  | { unavailable: string } {
  const selection = selectPythonInterpreter()
  if (selection.state === 'ok') {
    return { command: selection.command, version: `Python ${selection.version} (${selection.envKind})` }
  }
  return { unavailable: `${selection.detail} — ${selection.remedy}` }
}

/** TEST-ONLY: drop the (shared) selection cache (availability-path proofs). */
export function _resetPythonProbeForTesting(): void {
  _resetPythonProjectForTesting()
}

// ── kernel registry ─────────────────────────────────────────────────────────

interface PyKernel {
  child: ChildProcessWithoutNullStreams | null
  generation: number
  queue: Promise<unknown>
  cellSeq: number
  /** Line-framed message pump listeners for the CURRENT cell. */
  listeners: Set<(msg: Record<string, unknown>) => void>
  buffer: string
}

const store = new OwnerScopedStore<{ kernel: PyKernel | null }>({
  name: 'workshop-python',
  create: () => ({ kernel: null }),
  dispose: (state, owner) => {
    if (state.kernel?.child) {
      projectRuntimeSettled(owner, 'py', 'owner disposed — kernel reaped')
    }
    state.kernel?.child?.kill('SIGKILL')
    state.kernel = null
  },
  cap: 16,
})
registerOwnerScopedStore(store)

// The execution plane's 'workshop-python' domain truth: liveness = the
// kernel child in THIS registry; a plane stop request is a hard kill
// (state loss is the point of a stop — soft reset stays a domain verb).
registerExecutionDomain('workshop-python', {
  reconcile: record => {
    const k = store.peek(record.spec.owner)?.kernel
    return k?.child
      ? { state: record.state } // alive — the recorded state stands
      : { state: 'stopped', outcome: { reason: 'kernel gone (reconciled)' } }
  },
  requestStop: record => {
    const k = store.peek(record.spec.owner)?.kernel
    if (k) killKernel(record.spec.owner, k, 'plane stop request — kernel killed')
  },
})

process.once('exit', () => {
  store.clearAllForShutdown()
})

function kernelFor(owner: OwnerKey): PyKernel {
  const owned = store.get(owner)
  if (!owned.kernel) {
    owned.kernel = {
      child: null,
      generation: 1,
      queue: Promise.resolve(),
      cellSeq: 0,
      listeners: new Set(),
      buffer: '',
    }
  }
  return owned.kernel
}

export function pythonGeneration(owner: OwnerKey): number {
  return store.peek(owner)?.kernel?.generation ?? 1
}

function killKernel(owner: OwnerKey, k: PyKernel, reason: string): void {
  k.child?.kill('SIGKILL')
  k.child = null
  k.generation++
  projectRuntimeSettled(owner, 'py', reason)
}

async function spawnKernel(owner: OwnerKey, k: PyKernel, cwd: string, command: string): Promise<void> {
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(command, ['-u', '-c', WORKSHOP_PYTHON_RUNNER_SOURCE], {
      windowsHide: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...subprocessEnv() },
    })
  } catch (e) {
    // Bun throws ENOENT synchronously where node emits 'error'.
    killKernel(owner, k, 'kernel spawn failed')
    throw new Error(
      `cannot spawn ${command}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  k.child = child
  k.buffer = ''
  // Identity-guarded dispatch: a REPLACED child (killed by escalation/reset)
  // must never deliver late events into the next cell's listener set.
  const dispatch = (msg: Record<string, unknown>): void => {
    if (k.child !== child) return
    for (const listener of [...k.listeners]) listener(msg)
  }
  // the runner chunk-emits past 1MB, so a legitimate
  // line stays small — past this host-side cap the stream is broken; drop
  // the oversized line and resync at the next newline (the exemplar law).
  const MAX_KERNEL_LINE_BYTES = 8 * 1024 * 1024
  let discardingOversizedLine = false
  child.stdout.on('data', (chunk: Buffer) => {
    if (k.child !== child) return
    k.buffer += chunk.toString('utf8')
    for (;;) {
      const nl = k.buffer.indexOf('\n')
      if (nl === -1) break
      const line = k.buffer.slice(0, nl)
      k.buffer = k.buffer.slice(nl + 1)
      if (discardingOversizedLine) {
        discardingOversizedLine = false
        logForDebugging(`workshop-py: dropped an oversized kernel line (> ${MAX_KERNEL_LINE_BYTES} bytes buffered) — resynced`)
        continue
      }
      if (!line.trim()) continue
      try {
        dispatch(JSON.parse(line) as Record<string, unknown>)
      } catch {
        logForDebugging(`workshop-py: unparseable kernel line (${line.length} bytes)`)
      }
    }
    if (!discardingOversizedLine && k.buffer.length > MAX_KERNEL_LINE_BYTES) {
      discardingOversizedLine = true
      k.buffer = ''
    } else if (discardingOversizedLine) {
      k.buffer = ''
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const text = String(chunk).trimEnd()
    if (text) dispatch({ type: 'output', stream: 'stderr', text })
  })
  //  (XC-5): kernel death settles on 'close' (stdio drained), so
  // queued output — the crash diagnostics — reaches listeners BEFORE the
  // kernel-exit event; the buffer tail is flushed first (a dying kernel's
  // last line often has no newline). 'exit' only arms a bounded backstop for
  // a close held open by a cell-spawned grandchild fd.
  let exitCloseBackstop: NodeJS.Timeout | null = null
  let kernelExitSettled = false
  const settleKernelExit = (): void => {
    if (k.child !== child || kernelExitSettled) return
    kernelExitSettled = true
    if (exitCloseBackstop) {
      clearTimeout(exitCloseBackstop)
      exitCloseBackstop = null
    }
    const tail = k.buffer.trim()
    k.buffer = ''
    if (tail && !discardingOversizedLine) {
      try {
        dispatch(JSON.parse(tail) as Record<string, unknown>)
      } catch {
        // Not a complete protocol frame — surface it as stderr text; a
        // truncated crash diagnostic beats a silent drop.
        dispatch({ type: 'output', stream: 'stderr', text: tail })
      }
    }
    dispatch({ type: 'kernel-exit' })
  }
  child.on('close', settleKernelExit)
  child.on('exit', () => {
    if (k.child !== child || exitCloseBackstop) return
    exitCloseBackstop = setTimeout(settleKernelExit, 1_500)
    exitCloseBackstop.unref?.()
  })
  // Bounded ready handshake.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('the python kernel never became ready (10s)'))
    }, 10_000)
    const onReady = (msg: Record<string, unknown>): void => {
      if (msg.type === 'ready') {
        cleanup()
        resolve()
      }
      if (msg.type === 'kernel-exit') {
        cleanup()
        reject(new Error('the python kernel exited during startup'))
      }
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      k.listeners.delete(onReady)
    }
    k.listeners.add(onReady)
  }).catch(err => {
    killKernel(owner, k, 'kernel never became ready')
    throw err
  })
  projectRuntimeSpawned(owner, 'py', k.generation)
}

/** Explicit reset: clear globals in place (generation bump, visible). */
export async function resetPythonRuntime(owner: OwnerKey): Promise<number> {
  const k = kernelFor(owner)
  if (k.child) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        k.listeners.delete(onDone)
        killKernel(owner, k, 'soft reset timed out — kernel killed')
        resolve()
      }, 3_000)
      const onDone = (msg: Record<string, unknown>): void => {
        if (msg.type === 'reset-done') {
          clearTimeout(timer)
          k.listeners.delete(onDone)
          k.generation++
          resolve()
        }
      }
      k.listeners.add(onDone)
      k.child!.stdin.write(JSON.stringify({ type: 'reset' }) + '\n')
    })
  } else {
    k.generation++
  }
  return k.generation
}

// ── the cell runner ─────────────────────────────────────────────────────────

export interface RunPythonCellOptions {
  owner: OwnerKey
  cwd: string
  cell: WorkshopCellInput
  bridge: WorkshopBridge
  signal?: AbortSignal
  onOutput?: (line: string) => void
}

export async function runPythonCell(
  opts: RunPythonCellOptions,
): Promise<WorkshopCellResult> {
  const { owner, cwd, cell, bridge, signal } = opts
  const k = kernelFor(owner)
  const turn = k.queue.then(() => execute())
  k.queue = turn.catch(() => {})
  // Every settled cell joins the bounded recent-cell ring.
  void turn.then(result => recordWorkshopCell(owner, result)).catch(() => {})
  return turn

  async function execute(): Promise<WorkshopCellResult> {
    const startedAt = Date.now()
    const probe = probePythonInterpreter()
    if ('unavailable' in probe) {
      projectRuntimeUnavailable(owner, 'py', probe.unavailable)
      return {
        cellId: `cell-py-g${k.generation}-${++k.cellSeq}`,
        ...(cell.title ? { title: cell.title } : {}),
        language: 'py',
        state: 'failed',
        generation: k.generation,
        runtimeKilled: false,
        durationMs: 0,
        valuePreview: '',
        outputTail: [],
        displays: [],
        error: probe.unavailable,
        nestedCalls: 0,
      }
    }
    if (signal?.aborted) {
      return {
        cellId: `cell-py-g${k.generation}-${++k.cellSeq}`,
        ...(cell.title ? { title: cell.title } : {}),
        language: 'py',
        state: 'cancelled',
        generation: k.generation,
        runtimeKilled: false,
        durationMs: 0,
        valuePreview: '',
        outputTail: [],
        displays: [],
        error: 'cancelled before start',
        nestedCalls: 0,
      }
    }
    if (!k.child) {
      // A dead kernel restarts ONCE for the next cell — never a replay.
      try {
        await spawnKernel(owner, k, cwd, probe.command)
      } catch (e) {
        return {
          cellId: `cell-py-g${k.generation}-${++k.cellSeq}`,
          ...(cell.title ? { title: cell.title } : {}),
          language: 'py',
          state: 'failed',
          generation: k.generation,
          runtimeKilled: false,
          durationMs: Date.now() - startedAt,
          valuePreview: '',
          outputTail: [],
          displays: [],
          error: `the python kernel failed to start: ${e instanceof Error ? e.message : String(e)}`,
          nestedCalls: 0,
        }
      }
    }
    const child = k.child!
    const generation = k.generation
    const cellId = `cell-py-g${generation}-${++k.cellSeq}`
    projectRuntimeBusy(owner, 'py')

    const outputLines: string[] = []
    const displays: WorkshopDisplayItem[] = []
    let nestedCalls = 0
    let outstandingRpc = 0
    const timeoutMs = Math.min(cell.timeoutMs ?? DEFAULT_CELL_TIMEOUT_MS, MAX_CELL_TIMEOUT_MS)

    return await new Promise<WorkshopCellResult>(resolve => {
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let escalation: ReturnType<typeof setTimeout> | null = null
      const ceilingTimer = setTimeout(() => interrupt('timed-out'), Math.max(timeoutMs, OVERALL_CELL_CEILING_MS))

      const settle = (result: WorkshopCellResult): void => {
        if (settled) return
        settled = true
        cleanup()
        projectRuntimeIdle(owner, 'py')
        resolve(result)
      }

      const buildResult = (
        state: WorkshopCellResult['state'],
        extras: { valuePreview?: string; error?: string; killed?: boolean },
      ): WorkshopCellResult => ({
        cellId,
        ...(cell.title ? { title: cell.title } : {}),
        language: 'py',
        state,
        generation,
        runtimeKilled: extras.killed ?? false,
        durationMs: Date.now() - startedAt,
        valuePreview: extras.valuePreview ?? '',
        outputTail: outputLines.slice(-OUTPUT_TAIL_LINES),
        displays,
        ...(extras.error ? { error: extras.error } : {}),
        nestedCalls,
        compiler: probe.version,
      })

      const spillIfNeeded = async (): Promise<string | undefined> => {
        if (outputLines.length <= OUTPUT_SPILL_THRESHOLD_LINES) return undefined
        const { id } = await storeArtifact({
          scope: 'workshop',
          name: cellId,
          content: outputLines.join('\n'),
          kind: 'cell-output',
        })
        return id ? `mercury://artifact/workshop/${id}` : undefined
      }

      /** Interrupt-first cancellation: SIGINT (KeyboardInterrupt — state
       *  retained); SIGKILL after the escalation window (state lost). */
      const interrupt = (as: 'cancelled' | 'timed-out'): void => {
        if (settled) return
        try {
          child.kill('SIGINT')
        } catch {
          /* the exit handler settles */
        }
        escalation = setTimeout(() => {
          killKernel(owner, k, 'interrupt escalation — kernel killed, state lost')
          void spillIfNeeded().then(artifactRef =>
            settle({
              ...buildResult(as, {
                error:
                  as === 'cancelled'
                    ? 'cancelled — the interrupt did not land within 2s; the kernel was KILLED and retained state was lost'
                    : `cell exceeded ${timeoutMs}ms and the interrupt did not land within 2s — kernel KILLED, retained state lost`,
                killed: true,
              }),
              ...(artifactRef ? { artifactRef } : {}),
            }),
          )
        }, INTERRUPT_ESCALATION_MS)
      }

      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => interrupt('timed-out'), timeoutMs)
      }
      const pauseIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }

      const onAbort = (): void => interrupt('cancelled')
      signal?.addEventListener('abort', onAbort, { once: true })

      const onMessage = (msg: Record<string, unknown>): void => {
        switch (msg.type) {
          case 'output': {
            const line = `${msg.stream === 'stderr' ? '! ' : ''}${String(msg.text)}`
            outputLines.push(line)
            opts.onOutput?.(line)
            break
          }
          case 'display':
            displays.push({
              kind: msg.kind as WorkshopDisplayItem['kind'],
              value: String(msg.value),
            })
            break
          case 'rpc': {
            nestedCalls++
            outstandingRpc++
            pauseIdle()
            const id = msg.id
            const kind = String(msg.kind)
            const payload = (msg.payload ?? {}) as Record<string, unknown>
            const dispatch = async (): Promise<string> => {
              if (kind === 'inspect') return bridge.inspect(String(payload.ref))
              if (kind === 'tool') return bridge.tool(String(payload.name), payload.input)
              if (kind === 'agent') return bridge.agent(payload.input)
              throw new Error(`unknown bridge call '${kind}'`)
            }
            void dispatch()
              .then(value =>
                child.stdin.write(JSON.stringify({ type: 'rpc-result', id, ok: true, value }) + '\n'),
              )
              .catch(err =>
                child.stdin.write(
                  JSON.stringify({
                    type: 'rpc-result',
                    id,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                  }) + '\n',
                ),
              )
              .finally(() => {
                outstandingRpc = Math.max(0, outstandingRpc - 1)
                if (outstandingRpc === 0 && !settled) armIdle()
              })
            break
          }
          case 'cell-done': {
            if (msg.cellId !== cellId) return
            if (escalation) clearTimeout(escalation)
            void spillIfNeeded().then(artifactRef => {
              const interrupted = msg.interrupted === true
              const base = msg.ok
                ? buildResult('succeeded', { valuePreview: String(msg.valuePreview ?? '') })
                : buildResult(interrupted ? 'cancelled' : 'failed', {
                    error: String(msg.error ?? 'cell failed'),
                  })
              settle({ ...base, ...(artifactRef ? { artifactRef } : {}) })
            })
            break
          }
          case 'kernel-exit': {
            killKernel(owner, k, 'kernel died mid-cell')
            void spillIfNeeded().then(artifactRef =>
              settle({
                ...buildResult('failed', {
                  error: 'the python kernel died mid-cell — retained state was lost; the next cell starts a fresh kernel',
                  killed: true,
                }),
                ...(artifactRef ? { artifactRef } : {}),
              }),
            )
            break
          }
          default:
            break
        }
      }

      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        if (escalation) clearTimeout(escalation)
        clearTimeout(ceilingTimer)
        signal?.removeEventListener('abort', onAbort)
        k.listeners.delete(onMessage)
      }

      k.listeners.add(onMessage)
      armIdle()
      child.stdin.write(JSON.stringify({ type: 'run', cellId, code: cell.code }) + '\n')
    })
  }
}
