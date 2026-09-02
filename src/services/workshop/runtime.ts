
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { storeArtifact } from '../../utils/artifacts/store.js'
import { logForDebugging } from '../../utils/debug.js'
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
  type WorkshopLanguage,
} from './contracts.js'
import { WORKSHOP_WORKER_SOURCE } from './workerSource.js'
import { registerExecutionDomain } from '../primitives/executionPlane.js'
import {
  projectRuntimeBusy,
  projectRuntimeIdle,
  projectRuntimeSettled,
  projectRuntimeSpawned,
  recordWorkshopCell,
} from './executionProjection.js'

export interface WorkshopBridge {
  inspect(ref: string): Promise<string>
  tool(name: string, input: unknown): Promise<string>
  agent(input: unknown): Promise<string>
}

interface RuntimeState {
  worker: Worker | null
  language: WorkshopLanguage
  generation: number
  queue: Promise<unknown>
  cellSeq: number
}

interface OwnerWorkshops {
  runtimes: Map<WorkshopLanguage, RuntimeState>
}

const store = new OwnerScopedStore<OwnerWorkshops>({
  name: 'workshop',
  create: () => ({ runtimes: new Map() }),
  dispose: (state, owner) => {
    for (const rt of state.runtimes.values()) {
      rt.worker?.terminate().catch(() => {})
      rt.worker = null
      projectRuntimeSettled(owner, rt.language, 'owner disposed — worker reaped')
    }
    state.runtimes.clear()
  },
  cap: 16,
})
registerOwnerScopedStore(store)

registerExecutionDomain('workshop-js', {
  reconcile: record => {
    const language = record.spec.metadata?.language as WorkshopLanguage | undefined
    if (!language) return null
    const rt = store.peek(record.spec.owner)?.runtimes.get(language)
    return rt?.worker
      ? { state: record.state }
      : { state: 'stopped', outcome: { reason: 'worker gone (reconciled)' } }
  },
  requestStop: record => {
    const language = record.spec.metadata?.language as WorkshopLanguage | undefined
    if (!language) return
    resetWorkshopRuntime(record.spec.owner, language)
  },
})

process.once('exit', () => {
  store.clearAllForShutdown()
})

function runtimeFor(owner: OwnerKey, language: WorkshopLanguage): RuntimeState {
  const owned = store.get(owner)
  let rt = owned.runtimes.get(language)
  if (!rt) {
    rt = { worker: null, language, generation: 1, queue: Promise.resolve(), cellSeq: 0 }
    owned.runtimes.set(language, rt)
  }
  return rt
}

function spawnWorker(cwd: string): Worker {
  return new Worker(WORKSHOP_WORKER_SOURCE, {
    eval: true,
    workerData: { cwd },
    stderr: true,
    stdout: true,
  })
}

function killRuntime(owner: OwnerKey, rt: RuntimeState, reason: string): void {
  rt.worker?.terminate().catch(() => {})
  rt.worker = null
  rt.generation++
  projectRuntimeSettled(owner, rt.language, reason)
}

export function resetWorkshopRuntime(owner: OwnerKey, language: WorkshopLanguage): number {
  const rt = runtimeFor(owner, language)
  killRuntime(owner, rt, 'explicit reset — retained state cleared')
  return rt.generation
}

export function workshopGeneration(owner: OwnerKey, language: WorkshopLanguage): number {
  return store.peek(owner)?.runtimes.get(language)?.generation ?? 1
}

export function _workshopWorkerCountForTesting(): number {
  let n = 0
  void n
  return n
}


interface TsCompiler {
  version: string
  transpile(code: string): string
}

let cachedTs: { cwd: string; compiler: TsCompiler | null } | null = null

