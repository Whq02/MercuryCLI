
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


const RESULT_LOG_CAP = 1000

const CHILD_GROUP_GLYPH = '▸'

const STACK_FRAME_CAP = 5


export interface TokenBudget {
  total: number | null
  getTurnSpent(): number
}

export interface WorkflowHooks {
  agent(prompt: string, opts?: unknown): Promise<unknown>
  parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>
  pipeline(items: unknown[], ...stages: Array<(...a: unknown[]) => unknown>): Promise<unknown[]>
  log(message: unknown): void
  phase(title: unknown): void
  getAgentCount(): number
  getFailures(): string[]
  bindVMAwait(bridge: {
    settle: (v: unknown) => Promise<{ v: unknown }>
    call: (fn: unknown, ...args: unknown[]) => unknown
    clone: (hostVal: unknown) => unknown
  }): void
}

export interface EvolutionLedgerHost {
  record(row: unknown): Promise<unknown>
  read(program: unknown): Promise<unknown>
  report(program: unknown): Promise<unknown>
}

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

export interface WorkflowToolContext {
  abortController?: AbortController
  canUseTool?: unknown
  [k: string]: unknown
}

export interface JournalSnapshot {
  results: Map<string, unknown>
  started: Map<string, unknown[]>
}

export interface WorkflowJournal {
  load(): Promise<JournalSnapshot>
  append(entry: unknown): Promise<void>
}

export interface ProgressFrame {
  type: string
  toolUseID?: string
  data?: { type?: string; message?: string; [k: string]: unknown }
  [k: string]: unknown
}

export interface WorkflowTimers {
  setTimeout: (cb: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  bindVMInvoke: (invoke: (fn: () => void) => void) => void
}

export function makeTimers(signal?: AbortSignal): WorkflowTimers {
  const pending = new Set<number>()
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


function defineScriptGlobal(ctx: vm.Context, name: string, value: unknown): void {
  Object.defineProperty(ctx, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

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

function condenseStack(stack: string, max = STACK_FRAME_CAP): string {
  const lines = stack.split('\n')
  const frames = lines.slice(1).filter(line => line.trim().startsWith('at '))
  if (frames.length <= max) return stack
  return [lines[0] ?? '', ...frames.slice(0, max)].join('\n')
}

function condenseThrown(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  if (!e.stack) return e.message
  return condenseStack(e.stack)
}

function detachedError(message: string, name = 'Error', stack?: string): object {
  const toString = () => `${name}: ${message}`
  Object.setPrototypeOf(toString, null)
  return { __proto__: null, name, message, stack: stack ?? `${name}: ${message}`, toString }
}

async function emptyResolveWorkflow(): Promise<undefined> {
  return undefined
}
async function emptyGetAllWorkflows(): Promise<Array<{ name: string }>> {
  return []
}

export interface BuildContextOptions {
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
  resolveWorkflow?: SubWorkflowDeps['resolveWorkflow']
  getAllWorkflows?: SubWorkflowDeps['getAllWorkflows']
  getCwd?: SubWorkflowDeps['getCwd']
  evolutionLedger?: EvolutionLedgerHost
  themis?: ThemisWorkflowHost
}

export function buildVMContext(opts: BuildContextOptions): {
  vmContext: vm.Context
  hooks: WorkflowHooks
} {
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

  const sandboxConsole = makeVMConsole((message: string) =>
    opts.emitProgress({
      type: 'progress',
      toolUseID: 'workflow_log',
      data: { type: 'workflow_log', message },
    }),
  )

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

  const signal: AbortSignal | undefined = opts.toolUseContext.abortController?.signal
  const timers = makeTimers(signal)

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

  installDeterminismShim(ctx)
  hardenVMIntrinsics(ctx)
  timers.bindVMInvoke(vm.runInContext('(cb => { cb() })', ctx))

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

  let realmArgs: unknown
  if (opts.args !== undefined) {
    const wire = JSON.stringify(opts.args)
    if (wire !== undefined) {
      realmArgs = vm.runInContext(`JSON.parse(${JSON.stringify(wire)})`, ctx)
    }
  }
  defineScriptGlobal(ctx, 'args', realmArgs)

  hooks.bindVMAwait({
    settle: makeSettle(ctx),
    call: makeVMCall(ctx),
    clone: makeBoundaryClone(ctx),
  })

  return { vmContext: ctx, hooks }
}

export interface RunResult {
  result: unknown
  agentCount: number
  logs: string[]
  failures: string[]
  durationMs: number
  error?: string
}

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
    const rawResult = vmScript.runInContext(vmContext, {
      timeout: opts.syncTimeoutMs ?? SYNC_TIMEOUT_MS,
    })
    const envelopePromise = makeSettle(vmContext)(rawResult)
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

    let result: unknown
    try {
      result = cloneFromVM(settledValue)
    } catch (cloneErr) {
      if (settledValue === null || typeof settledValue !== 'object') throw cloneErr
      const dropFunctions = (_key: string, member: unknown) =>
        typeof member === 'function' ? undefined : member
      result = JSON.parse(JSON.stringify(settledValue, dropFunctions) ?? 'null')
    }
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

export interface SubWorkflowDeps {
  abortSignal?: AbortSignal
  budget: unknown
  timers: Pick<WorkflowTimers, 'setTimeout' | 'clearTimeout'>
  getCwd?: () => string
  resolveWorkflow: (
    name: string,
    cwd: string,
  ) => Promise<{ name: string; script: string } | undefined>
  getAllWorkflows: (cwd: string) => Promise<Array<{ name: string }>>
  readScriptFile?: (path: string) => Promise<{ script: string; path: string } | { error: string }>
  evolutionLedger?: EvolutionLedgerHost
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
  const runsByName = new Map<string, number>()

  const fn = async function workflow(
    nameOrRef: string | { scriptPath: string },
    args?: unknown,
  ): Promise<unknown> {
    if (deps.abortSignal?.aborted) return new Promise(() => {})

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

    const runIndex = (runsByName.get(name) ?? 0) + 1
    runsByName.set(name, runIndex)
    const groupLabel = `${CHILD_GROUP_GLYPH} ${name}${runIndex > 1 ? ` #${runIndex}` : ''}`
    deps.hooks.resolvePhase(groupLabel, 'child')
    deps.hooks.log(`${CHILD_GROUP_GLYPH} running dynamic workflow ${name}`)

    const logPrefix = `[${name}] `
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
      const result = cloneIn(settled.v)
      deps.hooks.log(`${CHILD_GROUP_GLYPH} ${name} done`)
      return result
    } catch (e) {
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
  Object.setPrototypeOf(fn, null)
  delete (fn as { constructor?: unknown }).constructor
  delete (fn as { prototype?: unknown }).prototype
  return fn
}

export { parseWorkflowScript, compileWorkflow }
