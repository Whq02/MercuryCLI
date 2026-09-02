// ============================================================================
// The workflow run engine.
//
// Owns the life of one workflow execution: assemble the hardened vm.Context
// carrying the script DSL — agent, parallel, pipeline, phase, log, the budget
// and args globals, workflow(), and the optional ledger/themis capability
// globals — then run the compiled vm.Script under a sync timeout raced
// against the abort signal, and bring the settled value home to the host
// realm. Also home to the abort-aware cross-realm timers, the sandbox
// console, the one-level-nested workflow() callable, and the terminal-status
// derivation.
//
// Injection discipline: this module imports ONLY node:vm and its two realm
// siblings (./vmBoundary.js, ./compiler.js). The pieces with real side
// effects — the hooks factory that performs subagent fan-out, the registry
// resolvers, the resume journal, the ledger/themis hosts — all arrive through
// options, so the engine is buildable and testable in isolation and the
// production wiring lives in exactly one caller (WorkflowTool).
// ============================================================================

import vm from 'node:vm'

import {
  hardenVMIntrinsics,
  makeSettle,
  makeVMCall,
  makeHostFnWrapper,
  makeBoundaryClone,
  cloneFromVM,
  errorTunnel,
  errorTunnelAsync,
} from './vmBoundary.js'
import {
  installDeterminismShim,
  parseWorkflowScript,
  compileWorkflow,
  SYNC_TIMEOUT_MS,
} from './compiler.js'

// ── Limits & glyphs ──────────────────────────────────────────────────────────

/** Cap on workflow_log messages retained in the run summary. */
const RESULT_LOG_CAP = 1000

/** Progress-group prefix marking child-workflow phases in the live tree. */
const CHILD_GROUP_GLYPH = '▸'

/** Stack frames kept when condensing an error for display. */
const STACK_FRAME_CAP = 5

// ============================================================================
// Injected contracts. Defined here — not imported — so the engine compiles
// without the modules that implement them; the implementations must satisfy
// these shapes exactly.
// ============================================================================

/** The token-budget view the engine projects into scripts. */
export interface TokenBudget {
  total: number | null
  getTurnSpent(): number
}

/**
 * What the hooks factory must return: the host-side DSL entrypoints, the
 * run-summary counters, and a second-phase binding seam for the realm
 * bridge — those helpers are compiled inside the vm.Context, which does not
 * exist yet when the factory runs.
 */
export interface WorkflowHooks {
  agent(prompt: string, opts?: unknown): Promise<unknown>
  parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>
  pipeline(items: unknown[], ...stages: Array<(...a: unknown[]) => unknown>): Promise<unknown[]>
  log(message: unknown): void
  phase(title: unknown): void
  getAgentCount(): number
  getFailures(): string[]
  /** Second-phase wiring: receives settle/call/clone after the realm exists. */
  bindVMAwait(bridge: {
    settle: (v: unknown) => Promise<{ v: unknown }>
    call: (fn: unknown, ...args: unknown[]) => unknown
    clone: (hostVal: unknown) => unknown
  }): void
}

/**
 * What a script sees as `ledger`, when the capability host is wired in. No
 * host, no global — the sandbox never advertises what it cannot deliver.
 * Results are deep-copied into the sandbox before the script can touch them;
 * handing over a raw host object would expose un-frozen host intrinsics.
 */
export interface EvolutionLedgerHost {
  record(row: unknown): Promise<unknown>
  read(program: unknown): Promise<unknown>
  report(program: unknown): Promise<unknown>
}

/**
 * What a script sees as `themis`, when that host is wired in: the
 * deterministic control-plane checks — contract validation, the phase
 * machine, trace verification, ownership and diff scans. Same rule as the
 * ledger: absent host, absent global.
 */
export interface ThemisWorkflowHost {
  validateSDS(a: unknown): Promise<unknown>
  normalizeSDS(a: unknown): Promise<unknown>
  topoLayers(a: unknown): Promise<unknown>
  taskPriority(a: unknown): Promise<unknown>
  verifyOwnership(a: unknown): Promise<unknown>
  routeRepair(a: unknown): Promise<unknown>
  scanDiff(a: unknown): Promise<unknown>
  phase(a: unknown): Promise<unknown>
  traceUpdate(a: unknown): Promise<unknown>
  verifyTrace(a: unknown): Promise<unknown>
  observe(a: unknown): Promise<unknown>
}