function isWorkspaceResolution(cwd: string, resolved: string): boolean {
  let dir = path.resolve(cwd)
  for (;;) {
    if (resolved.startsWith(path.join(dir, 'node_modules') + path.sep)) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

function workspaceTypescript(cwd: string): TsCompiler | null {
  if (cachedTs && cachedTs.cwd === cwd) return cachedTs.compiler
  let compiler: TsCompiler | null = null
  try {
    const req = createRequire(path.join(cwd, '__workshop__.js'))
    const tsPath = req.resolve('typescript', { paths: [cwd] })
    if (!isWorkspaceResolution(cwd, tsPath)) {
      throw new Error('typescript did not resolve from the workspace')
    }
    const ts = req(tsPath) as {
      version: string
      transpileModule: (code: string, opts: unknown) => { outputText: string }
      ModuleKind: { CommonJS: number }
      ScriptTarget: { ES2022: number }
    }
    compiler = {
      version: ts.version,
      transpile: code =>
        ts.transpileModule(code, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
        }).outputText,
    }
  } catch {
    compiler = null
  }
  cachedTs = { cwd, compiler }
  return compiler
}


function hasTopLevelAwait(code: string): boolean {
  if (!/\bawait\b/.test(code)) return false
  let depth = 0
  for (const line of code.split('\n')) {
    if (depth === 0 && /\bawait\b/.test(line.replace(/\/\/.*$/, ''))) return true
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth++
      else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    }
  }
  return false
}

export interface RunCellOptions {
  owner: OwnerKey
  cwd: string
  cell: WorkshopCellInput
  bridge: WorkshopBridge
  signal?: AbortSignal
  onOutput?: (line: string) => void
}

export async function runWorkshopCell(
  opts: RunCellOptions,
): Promise<WorkshopCellResult> {
  const { owner, cwd, cell, bridge, signal } = opts
  const rt = runtimeFor(owner, cell.language)

  const turn = rt.queue.then(() => executeCell())
  rt.queue = turn.catch(() => {})
  void turn.then(result => recordWorkshopCell(owner, result)).catch(() => {})
  return turn

  async function executeCell(): Promise<WorkshopCellResult> {
    const startedAt = Date.now()
    if (cell.reset) killRuntime(owner, rt, 'explicit reset — retained state cleared')
    if (signal?.aborted) {
      return terminal('cancelled', 'cancelled before start', false)
    }

    let code = cell.code
    let compiler: string | undefined
    if (cell.language === 'ts') {
      const ts = workspaceTypescript(cwd)
      if (!ts) {
        return terminal(
          'failed',
          'no TypeScript compiler available: the workspace has no resolvable `typescript` package and Mercury does not bundle one — install typescript in the project, or use language: "js"',
          false,
        )
      }
      try {
        code = ts.transpile(cell.code)
        compiler = `workspace typescript@${ts.version}`
      } catch (e) {
        return terminal('failed', `TypeScript transpile failed: ${e instanceof Error ? e.message : String(e)}`, false)
      }
    }

    if (!rt.worker) {
      rt.worker = spawnWorker(cwd)
      rt.worker.on('error', (err: Error) => {
        logForDebugging(`workshop: worker error: ${err.message}`)
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('workshop worker never became ready (5s)')), 5_000)
        rt.worker!.once('message', () => {
          clearTimeout(timer)
          resolve()
        })
      }).catch(err => {
        killRuntime(owner, rt, 'worker never became ready')
        throw err
      })
      projectRuntimeSpawned(owner, cell.language, rt.generation)
    }
    const worker = rt.worker
    const generation = rt.generation
    projectRuntimeBusy(owner, cell.language)
    const cellId = `cell-${cell.language}-g${generation}-${++rt.cellSeq}`

    const outputLines: string[] = []
    const displays: WorkshopDisplayItem[] = []
    let nestedCalls = 0
    let outstandingRpc = 0

    const timeoutMs = Math.min(cell.timeoutMs ?? DEFAULT_CELL_TIMEOUT_MS, MAX_CELL_TIMEOUT_MS)
    const overallDeadline = startedAt + Math.max(timeoutMs, OVERALL_CELL_CEILING_MS)

    return await new Promise<WorkshopCellResult>(resolve => {
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let ceilingTimer: ReturnType<typeof setTimeout> | null = null

      const settle = (result: WorkshopCellResult): void => {
        if (settled) return
        settled = true
        cleanup()
        projectRuntimeIdle(owner, cell.language)
        resolve(result)
      }

      const buildResult = (
        state: WorkshopCellResult['state'],
        extras: { valuePreview?: string; error?: string; killed?: boolean },
      ): WorkshopCellResult => ({
        cellId,
        ...(cell.title ? { title: cell.title } : {}),
        language: cell.language,
        state,
        generation,
        runtimeKilled: extras.killed ?? false,
        durationMs: Date.now() - startedAt,
        valuePreview: extras.valuePreview ?? '',
        outputTail: outputLines.slice(-OUTPUT_TAIL_LINES),
        displays,
        ...(extras.error ? { error: extras.error } : {}),
        nestedCalls,
      })

      const killAndSettle = (state: 'timed-out' | 'cancelled', why: string): void => {
        killRuntime(owner, rt, `cell ${state} — worker terminated, retained state lost`)
        void spillIfNeeded().then(artifactRef =>
          settle({
            ...buildResult(state, { error: why, killed: true }),
            ...(artifactRef ? { artifactRef } : {}),
          }),
        )
      }

      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          killAndSettle(
            'timed-out',
            `cell exceeded ${timeoutMs}ms of active runtime — the worker was terminated and RETAINED STATE WAS LOST (generation ${generation} → ${generation + 1})`,
          )
        }, timeoutMs)
      }
      const pauseIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }

      ceilingTimer = setTimeout(() => {
        killAndSettle(
          'timed-out',
          `cell exceeded the overall ceiling (${overallDeadline - startedAt}ms incl. nested waits) — worker terminated, retained state lost`,
        )
      }, overallDeadline - startedAt)

      const onAbort = (): void => {
        killAndSettle('cancelled', 'cancelled — the worker was terminated and retained state was lost')
      }
      signal?.addEventListener('abort', onAbort, { once: true })

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
              .then(value => worker.postMessage({ type: 'rpc-result', id, ok: true, value }))
              .catch(err =>
                worker.postMessage({
                  type: 'rpc-result',
                  id,
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
              )
              .finally(() => {
                outstandingRpc = Math.max(0, outstandingRpc - 1)
                if (outstandingRpc === 0 && !settled) armIdle()
              })
            break
          }
          case 'cell-done': {
            if (msg.cellId !== cellId) return
            void spillIfNeeded().then(artifactRef => {
              const base = msg.ok
                ? buildResult('succeeded', { valuePreview: String(msg.valuePreview ?? '') })
                : buildResult('failed', { error: String(msg.error ?? 'cell failed') })
              settle({
                ...base,
                ...(artifactRef ? { artifactRef } : {}),
                ...(compiler ? { compiler } : {}),
              })
            })
            break
          }
          default:
            break
        }
      }

      const onExit = (): void => {
        settle(
          buildResult('failed', {
            error: 'the workshop worker died mid-cell — retained state was lost',
            killed: true,
          }),
        )
        killRuntime(owner, rt, 'worker died mid-cell')
      }

      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        if (ceilingTimer) clearTimeout(ceilingTimer)
        signal?.removeEventListener('abort', onAbort)
        worker.off('message', onMessage)
        worker.off('exit', onExit)
      }

      worker.on('message', onMessage)
      worker.once('exit', onExit)
      armIdle()
      worker.postMessage({
        type: 'run',
        cellId,
        code,
        hasTopLevelAwait: hasTopLevelAwait(code),
      })
    })

    function terminal(
      state: WorkshopCellResult['state'],
      error: string,
      killed: boolean,
    ): WorkshopCellResult {
      return {
        cellId: `cell-${cell.language}-g${rt.generation}-${++rt.cellSeq}`,
        ...(cell.title ? { title: cell.title } : {}),
        language: cell.language,
        state,
        generation: rt.generation,
        runtimeKilled: killed,
        durationMs: Date.now() - startedAt,
        valuePreview: '',
        outputTail: [],
        displays: [],
        error,
        nestedCalls: 0,
      }
    }
  }
}