/** The slice of the tool-use context the engine itself reads. */
export interface WorkflowToolContext {
  abortController?: AbortController
  canUseTool?: unknown
  [k: string]: unknown
}

/** Indexed resume-journal snapshot — opaque here, consumed by the hooks. */
export interface JournalSnapshot {
  results: Map<string, unknown>
  started: Map<string, unknown[]>
}

/** The resume journal — opaque here, loaded once and handed to the hooks. */
export interface WorkflowJournal {
  load(): Promise<JournalSnapshot>
  append(entry: unknown): Promise<void>
}

/** One frame on the run's progress channel. */
export interface ProgressFrame {
  type: string
  toolUseID?: string
  data?: { type?: string; message?: string; [k: string]: unknown }
  [k: string]: unknown
}

// ============================================================================
// Cross-realm timers.
//
// setTimeout/clearTimeout as exposed to scripts: pending timers are tracked
// so an abort clears them all; once aborted, setTimeout degrades to a no-op
// returning id 0. Callbacks run through a re-bindable invoker — the engine
// binds a function compiled IN the sandbox realm, so the callback executes
// under the realm it was written in. Both faces are error-tunnelled.
// ============================================================================
export interface WorkflowTimers {
  /** Script-facing setTimeout — numeric id, or 0 once the run is aborted. */
  setTimeout: (cb: () => void, ms: number) => number
  /** Script-facing clearTimeout. */
  clearTimeout: (id: number) => void
  /** Swap in the realm-compiled callback invoker once the realm exists. */
  bindVMInvoke: (invoke: (fn: () => void) => void) => void
}

export function makeTimers(signal?: AbortSignal): WorkflowTimers {
  const pending = new Set<number>()
  // Callbacks route through a swappable invoker. The engine later binds one
  // compiled in the sandbox, so callbacks execute under their own realm.
  let invokeInRealm: (cb: () => void) => void = cb => cb()

  signal?.addEventListener(
    'abort',
    () => {
      for (const id of pending) clearTimeout(id)
      pending.clear()
    },
    { once: true },
  )

  return {
    setTimeout: errorTunnel((cb: () => void, ms: number) => {
      if (signal?.aborted) return 0
      const fire = () => {
        try {
          invokeInRealm(cb)
        } catch {
          // A timer callback must never unwind the host.
        }
      }
      const id = Number(setTimeout(fire, ms))
      pending.add(id)
      return id
    }),
    clearTimeout: errorTunnel((id: number) => {
      pending.delete(id)
      clearTimeout(id)
    }),
    bindVMInvoke: nextInvoker => {
      invokeInRealm = nextInvoker
    },
  }
}

// ============================================================================
// The sandbox console.
//
// log/info/debug print bare; error/warn carry their level tag. Argument
// rendering never trusts the value — strings pass through, everything else
// takes a guarded JSON.stringify that degrades to a `[typeof]` placeholder.
// Each method is error-tunnelled, and the holder is null-proto so scripts
// cannot reach Object.prototype through it.
// ============================================================================
export function makeVMConsole(emit: (msg: string) => void): Record<string, unknown> {
  const renderArgs = (args: unknown[]) =>
    args
      .map(a => {
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a)
        } catch {
          return `[${typeof a}]`
        }
      })
      .join(' ')
  const channel = (tag: string) => errorTunnel((...args: unknown[]) => emit(tag + renderArgs(args)))
  return {
    __proto__: null,
    log: channel(''),
    info: channel(''),
    debug: channel(''),
    error: channel('[error] '),
    warn: channel('[warn] '),
  }
}

// ── small shared internals ───────────────────────────────────────────────────

/** Define a script-visible global with the standard writable/enumerable/
 *  configurable flags (plain assignment would trip hardened setters). */
function defineScriptGlobal(ctx: vm.Context, name: string, value: unknown): void {
  Object.defineProperty(ctx, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

/**
 * Project a host API object into a realm as a frozen null-proto holder of
 * VM-realm async functions. Every method is error-tunnelled, and whatever it
 * returns is deep-copied to realm-native data on the way in. Serves the
 * ledger and themis globals, in the top-level and child realms alike.
 */
function projectHostApi<T extends object>(
  ctx: vm.Context,
  wrapHostFn: (fn: (...a: any[]) => any) => (...a: any[]) => Promise<unknown>,
  api: T,
  methods: readonly (keyof T & string)[],
): object {
  const cloneIn = makeBoundaryClone(ctx)
  const holder: Record<string, unknown> = { __proto__: null } as Record<string, unknown>
  for (const name of methods) {
    const method = api[name] as unknown as (a: unknown) => Promise<unknown>
    holder[name] = wrapHostFn(
      errorTunnelAsync(async (a: unknown) => cloneIn(await method.call(api, a))),
    )
  }
  return Object.freeze(holder)
}

const LEDGER_API = ['record', 'read', 'report'] as const
const THEMIS_API = [
  'validateSDS',
  'normalizeSDS',
  'topoLayers',
  'taskPriority',
  'verifyOwnership',
  'routeRepair',
  'scanDiff',
  'phase',
  'traceUpdate',
  'verifyTrace',
  'observe',
] as const

/** Extract the printable shape of a thrown value without trusting any of its
 *  getters. (A local twin of the boundary module's reader, kept here so the
 *  engine's import surface stays node:vm plus the two realm siblings.) */
function readThrownShape(e: unknown): { msg: string; name: string; stack?: string } {
  let msg: string
  try {
    const m = (e as { message?: unknown })?.message
    msg = typeof m === 'string' ? m : typeof e === 'string' ? e : '<non-string error>'
  } catch {
    msg = '<unprintable thrown value>'
  }
  let name = 'Error'
  try {
    const n = (e as { name?: unknown })?.name
    if (typeof n === 'string') name = n
  } catch {}
  let stack: string | undefined
  try {
    const s = (e as { stack?: unknown })?.stack
    if (typeof s === 'string') stack = s
  } catch {}
  return { msg, name, stack }
}

/** Condense a stack to its header + the first `max` `at `-frames; a stack
 *  with no more frames than the cap passes through whole. */
function condenseStack(stack: string, max = STACK_FRAME_CAP): string {
  const lines = stack.split('\n')
  const frames = lines.slice(1).filter(line => line.trim().startsWith('at '))
  if (frames.length <= max) return stack
  return [lines[0] ?? '', ...frames.slice(0, max)].join('\n')
}

/** The display string for an arbitrary thrown value: condensed stack for an
 *  Error that has one, message otherwise, String() for non-Errors. */
function condenseThrown(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  if (!e.stack) return e.message
  return condenseStack(e.stack)
}

/** Null-proto error surrogate — what crosses realms instead of a live Error. */
function detachedError(message: string, name = 'Error', stack?: string): object {
  const toString = () => `${name}: ${message}`
  Object.setPrototypeOf(toString, null)
  return { __proto__: null, name, message, stack: stack ?? `${name}: ${message}`, toString }
}

// Registry fallbacks for the workflow() callable when no resolvers were
// injected: report an empty registry rather than crash.
async function emptyResolveWorkflow(): Promise<undefined> {
  return undefined
}
async function emptyGetAllWorkflows(): Promise<Array<{ name: string }>> {
  return []
}

// ============================================================================
// Context assembly.
//
// The sequence below is load-bearing — do not reorder:
//   hooks factory → console → budget → timers → workflow() callable →
//   createContext (codeGeneration off) → determinism shim → intrinsic
//   lockdown → realm-bound timer invoker → DSL projection → optional
//   ledger/themis globals → args (JSON round-trip IN the realm) →
//   bindVMAwait. The shim must precede the lockdown (the lockdown freezes
//   what the shim installed); projection must follow the lockdown (it relies
//   on defineProperty, immune to the frozen prototypes); the boundary bridge
//   can only bind once the realm exists.
// ============================================================================
export interface BuildContextOptions {
  /** Hooks factory — production wiring hands in the agent-hooks module. */
  makeHooks: (args: {
    toolUseContext: WorkflowToolContext
    canUseTool: unknown
    emitProgress: (frame: ProgressFrame) => void
    workflowRunId?: string
    onAgentController?: (id: string, c: AbortController | null) => void
    seedPhaseTitles?: string[]
    budget?: TokenBudget
    journal?: WorkflowJournal
    journalSnapshot?: JournalSnapshot
    args?: unknown
  }) => WorkflowHooks
  toolUseContext: WorkflowToolContext
  emitProgress: (frame: ProgressFrame) => void
  workflowRunId?: string
  onAgentController?: (id: string, c: AbortController | null) => void
  args?: unknown
  seedPhaseTitles?: string[]
  tokenBudget?: TokenBudget
  journal?: WorkflowJournal
  journalSnapshot?: JournalSnapshot
  /** Registry lookups backing the inline workflow() callable (injected). */
  resolveWorkflow?: SubWorkflowDeps['resolveWorkflow']
  getAllWorkflows?: SubWorkflowDeps['getAllWorkflows']
  /** Working-directory accessor for those lookups. */
  getCwd?: SubWorkflowDeps['getCwd']
  /** No ledger host ⇒ no `ledger` global. */
  evolutionLedger?: EvolutionLedgerHost
  /** No themis host ⇒ no `themis` global. */
  themis?: ThemisWorkflowHost
}

export function buildVMContext(opts: BuildContextOptions): {
  vmContext: vm.Context
  hooks: WorkflowHooks
} {
  // Step 1 — the host-side DSL hooks. The journal snapshot rides along so a
  // replayed agent() call can answer from cache; args join the resume keys.
  const hooks = opts.makeHooks({
    toolUseContext: opts.toolUseContext,
    canUseTool: opts.toolUseContext.canUseTool,
    emitProgress: opts.emitProgress,
    workflowRunId: opts.workflowRunId,
    onAgentController: opts.onAgentController,
    seedPhaseTitles: opts.seedPhaseTitles,
    budget: opts.tokenBudget,
    journal: opts.journal,
    journalSnapshot: opts.journalSnapshot,
    args: opts.args,
  })

  // Step 2 — the console; every emitted line becomes a workflow_log frame.
  const sandboxConsole = makeVMConsole((message: string) =>
    opts.emitProgress({
      type: 'progress',
      toolUseID: 'workflow_log',
      data: { type: 'workflow_log', message },
    }),
  )

  // Step 3 — the script-visible budget. `total` is fixed at build; the two
  // functions read live spend on every call.
  const budgetView = Object.freeze({
    __proto__: null,
    total: opts.tokenBudget?.total ?? null,
    spent: errorTunnel(() => opts.tokenBudget?.getTurnSpent() ?? 0),
    remaining: errorTunnel(() => {
      const budget = opts.tokenBudget
      if (!budget || budget.total == null) return Infinity
      return Math.max(0, budget.total - budget.getTurnSpent())
    }),
  })

  // Step 4 — abort-aware timers.
  const signal: AbortSignal | undefined = opts.toolUseContext.abortController?.signal
  const timers = makeTimers(signal)

  // Step 5 — the inline workflow() callable: one nesting level, sharing the
  // parent's counters, cap, budget, and abort signal through the hooks.
  const workflowGlobal = makeSubWorkflowCallable({
    hooks: hooks as unknown as SubWorkflowDeps['hooks'],
    budget: budgetView,
    abortSignal: signal,
    timers,
    resolveWorkflow: opts.resolveWorkflow ?? emptyResolveWorkflow,
    getAllWorkflows: opts.getAllWorkflows ?? emptyGetAllWorkflows,
    getCwd: opts.getCwd,
    evolutionLedger: opts.evolutionLedger,
    themis: opts.themis,
  })

  // Step 6 — the realm itself. codeGeneration.strings=false is the line that
  // makes eval()/Function() inside workflow scripts throw EvalErrors.
  const ctx = vm.createContext(
    {
      __proto__: null,
      log: errorTunnel(hooks.log),
      phase: errorTunnel(hooks.phase),
      budget: budgetView,
      console: sandboxConsole,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    } as object,
    { codeGeneration: { strings: false, wasm: false } },
  )

  // Step 7 — determinism shim, then the intrinsic lockdown (which freezes
  // what the shim installed), then a timer invoker compiled in the realm.
  installDeterminismShim(ctx)
  hardenVMIntrinsics(ctx)
  timers.bindVMInvoke(vm.runInContext('(cb => { cb() })', ctx))

  // Step 8 — project the DSL entrypoints as realm-native async functions.
  const wrapHostFn = makeHostFnWrapper(ctx)
  const expose = (name: string, impl: unknown) =>
    defineScriptGlobal(
      ctx,
      name,
      wrapHostFn(errorTunnelAsync(impl as (...a: unknown[]) => Promise<unknown>)),
    )
  expose('agent', hooks.agent)
  expose('parallel', hooks.parallel)
  expose('pipeline', hooks.pipeline)
  expose('workflow', workflowGlobal)

  // Steps 9–10 — capability globals exist exactly when their hosts do.
  if (opts.evolutionLedger) {
    defineScriptGlobal(
      ctx,
      'ledger',
      projectHostApi(ctx, wrapHostFn, opts.evolutionLedger, LEDGER_API),
    )
  }
  if (opts.themis) {
    defineScriptGlobal(ctx, 'themis', projectHostApi(ctx, wrapHostFn, opts.themis, THEMIS_API))
  }

  // Step 11 — args. The JSON round-trip RUNS IN THE REALM, so the script sees
  // realm-native data, never a live host reference. A value JSON cannot carry
  // (opts.args undefined, or a payload that stringifies to undefined) leaves
  // the global defined but undefined.
  let realmArgs: unknown
  if (opts.args !== undefined) {
    const wire = JSON.stringify(opts.args)
    if (wire !== undefined) {
      realmArgs = vm.runInContext(`JSON.parse(${JSON.stringify(wire)})`, ctx)
    }
  }
  defineScriptGlobal(ctx, 'args', realmArgs)

  // Step 12 — the realm now exists; hand the hooks their boundary bridge.
  hooks.bindVMAwait({
    settle: makeSettle(ctx),
    call: makeVMCall(ctx),
    clone: makeBoundaryClone(ctx),
  })

  // Step 13 — done.
  return { vmContext: ctx, hooks }
}

// ============================================================================
// Running a compiled script to a settled summary.
// ============================================================================
export interface RunResult {
  /** The script's return value, marshalled out to host-owned plain data. */
  result: unknown
  agentCount: number
  logs: string[]
  failures: string[]
  durationMs: number
  /** Present only when the run failed; condensed for display. */
  error?: string
}

/**
 * The terminal verdict folds the per-agent failure record into the script's
 * own outcome — a script that returns normally after every agent it spawned
 * failed has not succeeded:
 *
 *   - a script-level error is `failed`, full stop;
 *   - zero recorded failures is `completed`;
 *   - failures covering every agent (agentCount > 0) is `failed`, with a
 *     derived error saying exactly that;
 *   - anything in between is `completed_with_failures` — the result stands,
 *     and the failures are named beside it.
 */
export function deriveWorkflowTerminalStatus(input: {
  error: string | undefined
  failures: readonly string[]
  agentCount: number
}): { status: 'completed' | 'completed_with_failures' | 'failed'; derivedError?: string } {
  if (input.error) return { status: 'failed' }
  if (input.failures.length === 0) return { status: 'completed' }
  if (input.agentCount > 0 && input.failures.length >= input.agentCount) {
    return {
      status: 'failed',
      derivedError: `all ${input.agentCount} agent(s) failed (${input.failures.length} failure(s) recorded) — the script returned, but no agent work succeeded`,
    }
  }
  return { status: 'completed_with_failures' }
}

export interface RunWorkflowOptions {
  /** Hooks factory (the seam BuildContextOptions.makeHooks documents). */
  makeHooks: BuildContextOptions['makeHooks']
  workflowRunId?: string
  onProgress?: (frame: ProgressFrame) => void
  onAgentController?: (id: string, c: AbortController | null) => void
  args?: unknown
  seedPhaseTitles?: string[]
  tokenBudget?: TokenBudget
  journal?: WorkflowJournal
  syncTimeoutMs?: number
  resolveWorkflow?: SubWorkflowDeps['resolveWorkflow']
  getAllWorkflows?: SubWorkflowDeps['getAllWorkflows']
  getCwd?: SubWorkflowDeps['getCwd']
  evolutionLedger?: EvolutionLedgerHost
  themis?: ThemisWorkflowHost
}

/**
 * Run one compiled workflow script to a settled RunResult. Never rejects — a
 * failing script comes back as `{ ..., error }` with the stack condensed to
 * its leading frames — and the progress stream is tapped so the summary
 * carries up to RESULT_LOG_CAP workflow_log lines.
 *
 * Sharp edge, kept on purpose: the tap forwards EVERY frame to BOTH the
 * positional `emitProgress` and `opts.onProgress`. A caller wiring one sink
 * must no-op the other channel, or each log line arrives twice.
 */
export async function runWorkflowScript(
  vmScript: vm.Script,
  toolUseContext: WorkflowToolContext,
  emitProgress: (frame: ProgressFrame) => void,
  opts: RunWorkflowOptions,
): Promise<RunResult> {
  const beganAt = Date.now()
  const capturedLogs: string[] = []

  const tap = (frame: ProgressFrame) => {
    const isLogLine = frame.type === 'progress' && frame.data?.type === 'workflow_log'
    if (isLogLine && capturedLogs.length < RESULT_LOG_CAP) {
      capturedLogs.push(frame.data?.message ?? '')
    }
    emitProgress(frame)
    opts.onProgress?.(frame)
  }

  // The resume cache must be indexed before the first script statement runs.
  const journalSnapshot = opts.journal ? await opts.journal.load() : undefined

  const { vmContext, hooks } = buildVMContext({
    makeHooks: opts.makeHooks,
    toolUseContext,
    emitProgress: tap,
    workflowRunId: opts.workflowRunId,
    onAgentController: opts.onAgentController,
    args: opts.args,
    seedPhaseTitles: opts.seedPhaseTitles,
    tokenBudget: opts.tokenBudget,
    journal: opts.journal,
    journalSnapshot,
    resolveWorkflow: opts.resolveWorkflow,
    getAllWorkflows: opts.getAllWorkflows,
    getCwd: opts.getCwd,
    evolutionLedger: opts.evolutionLedger,
    themis: opts.themis,
  })

  const signal: AbortSignal | undefined = toolUseContext.abortController?.signal
  let releaseAbortListener: (() => void) | undefined

  try {
    // The sync timeout bounds only the synchronous prologue — a well-formed
    // script hands back its Promise immediately.
    const rawResult = vmScript.runInContext(vmContext, {
      timeout: opts.syncTimeoutMs ?? SYNC_TIMEOUT_MS,
    })
    const envelopePromise = makeSettle(vmContext)(rawResult)
    // Should the abort win the race below, this settle's late rejection must
    // not surface as an unhandled rejection.
    envelopePromise.catch(() => {})

    let envelope: { v: unknown }
    if (signal) {
      const abortGate = new Promise<never>((_resolve, reject) => {
        const trip = () => reject(new Error('Workflow aborted'))
        if (signal.aborted) {
          trip()
        } else {
          signal.addEventListener('abort', trip)
          releaseAbortListener = () => signal.removeEventListener('abort', trip)
        }
      })
      envelope = await Promise.race([envelopePromise, abortGate])
    } else {
      envelope = await envelopePromise
    }
    const settledValue = envelope.v

    // Marshal out. The structured clone is authoritative; when it fails on an
    // OBJECT value, fall back to a functions-dropped JSON round-trip. For a
    // failing primitive nothing safer exists — re-throw.
    let result: unknown
    try {
      result = cloneFromVM(settledValue)
    } catch (cloneErr) {
      if (settledValue === null || typeof settledValue !== 'object') throw cloneErr
      const dropFunctions = (_key: string, member: unknown) =>
        typeof member === 'function' ? undefined : member
      result = JSON.parse(JSON.stringify(settledValue, dropFunctions) ?? 'null')
    }
    // Serialize-once sanity: whatever survives this line also survives the
    // journal and notification writes downstream.
    JSON.stringify(result)

    return {
      result,
      agentCount: hooks.getAgentCount(),
      logs: capturedLogs,
      failures: hooks.getFailures(),
      durationMs: Date.now() - beganAt,
    }
  } catch (err) {
    let error: string
    try {
      const stackText = (err as { stack?: unknown } | null)?.stack
      if (typeof stackText === 'string') {
        error = condenseStack(stackText)
      } else if (err instanceof Error) {
        error = err.message
      } else {
        error = String(err)
      }
    } catch {
      error = '<unprintable error>'
    }
    return {
      result: null,
      agentCount: hooks.getAgentCount(),
      logs: capturedLogs,
      failures: hooks.getFailures(),
      durationMs: Date.now() - beganAt,
      error,
    }
  } finally {
    releaseAbortListener?.()
  }
}

// ============================================================================
// The workflow() callable — one nesting level, no more.
//
// Resolves a saved workflow by name (or a {scriptPath} when a disk reader was
// injected), compiles the body, and runs it in a FRESH child realm riding the
// parent's hooks: one concurrency cap, one agent counter, one abort signal,
// one budget. The child's phase() is a no-op, its agents pin under a "▸ name"
// progress group, and its own workflow() rejects. The child realm gets the
// full dressing — determinism shim, intrinsic lockdown, tunnelled
// projections, cloned args, settle plus clone on the way out.
// ============================================================================
export interface SubWorkflowDeps {
  abortSignal?: AbortSignal
  budget: unknown
  timers: Pick<WorkflowTimers, 'setTimeout' | 'clearTimeout'>
  /**
   * Working directory for registry resolution. Injected by the tool layer
   * (its accessor honours per-run overrides); defaults to process.cwd() so
   * the engine stays runnable stand-alone.
   */
  getCwd?: () => string
  resolveWorkflow: (
    name: string,
    cwd: string,
  ) => Promise<{ name: string; script: string } | undefined>
  getAllWorkflows: (cwd: string) => Promise<Array<{ name: string }>>
  /** Disk reader for workflow({scriptPath}) — optional, injected. */
  readScriptFile?: (path: string) => Promise<{ script: string; path: string } | { error: string }>
  /** Mirrored into the child realm when present (same rule as the parent). */
  evolutionLedger?: EvolutionLedgerHost
  /** Mirrored into the child realm when present. One host per RUN — parent
   *  and child share the phase machine and trace table. */
  themis?: ThemisWorkflowHost
  hooks: {
    agent: (prompt: string, opts?: unknown) => Promise<unknown>
    parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>
    pipeline: (items: unknown[], ...stages: Array<(...a: unknown[]) => unknown>) => Promise<unknown[]>
    resolvePhase: (title: string, kind?: 'child') => number
    log: (msg: string) => void
    recordFailure: (msg: string) => void
  }
}

export function makeSubWorkflowCallable(deps: SubWorkflowDeps) {
  // Runs per child name, for "#2"-style labels on repeat invocations.
  const runsByName = new Map<string, number>()

  const fn = async function workflow(
    nameOrRef: string | { scriptPath: string },
    args?: unknown,
  ): Promise<unknown> {
    // Once the run is aborted the parent's own abort race unwinds everything;
    // resolving here would let the script keep racing. Park forever instead.
    if (deps.abortSignal?.aborted) return new Promise(() => {})

    // ── resolve the child's source ──────────────────────────────────────────
    let body: string
    let name: string
    if (typeof nameOrRef === 'string') {
      const cwd = deps.getCwd ? deps.getCwd() : process.cwd()
      const found = await deps.resolveWorkflow(nameOrRef, cwd)
      if (!found) {
        const available = (await deps.getAllWorkflows(cwd)).map(w => w.name).join(', ')
        throw new Error(
          `workflow('${nameOrRef}'): no workflow with that name. Available: ${available || '(none)'}`,
        )
      }
      const parsed = parseWorkflowScript(found.script)
      if ('ok' in parsed && parsed.ok === false) {
        throw new Error(`workflow('${nameOrRef}'): ${parsed.error}`)
      }
      name = found.name
      body = (parsed as { scriptBody: string }).scriptBody
    } else if (
      nameOrRef &&
      typeof nameOrRef === 'object' &&
      typeof nameOrRef.scriptPath === 'string'
    ) {
      if (!deps.readScriptFile) {
        throw new TypeError('workflow({scriptPath}) is not available in this run')
      }
      const file = await deps.readScriptFile(nameOrRef.scriptPath)
      if ('error' in file) {
        throw new Error(`workflow({scriptPath: '${nameOrRef.scriptPath}'}): ${file.error}`)
      }
      const parsed = parseWorkflowScript(file.script)
      if ('ok' in parsed && parsed.ok === false) {
        throw new Error(`workflow({scriptPath: '${nameOrRef.scriptPath}'}): ${parsed.error}`)
      }
      name = (parsed as { meta: { name: string } }).meta.name
      body = (parsed as { scriptBody: string }).scriptBody
    } else {
      throw new TypeError('workflow() expects a workflow name (string) or {scriptPath: string}')
    }

    const compiled = compileWorkflow(body)
    if (!compiled.ok) throw new Error(`workflow('${name}'): ${compiled.error}`)

    // ── progress-group identity ─────────────────────────────────────────────
    const runIndex = (runsByName.get(name) ?? 0) + 1
    runsByName.set(name, runIndex)
    const groupLabel = `${CHILD_GROUP_GLYPH} ${name}${runIndex > 1 ? ` #${runIndex}` : ''}`
    deps.hooks.resolvePhase(groupLabel, 'child')
    deps.hooks.log(`${CHILD_GROUP_GLYPH} running dynamic workflow ${name}`)

    // ── the child realm ─────────────────────────────────────────────────────
    const logPrefix = `[${name}] `
    // The child rides the parent's hooks, with three differences: its agents
    // pin to the child group, its phase() does nothing, and its workflow()
    // refuses — one level of nesting, no more.
    const childEntrypoints = {
      agent: (p: string, o: unknown) =>
        deps.hooks.agent(p, { ...(o as object), phase: groupLabel }),
      parallel: deps.hooks.parallel,
      pipeline: deps.hooks.pipeline,
      workflow: () =>
        Promise.reject(
          new Error(
            'workflow() cannot be called from within a child workflow — nesting is limited to one level. ' +
              'Inline the inner script or call its agents directly.',
          ),
        ),
    }
    const seed = {
      __proto__: null,
      budget: deps.budget,
      setTimeout: deps.timers.setTimeout,
      clearTimeout: deps.timers.clearTimeout,
      phase: errorTunnel(() => {}),
      log: errorTunnel((m: unknown) =>
        deps.hooks.log(logPrefix + (typeof m === 'string' ? m : `[${typeof m}]`)),
      ),
      console: makeVMConsole(m => deps.hooks.log(logPrefix + m)),
    }

    try {
      const ctx = vm.createContext(seed as object, {
        codeGeneration: { strings: false, wasm: false },
      })
      installDeterminismShim(ctx)
      hardenVMIntrinsics(ctx)
      const wrapHostFn = makeHostFnWrapper(ctx)
      for (const [key, impl] of Object.entries(childEntrypoints)) {
        defineScriptGlobal(
          ctx,
          key,
          wrapHostFn(errorTunnelAsync(impl as (...a: unknown[]) => Promise<unknown>)),
        )
      }
      const settle = makeSettle(ctx)
      const cloneIn = makeBoundaryClone(ctx)
      if (deps.evolutionLedger) {
        defineScriptGlobal(
          ctx,
          'ledger',
          projectHostApi(ctx, wrapHostFn, deps.evolutionLedger, LEDGER_API),
        )
      }
      if (deps.themis) {
        defineScriptGlobal(ctx, 'themis', projectHostApi(ctx, wrapHostFn, deps.themis, THEMIS_API))
      }
      defineScriptGlobal(ctx, 'args', args === undefined ? undefined : cloneIn(args))

      const settled = await settle(
        compiled.vmScript.runInContext(ctx, { timeout: SYNC_TIMEOUT_MS }),
      )
      // Clone through the child's own boundary cloner: the parent receives
      // plain data (functions dropped, cycles broken, widths capped).
      const result = cloneIn(settled.v)
      deps.hooks.log(`${CHILD_GROUP_GLYPH} ${name} done`)
      return result
    } catch (e) {
      // The recorded failure carries the condensed STACK text, not just the
      // message — child failures are otherwise undebuggable from the summary.
      let msg: string
      try {
        msg = condenseThrown(e)
      } catch {
        msg = '<unprintable error>'
      }
      const { name: thrownName, stack } = readThrownShape(e)
      deps.hooks.recordFailure(`${groupLabel}: ${msg}`)
      deps.hooks.log(`${CHILD_GROUP_GLYPH} ${name} failed: ${msg}`)
      throw detachedError(msg, thrownName, stack)
    }
  }
  // The callable is script-visible: no prototype walk-back, nothing to mine.
  Object.setPrototypeOf(fn, null)
  delete (fn as { constructor?: unknown }).constructor
  delete (fn as { prototype?: unknown }).prototype
  return fn
}

// The tool layer consumes these alongside the run entrypoints.
export { parseWorkflowScript, compileWorkflow }
