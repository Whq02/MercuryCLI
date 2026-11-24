;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'

const HOME = mkdtempSync(join(tmpdir(), 'turn-scenarios-'))
const RIG_NAMES: Record<string, string | undefined> = {
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: mkdtempSync(join(tmpdir(), 'turn-scenarios-daemon-')),
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BARE: undefined,
  MERCURY_EFFORT_LEVEL: undefined,
  MERCURY_MAX_OUTPUT_TOKENS: undefined,
  MERCURY_BLOCKING_LIMIT_OVERRIDE: undefined,
  MERCURY_COMPACT: undefined,
  MERCURY_AUTO_COMPACT: undefined,
  MERCURY_SCRIPTED_STREAM: undefined,
  MERCURY_MODEL: undefined,
  ANTHROPIC_API_KEY: undefined,
  NODE_ENV: undefined,
}

const { runEventCore } = await import('../../src/engine/loop/turn-machine.ts')
const bootstrap = await import('../../src/boot/process-state/processState.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createAssistantAPIErrorMessage, createFoldBoundaryMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { FallbackTriggeredError } = await import('../../src/engine/requests/withRetry.ts')
const { ImageSizeError } = await import('../../src/engine/requests/imageValidation.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const queue = await import('../../src/daemon/runner/messageQueueManager.ts')
const sessionHooks = await import('../../src/integrations/event-hooks/sessionHooks.ts')
const guards = await import('../../src/permissions/guards/guards.ts')
const settingsRoad = await import('../../src/platform/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
const { emptyReplyNote, markEmptyReply } = await import('../../src/models/roads/emptyReply.ts')
const { streamFaultAfterPartialText } = await import('../../src/engine/requests/apiErrorRows.ts')
const gate = await import('../../src/models/roads/toolCallGate.ts')
const { operatorPauseGate } = await import('../../src/engine/loop/pauseGate.ts')

export const MODEL = 'claude-opus-4-8'
export const FALLBACK_MODEL = 'claude-sonnet-5'

type Row = Record<string, unknown>
type AssistantRow = ReturnType<typeof createAssistantMessage>

export type Rig = {
  ctx: Row
  abortController: AbortController
  getAppState: () => Row
  setAppState: (update: (prev: never) => never) => void
}

export type ModelStep =
  | { kind: 'yield'; value: unknown }
  | { kind: 'do'; fn: (env: { options: Row; signal: AbortSignal; rig: Rig }) => void }
  | { kind: 'throw'; error: unknown }

type ToolPlan = {
  name: string
  result?: string
  backfill?: boolean
  serial?: boolean
  marks?: boolean
  onCall?: (rig: Rig) => void
}

export type Plan = {
  script: ModelStep[][]
  seed?: unknown[]
  tools?: ToolPlan[]
  refreshedTools?: ToolPlan[]
  autocompact?: Row[]
  maxTurns?: number
  fallbackModel?: string
  model?: string
  querySource?: string
  agentId?: string
  sessionKind?: 'headless' | 'oculus'
  loopGuard?: boolean
  env?: Record<string, string>
  recompose?: boolean
  seatWait?: boolean
  appState?: Row
  before?: (rig: Rig) => void | (() => void)
}

export type Scenario = {
  name: string
  transitions: string[]
  terminal: string
  oncePerProcess?: true
  plan: () => Plan
}

export type Recording = {
  name: string
  transitions: string[]
  terminal: unknown
  log: unknown[]
  tools: unknown[]
  consumed: unknown[]
  after: unknown
}

const CLOCK_KEYS = new Set(['waitedMs', 'elapsedMs', 'durationMs', 'sinceMs', 'startTime', 'sentAt', 'atMs', 'ttftMs'])
const LONG_TEXT = 2_000
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

function masker(): (value: unknown) => unknown {
  const ids = new Map<string, string>()
  const words = (raw: string): string => {
    const masked = raw
      .split(HOME)
      .join('<home>')
      .replace(UUID, found => {
        const key = found.toLowerCase()
        let name = ids.get(key)
        if (name === undefined) {
          name = `<uuid:${ids.size + 1}>`
          ids.set(key, name)
        }
        return name
      })
      .replace(INSTANT, '<instant>')
    return masked.length > LONG_TEXT ? `<${masked.length} characters, sha256 ${createHash('sha256').update(masked).digest('hex').slice(0, 16)}>` : masked
  }
  const walk = (value: unknown, key: string | undefined, above: readonly unknown[]): unknown => {
    if (value === undefined) return '<undefined>'
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'string') return words(value)
    if (typeof value === 'number') return key !== undefined && CLOCK_KEYS.has(key) ? '<clock>' : value
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'function') return '<function>'
    if (typeof value === 'symbol') return String(value)
    if (above.includes(value)) return '<cycle>'
    const below = [...above, value]
    if (value instanceof Error) return { error: value.name, message: words(value.message) }
    if (Array.isArray(value)) return value.map(item => walk(item, undefined, below))
    if (value instanceof Map) return { map: [...value.entries()].map(([k, v]) => [walk(k, undefined, below), walk(v, undefined, below)]) }
    if (value instanceof Set) return { set: [...value].map(item => walk(item, undefined, below)) }
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
    if (proto !== null && proto !== Object.prototype) return `<${proto.constructor?.name ?? 'object'}>`
    const out: Row = {}
    for (const [name, item] of Object.entries(value as Row)) out[name] = walk(item, name, below)
    return out
  }
  return value => walk(value, undefined, [])
}

function makeTool(plan: ToolPlan, rigOf: () => Rig, tools: unknown[], mask: (value: unknown) => unknown): never {
  return {
    name: plan.name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => plan.name,
    isEnabled: () => true,
    isConcurrencySafe: () => plan.serial !== true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    ...(plan.backfill === true && {
      backfillObservableInput: (input: Row) => {
        input.rig_added = true
      },
    }),
    async validateInput() {
      return { result: true }
    },
    async call(input: Row, ctx: Row) {
      tools.push(mask({ tool: plan.name, input, mark: ctx.rigMark, sawMessages: ctx.messages }))
      plan.onCall?.(rigOf())
      return {
        data: plan.result ?? `echo:${String(input?.text ?? '')}`,
        ...(plan.marks === true ? { contextModifier: (context: Row) => ({ ...context, rigMark: Number(context.rigMark ?? 0) + 1 }) } : {}),
      }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
      ...(String(data).includes('FAIL') ? { is_error: true } : {}),
    }),
  } as never
}

function makeRig(plan: Plan, tools: unknown[]): Rig {
  let appState: Row = { ...(getDefaultAppState() as unknown as Row), effortValue: 'high', ...(plan.appState ?? {}) }
  const abortController = new AbortController()
  const setAppState = (update: (prev: never) => never): void => {
    appState = update(appState as never) as unknown as Row
  }
  const ctx: Row = {
    abortController,
    options: {
      commands: [],
      tools,
      engineModel: plan.model ?? MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState,
    setAppStateForTasks: setAppState,
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: plan.agentId,
  }
  return { ctx, abortController, getAppState: () => appState, setAppState }
}

function setLoopGuard(value: boolean | undefined): void {
  const path = settingsRoad.getSettingsFilePathForSource('userSettings')!
  if (value === undefined) rmSync(path, { force: true })
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ turns: { loopGuard: value } }, null, 2))
  }
  resetSettingsCache()
}

const allowAll = async (_tool: unknown, input: Row) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

export type ModelRequest = { messages: unknown[]; systemPrompt: unknown; tools: unknown[]; signal: AbortSignal; options: Row }

export type OpenRig = {
  rig: Rig
  params: Row
  requests: ModelRequest[]
  log: unknown[]
  toolLane: unknown[]
  consumed: string[]
  mask: (value: unknown) => unknown
  counts: { modelCalls: number; folds: number }
  session: string
  home: string
  close: () => void
}

function takeProcess(): { put: (name: string, value: string | undefined) => void; handBack: () => void } {
  const names = new Map<string, string | undefined>()
  const session = bootstrap.getSessionId()
  const projectDir = bootstrap.getSessionProjectDir()
  const interactive = bootstrap.getIsInteractive()
  const kind = bootstrap.getSessionKind()
  const put = (name: string, value: string | undefined): void => {
    if (!names.has(name)) names.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const [name, value] of Object.entries(RIG_NAMES)) put(name, value)
  const handBack = (): void => {
    for (const [name, value] of names) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    names.clear()
    if (bootstrap.getSessionId() !== session) bootstrap.switchSession(session, projectDir)
    bootstrap.setIsInteractive(interactive)
    bootstrap.setSessionKind(kind)
  }
  return { put, handBack }
}

export function openRig(plan: Plan): OpenRig {
  const taken = takeProcess()
  enableConfigs()
  const mask = masker()
  const log: unknown[] = []
  const toolLane: unknown[] = []
  const tools: unknown[] = []
  const counts = { modelCalls: 0, folds: 0 }
  const requests: ModelRequest[] = []
  let rig: Rig | undefined
  for (const tool of plan.tools ?? [{ name: 'EchoTool' }]) tools.push(makeTool(tool, () => rig!, toolLane, mask))
  rig = makeRig(plan, tools)
  if (plan.refreshedTools !== undefined) {
    const refreshed = [...tools, ...plan.refreshedTools.map(tool => makeTool(tool, () => rig!, toolLane, mask))]
    ;(rig.ctx.options as Row).refreshTools = () => refreshed
  }
  if (plan.seatWait === true) {
    rig.ctx.onSeatWait = (words: unknown): void => {
      log.push(mask({ seat_wait: words }))
    }
  }
  const session = String(bootstrap.regenerateSessionId())
  bootstrap.setIsInteractive(false)
  bootstrap.setSessionKind(plan.sessionKind ?? 'headless')
  queue.resetCommandQueue()
  setLoopGuard(plan.loopGuard)
  for (const [name, value] of Object.entries(plan.env ?? {})) taken.put(name, value)
  const undo = plan.before?.(rig)
  async function* callModel(req: { messages: unknown[]; systemPrompt: unknown; tools?: Array<{ name?: string }>; signal: AbortSignal; options: Row }): AsyncGenerator<never, void> {
    const index = counts.modelCalls++
    requests.push({ messages: [...req.messages], systemPrompt: req.systemPrompt, tools: [...(req.tools ?? [])], signal: req.signal, options: req.options })
    log.push(
      mask({
        model_call: index + 1,
        model: req.options.model,
        toolChoice: req.options.toolChoice,
        maxOutputTokensOverride: req.options.maxOutputTokensOverride,
        fallbackModel: req.options.fallbackModel,
        effortValue: req.options.effortValue,
        querySource: req.options.querySource,
        skipCacheWrite: req.options.skipCacheWrite,
        agentId: req.options.agentId,
        tools: (req.tools ?? []).map(tool => tool.name),
        systemPrompt: req.systemPrompt,
        messages: req.messages,
      }),
    )
    const steps = plan.script[index]
    if (!steps) throw new Error(`model script exhausted at call ${index + 1}`)
    for (const step of steps) {
      if (step.kind === 'yield') yield step.value as never
      else if (step.kind === 'do') step.fn({ options: req.options, signal: req.signal, rig: rig! })
      else throw step.error
    }
  }
  const autocompact = async (messages: unknown[], _context: unknown, cacheSafe: { forkContextMessages?: unknown[]; postFoldCarry?: unknown[] }, source: unknown, tracking: unknown, prunedTokensFreed: unknown, forced: unknown): Promise<Row> => {
    const index = counts.folds++
    log.push(mask({ autocompact: index + 1, source, tracking, prunedTokensFreed, forced, messages, carry: cacheSafe?.postFoldCarry }))
    return plan.autocompact?.[index] ?? { wasCompacted: false }
  }
  let seeded = 0
  const params: Row = {
    messages: plan.seed ?? [createUserMessage({ content: 'hello there rig' })],
    systemPrompt: ['rig system prompt'],
    userContext: {},
    systemContext: {},
    canUseTool: allowAll,
    toolUseContext: rig.ctx,
    querySource: plan.querySource ?? 'sdk',
    maxTurns: plan.maxTurns,
    fallbackModel: plan.fallbackModel,
    ...(plan.recompose === true
      ? {
          recompose: async () => {
            log.push({ recompose: true })
            return { systemPrompt: ['rig system prompt, composed again'], userContext: { composed: 'again' }, systemContext: {} }
          },
        }
      : {}),
    deps: {
      callModel,
      autocompact,
      microcompact: async (messages: unknown[]) => ({ messages }),
      uuid: () => `00000000-0000-4000-8000-${String(++seeded).padStart(12, '0')}`,
    },
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    if (typeof undo === 'function') undo()
    setLoopGuard(undefined)
    queue.resetCommandQueue()
    taken.handBack()
  }
  return { rig, params, requests, log, toolLane, consumed: [], mask, counts, session, home: HOME, close }
}

export async function record(scenario: Scenario): Promise<Recording> {
  const open = openRig(scenario.plan())
  const { log, mask } = open
  const gen = runEventCore(open.params as never, open.consumed)
  const transitions: string[] = []
  let terminal: unknown
  try {
    let step = await gen.next()
    while (!step.done) {
      const event = step.value as { kind: string; transition?: { reason: string } }
      if (event.kind === 'turn_settled' && event.transition) transitions.push(event.transition.reason)
      log.push(mask({ event }))
      step = await gen.next()
    }
    terminal = step.value
  } catch (error) {
    terminal = { thrown: error }
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  const queued = queue.getCommandQueue().length
  open.close()
  return {
    name: scenario.name,
    transitions,
    terminal: mask(terminal),
    log,
    tools: open.toolLane,
    consumed: open.consumed.map(uuid => mask(uuid)),
    after: mask({ engineModel: (open.rig.ctx.options as Row).engineModel, modelCalls: open.counts.modelCalls, folds: open.counts.folds, queued }),
  }
}

export type ScriptedRun = { events: Array<Row & { kind: string }>; terminal: Row; requests: ModelRequest[]; rig: Rig; consumed: string[]; transitions: string[]; session: string; home: string }

export async function runScripted(plan: Plan): Promise<ScriptedRun> {
  const open = openRig(plan)
  const events: Array<Row & { kind: string }> = []
  try {
    const gen = runEventCore(open.params as never, open.consumed)
    let step = await gen.next()
    while (!step.done) {
      events.push(step.value as unknown as Row & { kind: string })
      step = await gen.next()
    }
    await new Promise(resolve => setTimeout(resolve, 5))
    const transitions = events.filter(event => event.kind === 'turn_settled').map(event => String((event.transition as { reason?: unknown }).reason))
    return { events, terminal: step.value as unknown as Row, requests: open.requests, rig: open.rig, consumed: open.consumed, transitions, session: open.session, home: open.home }
  } finally {
    open.close()
  }
}

export type Drained<T> = { events: Array<Row & { kind: string }>; decision: T }

export async function drain<T>(steps: AsyncGenerator<unknown, T> | Generator<unknown, T>): Promise<Drained<T>> {
  const events: Array<Row & { kind: string }> = []
  let step = await steps.next()
  while (!step.done) {
    events.push(step.value as Row & { kind: string })
    step = await steps.next()
  }
  return { events, decision: step.value }
}

export type Planted = OpenRig & { run: Row; state: Row }

export async function plantRun(plan: Plan): Promise<Planted> {
  const open = openRig(plan)
  const { createEventMint } = await import('../../src/engine/loop/events.ts')
  const { BudgetGuard } = await import('../../src/engine/loop/budget-guard.ts')
  const { FRESH_OVERFLOW_EPISODE } = await import('../../src/engine/compaction/overflowRecovery.ts')
  const { createSystemMessage } = await import('../../src/engine/messages/messages.ts')
  const emit = createEventMint()
  const pendingMemoryWrites: Array<{ id: string; argumentsRaw: string }> = []
  const params = open.params
  const run: Row = {
    params,
    systemPrompt: params.systemPrompt,
    userContext: params.userContext,
    systemContext: params.systemContext,
    fallbackModel: params.fallbackModel,
    querySource: params.querySource,
    skipCacheWrite: undefined,
    deps: params.deps,
    budgetGuard: new BudgetGuard(),
    emit,
    consumedCommandUuids: open.consumed,
    checkpointSettleWarned: false,
    announcedStepNudges: 0,
    awaitingReply: [],
    pendingMemoryWrites,
    holdMemoryWriteRefusals: (refusals: Array<{ id: string; argumentsRaw: string }>): void => {
      for (const refusal of gate.memoryWriteRefusals(refusals as never)) {
        if (!pendingMemoryWrites.some(held => held.id === refusal.id && held.argumentsRaw === refusal.argumentsRaw)) pendingMemoryWrites.push(refusal)
      }
    },
    memoryWriteLostEvent: (): unknown => {
      if (pendingMemoryWrites.length === 0) return null
      const line = gate.memoryWriteLostNotice(pendingMemoryWrites as never)
      pendingMemoryWrites.length = 0
      return emit({ kind: 'notice', message: createSystemMessage(line, 'error') })
    },
  }
  const state: Row = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: undefined,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    streamFaultRecoveryCount: 0,
    toolCallRefusalRecoveryCount: 0,
    turnCount: 1,
    transition: undefined,
    overflowEpisode: FRESH_OVERFLOW_EPISODE,
    pendingOverflow: undefined,
  }
  return { ...open, run, state }
}

export type PlantedReply = Planted & { iter: Row; events: Array<Row & { kind: string }> }

export async function plantReply(plan: Plan, change: { state?: Row; run?: Row } = {}): Promise<PlantedReply> {
  const planted = await plantRun(plan)
  try {
    Object.assign(planted.state, change.state ?? {})
    Object.assign(planted.run, change.run ?? {})
    const { makeRequest } = await import('../../src/engine/loop/turn/makeRequest.ts')
    const { modelReply } = await import('../../src/engine/loop/turn/modelReply.ts')
    const request = await drain(makeRequest(planted.run as never, planted.state as never, 1))
    if (request.decision.kind !== 'go_on') throw new Error(`the planted request did not go on: ${JSON.stringify(planted.mask(request.decision))}`)
    const iter = request.decision.iter as unknown as Row
    const reply = await drain(modelReply(planted.run as never, iter as never))
    if (reply.decision.kind !== 'go_on') throw new Error(`the planted reply did not go on: ${JSON.stringify(planted.mask(reply.decision))}`)
    return { ...planted, iter, events: [...request.events, ...reply.events] }
  } catch (error) {
    planted.close()
    throw error
  }
}

export const reasonOf = (decision: unknown): string => {
  const settled = decision as { kind?: string; next?: { transition?: { reason?: string } }; terminal?: { reason?: string } } | undefined
  if (settled === undefined) return 'nothing'
  if (settled.kind === 'hand_over') return `hand_over ${settled.next?.transition?.reason}`
  if (settled.kind === 'end') return `end ${settled.terminal?.reason}`
  return String(settled.kind)
}

export const noticesOf = (events: Array<Row & { kind: string }>): string[] =>
  events
    .filter(event => event.kind === 'notice')
    .map(event => {
      const message = event.message as { content?: unknown; message?: { content?: unknown } }
      const content = message.content ?? message.message?.content
      return typeof content === 'string' ? content : JSON.stringify(content)
    })

export const fixtures = {
  says: (words: string, stop = 'end_turn'): AssistantRow => says(words, stop),
  calls: (id: string, name: string, input: Row): AssistantRow => calls(id, name, input),
  ask: (words: string): unknown => ask(words),
  yields: (...values: unknown[]): ModelStep[] => values.map(y),
  outputCut: (): unknown => outputCut(),
  thinks: (stop: string): AssistantRow => thinks(stop),
  pauses: (words: string): AssistantRow => pauses(words),
  empty: (kind: 'empty' | 'silence' | 'cap'): AssistantRow => empty(kind),
  faulted: (): unknown => faulted(),
  refusal: (over: Partial<Refusal> = {}): Refusal => refusal(over),
  refused: (...refusals: Refusal[]): AssistantRow => refused(...refusals),
  cutCall: (outputTokens: number, model?: string): unknown[] => cutCall(outputTokens, model),
  overflowed: (signal: Row): unknown => overflowed(signal),
  fat: (words: string, inputTokens: number): AssistantRow => fat(words, inputTokens),
  folded: (tokens?: number): Row => folded(tokens),
  history: (): unknown[] => history(),
  liveCheckpoint: (): unknown[] => liveCheckpoint(),
  crewTask: (pending: string[]): Row => crewTask(pending),
  stopGuard: (id: string, judge: () => Promise<Row>) => stopGuard(id, judge),
  hooks: (map: Row) => hooks(map),
  chant: (): string => CHANT,
  providerOverflow: (): Row => ({ ...PROVIDER_OVERFLOW }),
  agent: (): string => AGENT,
}

const y = (value: unknown): ModelStep => ({ kind: 'yield', value })
const says = (words: string, stop = 'end_turn'): AssistantRow => {
  const message = createAssistantMessage({ content: words })
  message.message.stop_reason = stop as never
  return message
}
const calls = (id: string, name: string, input: Row): AssistantRow => {
  const message = createAssistantMessage({ content: [{ type: 'tool_use', id, name, input }] as never })
  message.message.stop_reason = 'tool_use'
  return message
}
const ask = (words: string): unknown => createUserMessage({ content: words })
const ping = (): unknown => ({ type: 'stream_event', event: { type: 'ping' } })
const delta = (words: string): unknown => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } } })
const outputCut = (): unknown => createAssistantAPIErrorMessage({ content: 'max output tokens hit', apiError: 'max_output_tokens' })
const thinks = (stop: string): AssistantRow => {
  const message = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'a long thought that never reached words', signature: 'rig-signature' }] as never })
  message.message.stop_reason = stop as never
  return message
}
const pauses = (words: string): AssistantRow => {
  const message = createAssistantMessage({ content: [{ type: 'text', text: words, citations: null }, { type: 'server_tool_use', id: `srvtoolu_${words.length}`, name: 'web_search', input: { query: 'the figure' } }] as never })
  message.message.stop_reason = 'pause_turn'
  return message
}
const empty = (kind: 'empty' | 'silence' | 'cap'): AssistantRow => {
  const message = createAssistantMessage({ content: emptyReplyNote('openai', kind) })
  message.message.stop_reason = 'end_turn'
  markEmptyReply(message, kind)
  return message
}
const faulted = (): unknown => createAssistantAPIErrorMessage({ content: streamFaultAfterPartialText('OpenAI', 'openai-stream-error', 'terminated'), error: 'unknown' })
type Refusal = { id: string; name: string; argumentsRaw: string; argumentsLength?: number; code: string; reason: string }
const refusal = (over: Partial<Refusal> = {}): Refusal => ({ id: 'call_bad', name: 'Bash', argumentsRaw: '{"cmd":"ls"}', code: 'schema', reason: 'Bash failed (issue):\nThe required parameter `command` is missing', ...over })
const refused = (...refusals: Refusal[]): AssistantRow => {
  const message = createAssistantMessage({ content: gate.toolCallRefusalNote('fixture', refusals[0] as never) })
  message.message.stop_reason = 'end_turn'
  ;(message as unknown as { refusedToolCalls: Refusal[] }).refusedToolCalls = refusals
  return message
}
const CUT_ARGS = '{"command": "ls -la /tmp/some/folder/that/never/clo'
const CUT_MODEL = 'deepseek-v4-pro'
const cutCall = (outputTokens: number, model = CUT_MODEL): unknown[] => {
  const cut = refusal({ id: 'call_cut', argumentsRaw: CUT_ARGS, argumentsLength: CUT_ARGS.length, code: 'invalid-json', reason: 'the arguments were not valid JSON' })
  const note = refused(cut)
  note.message.stop_reason = 'max_tokens'
  note.message.model = model
  note.message.usage = { ...note.message.usage, input_tokens: 40, output_tokens: outputTokens }
  return [note, createAssistantAPIErrorMessage({ content: 'API Error: the reply exceeded the output limit', apiError: 'max_output_tokens', error: 'max_output_tokens' })]
}
const overflowed = (signal: Row): unknown => {
  const message = createAssistantAPIErrorMessage({ content: 'API Error: prompt is too long', error: 'invalid_request' })
  ;(message as unknown as { overflowSignal: Row }).overflowSignal = signal
  return message
}
const PROVIDER_OVERFLOW = { source: 'provider', family: 'anthropic', shape: 'prompt-too-long', actualTokens: 210_000, limitTokens: 200_000 }
const NARROW_OVERFLOW = { ...PROVIDER_OVERFLOW, actualTokens: 200_010 }
const STREAM_OVERFLOW = { source: 'provider', family: 'openai', shape: 'context-length-exceeded', actualTokens: 210_000, limitTokens: 200_000 }
const faultedPastTheWindow = (): unknown => Object.assign(faulted() as object, { overflowSignal: STREAM_OVERFLOW })
const fat = (words: string, inputTokens: number): AssistantRow => {
  const message = createAssistantMessage({
    content: words,
    usage: { input_tokens: inputTokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as never,
  })
  message.message.model = MODEL
  return message
}
const chantRefused = (): AssistantRow => {
  const message = says(CHANT)
  ;(message as unknown as { refusedToolCalls: Refusal[] }).refusedToolCalls = [refusal({ id: 'call_refused_1', name: 'Grpe', argumentsRaw: '{}', code: 'unknown-tool', reason: 'no tool of that name' })]
  return message
}
const stamped = (words: string, stamp: Row): AssistantRow => Object.assign(says(words), stamp)
const thoughtBy = (model: string): AssistantRow => {
  const message = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'a thought from the other model', signature: 'rig-signature' }, { type: 'text', text: 'an answer from the other model' }] as never })
  message.message.model = model
  message.message.stop_reason = 'end_turn'
  return message
}
const dropped = (): AssistantRow => {
  const message = says('the answer, with one old thought left out.')
  ;(message.message as unknown as Row).input_transformations = [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'signature_invalid' }]
  return message
}
const pausedUntil = (then: (rig: Rig) => void) => (rig: Rig): (() => void) => {
  operatorPauseGate.pause()
  const timer = setTimeout(() => then(rig), 20)
  return () => {
    clearTimeout(timer)
    operatorPauseGate.resume()
  }
}
const SENTENCE = 'I will now check the configuration file and report back on what it holds. '
const CHANT = SENTENCE.repeat(14)
const folded = (tokens = 120): Row => ({
  wasCompacted: true,
  compactionResult: {
    boundaryMarker: createFoldBoundaryMessage('auto', 900),
    summaryMessages: [createUserMessage({ content: 'RIG SUMMARY', isCompactSummary: true })],
    attachments: [],
    hookResults: [],
    preCompactTokenCount: 900,
    postCompactTokenCount: tokens,
    truePostCompactTokenCount: tokens,
    compactionUsage: undefined,
  },
})
const history = (): unknown[] => [ask('an old question'), says('an old answer'), ask('hello there rig')]
const FILE_BODY = 'a line of the file that was read over and over\n'.repeat(350)
const readTwelveTimes = (): unknown[] => [
  ask('read the notes again and again'),
  ...Array.from({ length: 12 }, (_, i) => [
    calls(`read_${i + 1}`, 'Read', { file_path: '/rig/notes.txt' }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `read_${i + 1}`, content: FILE_BODY }] as never }),
  ]).flat(),
  says('every read is in.'),
  ask('hello there rig'),
]
const liveCheckpoint = (): unknown[] => [
  ask('dig into the store'),
  calls('cp_1', 'Checkpoint', { goal: 'probe the store' }),
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'cp_1', content: 'Checkpoint taken (2 messages).' }] as never }),
  ask('and now?'),
]
const stopGuard = (id: string, judge: () => Promise<Row>) => (): (() => void) => {
  const key = String(bootstrap.getSessionId())
  guards.engageTurnGuard(key, { id, judge } as never)
  return () => {
    guards.disengageTurnGuard(key, id)
  }
}
const hooks = (map: Row) => (rig: Rig): void => {
  sessionHooks.addSessionHooks(rig.setAppState as never, { sessionId: String(bootstrap.getSessionId()) }, map as never, { kind: 'agent', type: 'rig' })
}
const AGENT = 'agent-q1'
const crewTask = (pending: string[]): Row => ({
  tasks: {
    [AGENT]: { id: AGENT, type: 'local_agent', status: 'running', description: `Lane ${AGENT}`, agentId: AGENT, agentType: 'mercury-crew', prompt: '', startTime: 0, isBackgrounded: true, outputFile: '', outputOffset: 0, notified: false, pendingMessages: pending },
  },
  agentNameRegistry: new Map<string, string>(),
})
const BLOCKED = { MERCURY_BLOCKING_LIMIT_OVERRIDE: '100' }
const BLOCKED_NO_AUTO_FOLD = { ...BLOCKED, MERCURY_AUTO_COMPACT: '0' }

export const SCENARIOS: Scenario[] = [
  { name: 'plain_reply', transitions: [], terminal: 'completed', plan: () => ({ script: [[y(ping()), y(says('done.'))]] }) },
  {
    name: 'tool_round',
    transitions: ['next_turn'],
    terminal: 'completed',
    plan: () => ({ script: [[y(calls('tu_1', 'EchoTool', { text: 'x' }))], [y(says('after tools.'))]] }),
  },
  {
    name: 'two_tools_one_message',
    transitions: ['next_turn'],
    terminal: 'completed',
    plan: () => ({
      script: [
        [y(createAssistantMessage({ content: [{ type: 'tool_use', id: 'tu_a', name: 'EchoTool', input: { text: 'a' } }, { type: 'tool_use', id: 'tu_b', name: 'EchoTool', input: { text: 'b' } }] as never }))],
        [y(says('both ran.'))],
      ],
    }),
  },
  {
    name: 'tool_fails',
    transitions: ['next_turn'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'EchoTool', result: 'FAIL: the rig tool failed' }], script: [[y(calls('tu_f', 'EchoTool', { text: 'x' }))], [y(says('it failed.'))]] }),
  },
  {
    name: 'tool_input_backfilled',
    transitions: ['next_turn'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'EchoTool', backfill: true }], script: [[y(calls('tu_bf', 'EchoTool', { text: 'x' }))], [y(says('done.'))]] }),
  },
  {
    name: 'steering_drain',
    transitions: ['next_turn'],
    terminal: 'completed',
    plan: () => ({
      before: () => {
        queue.enqueue({ value: 'steer note one', mode: 'prompt', uuid: '11111111-1111-4111-8111-111111111111' } as never)
        queue.enqueue({ value: '/help', mode: 'prompt', uuid: '22222222-2222-4222-8222-222222222222' } as never)
        queue.enqueue({ value: 'foreign notification', mode: 'task-notification', agentId: 'agent-elsewhere', uuid: '33333333-3333-4333-8333-333333333333', priority: 'next' } as never)
        queue.enqueue({ value: 'and plainword the rest', mode: 'prompt', uuid: '44444444-4444-4444-8444-444444444444' } as never)
      },
      script: [[y(calls('tu_dr', 'EchoTool', { text: 'x' }))], [y(says('after drain'))]],
    }),
  },
  {
    name: 'fallback_model',
    transitions: [],
    terminal: 'completed',
    plan: () => ({
      fallbackModel: FALLBACK_MODEL,
      script: [[y(calls('tu_fb', 'EchoTool', { text: 'x' })), { kind: 'throw', error: new FallbackTriggeredError(MODEL, FALLBACK_MODEL) }], [y(says('recovered on fallback'))]],
    }),
  },
  {
    name: 'streaming_fallback',
    transitions: [],
    terminal: 'completed',
    plan: () => ({
      script: [[y(says('partial from the failing model')), { kind: 'do', fn: env => (env.options.onStreamingFallback as () => void)() }, y(says('fresh block one')), y(says('fresh block two'))]],
    }),
  },
  {
    name: 'fallback_without_a_ladder',
    transitions: [],
    terminal: 'model_error',
    plan: () => ({ script: [[y(calls('tu_fb', 'EchoTool', { text: 'x' })), { kind: 'throw', error: new FallbackTriggeredError(MODEL, FALLBACK_MODEL) }]] }),
  },
  {
    name: 'busy_recovery_receipt',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ script: [[y(stamped('the answer after the wait.', { busyRecovery: { provider: 'Anthropic', retries: 2, elapsedMs: 1_200, detail: 'overloaded, retried twice', status: 529 } }))]] }),
  },
  {
    name: 'stream_end_receipt',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ script: [[y(stamped('the reply that stands.', { streamEnd: { reason: 'silent-after-last-item', provider: 'OpenAI', silentMs: 45_000 } }))]] }),
  },
  {
    name: 'effort_adjusted_receipt',
    transitions: [],
    terminal: 'completed',
    oncePerProcess: true,
    plan: () => ({ script: [[y(stamped('the reply at the lower effort.', { effortAdjusted: { model: MODEL, name: 'the rig model', asked: 'max', sent: 'high' } }))]] }),
  },
  {
    name: 'model_switch_receipt',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ seed: [ask('an old question'), thoughtBy(FALLBACK_MODEL), ask('hello there rig')], script: [[y(says('an answer from this model.'))]] }),
  },
  {
    name: 'thinking_dropped_by_the_api',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ seed: [ask('an old question'), thoughtBy(MODEL), ask('hello there rig')], script: [[y(dropped())]] }),
  },
  {
    name: 'paused_then_resumed',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ seatWait: true, before: pausedUntil(() => operatorPauseGate.resume()), script: [[y(says('the answer after the pause.'))]] }),
  },
  {
    name: 'paused_then_aborted',
    transitions: [],
    terminal: 'aborted_streaming',
    plan: () => ({ seatWait: true, before: pausedUntil(rig => rig.abortController.abort()), script: [[y(says('never asked'))]] }),
  },
  {
    name: 'model_throws',
    transitions: [],
    terminal: 'model_error',
    plan: () => ({ script: [[y(calls('tu_err', 'EchoTool', { text: 'x' })), { kind: 'throw', error: new Error('rig boom') }]] }),
  },
  {
    name: 'image_too_large',
    transitions: [],
    terminal: 'image_error',
    plan: () => ({ script: [[{ kind: 'throw', error: new ImageSizeError([{ index: 0, size: 9_999_999 }] as never, 5_000_000) }]] }),
  },
  {
    name: 'abort_mid_stream',
    transitions: [],
    terminal: 'aborted_streaming',
    plan: () => ({ tools: [{ name: 'Bash' }], script: [[y(calls('tu_ab', 'Bash', { command: 'sleep 30' })), { kind: 'do', fn: env => env.rig.abortController.abort() }]] }),
  },
  {
    name: 'abort_mid_stream_steer',
    transitions: [],
    terminal: 'aborted_streaming',
    plan: () => ({ tools: [{ name: 'Bash' }], script: [[y(calls('tu_ab', 'Bash', { command: 'sleep 30' })), { kind: 'do', fn: env => env.rig.abortController.abort('interrupt') }]] }),
  },
  {
    name: 'abort_mid_stream_words_only',
    transitions: [],
    terminal: 'aborted_streaming',
    plan: () => ({ script: [[y(says('half an answer')), { kind: 'do', fn: env => env.rig.abortController.abort(new Error('the retry budget is spent: three declared waits')) }]] }),
  },
  {
    name: 'abort_before_first_delta',
    transitions: [],
    terminal: 'aborted_streaming',
    plan: () => ({ script: [[{ kind: 'do', fn: env => env.rig.abortController.abort() }]] }),
  },
  {
    name: 'provider_overflow_fold_lands',
    transitions: ['overflow_recovery'],
    terminal: 'completed',
    plan: () => ({ seed: history(), autocompact: [{ wasCompacted: false }, folded()], script: [[y(overflowed(PROVIDER_OVERFLOW))], [y(says('after the fold'))]] }),
  },
  {
    name: 'provider_overflow_fold_fails',
    transitions: ['overflow_recovery'],
    terminal: 'prompt_too_long',
    plan: () => ({ seed: history(), autocompact: [{ wasCompacted: false }, { wasCompacted: false, refusal: 'the summary call failed' }], script: [[y(overflowed(PROVIDER_OVERFLOW))], [y(says('never asked'))]] }),
  },
  {
    name: 'provider_overflow_prune_after_failed_fold',
    transitions: ['overflow_recovery', 'overflow_recovery'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'Read' }], seed: readTwelveTimes(), autocompact: [{ wasCompacted: false }, { wasCompacted: false, refusal: 'the summary call failed' }], script: [[y(overflowed(NARROW_OVERFLOW))], [y(says('after the prune'))]] }),
  },
  {
    name: 'provider_overflow_breaker',
    transitions: [],
    terminal: 'rapid_refill_breaker',
    plan: () => ({ seed: history(), autocompact: [{ wasCompacted: false, rapidRefillBreakerTripped: true }], script: [[y(overflowed(PROVIDER_OVERFLOW))], [y(says('never asked'))]] }),
  },
  {
    name: 'provider_overflow_no_history',
    transitions: [],
    terminal: 'prompt_too_long',
    plan: () => ({ script: [[y(overflowed(PROVIDER_OVERFLOW))], [y(says('never asked'))]] }),
  },
  {
    name: 'pause_turn_continues',
    transitions: ['pause_turn_continuation'],
    terminal: 'completed',
    plan: () => ({ tools: [], script: [[y(pauses('Searching…'))], [y(says('The figure is 42.'))]] }),
  },
  {
    name: 'pause_turn_ninth_stands',
    transitions: Array.from({ length: 8 }, () => 'pause_turn_continuation'),
    terminal: 'completed',
    plan: () => ({ tools: [], script: [...Array.from({ length: 9 }, (_, i) => [y(pauses(`pause ${i + 1}`))]), [y(says('never asked'))]] }),
  },
  {
    name: 'pause_turn_at_turn_budget',
    transitions: [],
    terminal: 'max_turns',
    plan: () => ({ tools: [], maxTurns: 1, script: [[y(pauses('Searching…'))], [y(says('never asked'))]] }),
  },
  {
    name: 'reasoning_only_nudged',
    transitions: ['reasoning_only_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(thinks('end_turn'))], [y(says('the reply, said.'))]] }),
  },
  {
    name: 'reasoning_only_twice',
    transitions: ['reasoning_only_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(thinks('end_turn'))], [y(thinks('end_turn'))], [y(says('never asked'))]] }),
  },
  {
    name: 'reasoning_cut_three_times',
    transitions: ['reasoning_only_recovery', 'reasoning_only_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(thinks('max_tokens')), y(outputCut())], [y(thinks('max_tokens')), y(outputCut())], [y(thinks('max_tokens')), y(outputCut())], [y(says('never asked'))]] }),
  },
  {
    name: 'output_ceiling_continues',
    transitions: ['max_output_tokens_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(says('part one of the long reply with its own words. ', 'max_tokens')), y(outputCut())], [y(says('the end.'))]] }),
  },
  {
    name: 'output_ceiling_repeat',
    transitions: ['max_output_tokens_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(outputCut())], [y(outputCut())], [y(says('never asked'))]] }),
  },
  {
    name: 'output_ceiling_budget_spent',
    transitions: [],
    terminal: 'completed',
    plan: () => ({
      before: rig => {
        ;(rig.ctx.options as Row).maxBudgetUsd = 0
      },
      script: [[y(says('part one of the long reply with its own words. ', 'max_tokens')), y(outputCut())], [y(says('never asked'))]],
    }),
  },
  {
    name: 'stream_fault_continues',
    transitions: ['stream_fault_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(says('the first half of the answer', 'stop_sequence')), y(faulted())], [y(says('and the second half.'))]] }),
  },
  {
    name: 'stream_fault_twice',
    transitions: ['stream_fault_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(says('the first half of the answer', 'stop_sequence')), y(faulted())], [y(says('more of it', 'stop_sequence')), y(faulted())], [y(says('never asked'))]] }),
  },
  {
    name: 'empty_reply_retried',
    transitions: ['empty_reply_retry'],
    terminal: 'completed',
    plan: () => ({ script: [[y(empty('empty'))], [y(says('the answer.'))]] }),
  },
  {
    name: 'empty_reply_twice',
    transitions: ['empty_reply_retry'],
    terminal: 'completed',
    plan: () => ({ script: [[y(empty('empty'))], [y(empty('empty'))], [y(says('never asked'))]] }),
  },
  {
    name: 'silence_with_a_screen',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ sessionKind: 'oculus', script: [[y(empty('silence'))], [y(says('never asked'))]] }),
  },
  {
    name: 'silence_left_alone',
    transitions: ['empty_reply_retry'],
    terminal: 'completed',
    plan: () => ({ script: [[y(says(''))], [y(says('the answer.'))]] }),
  },
  {
    name: 'output_cap_reply_stands',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ script: [[y(empty('cap'))], [y(says('never asked'))]] }),
  },
  {
    name: 'tool_call_refused_corrected',
    transitions: ['tool_call_refusal_recovery'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'Bash' }], script: [[y(refused(refusal()))], [y(says('fixed.'))]] }),
  },
  {
    name: 'tool_call_refused_four_times',
    transitions: ['tool_call_refusal_recovery', 'tool_call_refusal_recovery', 'tool_call_refusal_recovery'],
    terminal: 'tool_calls_refused',
    plan: () => ({ tools: [{ name: 'Bash' }], script: [[y(refused(refusal({ id: 'c1' })))], [y(refused(refusal({ id: 'c2' })))], [y(refused(refusal({ id: 'c3' })))], [y(refused(refusal({ id: 'c4' })))], [y(says('never asked'))]] }),
  },
  {
    name: 'refusal_beside_a_tool_call',
    transitions: ['next_turn'],
    terminal: 'completed',
    plan: () => ({ script: [[y(calls('tu_ok', 'EchoTool', { text: 'x' })), y(refused(refusal({ id: 'call_mixed_bad' })))], [y(says('both seen.'))]] }),
  },
  {
    name: 'refused_memory_write_lost',
    transitions: ['tool_call_refusal_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(refused(refusal({ id: 'call_retain', name: 'Retain', argumentsRaw: '{"fact":' })))], [y(says('carrying on without it.'))]] }),
  },
  {
    name: 'cut_tool_call_retried',
    transitions: ['cut_tool_call_recovery'],
    terminal: 'completed',
    plan: () => ({ model: CUT_MODEL, tools: [{ name: 'Bash' }], script: [cutCall(4_096).map(y), [y(says('done.'))]] }),
  },
  {
    name: 'cut_tool_call_at_the_limit',
    transitions: ['tool_call_refusal_recovery'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'Bash' }], script: [cutCall(4_096, MODEL).map(y), [y(says('done.'))]] }),
  },
  {
    name: 'memory_write_refused_four_times',
    transitions: ['tool_call_refusal_recovery', 'tool_call_refusal_recovery', 'tool_call_refusal_recovery'],
    terminal: 'tool_calls_refused',
    plan: () => ({ script: [...['r1', 'r2', 'r3', 'r4'].map(id => [y(refused(refusal({ id, name: 'Retain', argumentsRaw: '{"fact":' })))]), [y(says('never asked'))]] }),
  },
  {
    name: 'chant_with_refused_call',
    transitions: ['tool_call_refusal_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(chantRefused())], [y(says('an honest reply.'))]] }),
  },
  {
    name: 'capped_chant_once',
    transitions: ['chant_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(says(CHANT, 'max_tokens')), y(outputCut())], [y(says('an honest reply.'))]] }),
  },
  {
    name: 'capped_chant_twice_with_a_screen',
    transitions: ['chant_recovery'],
    terminal: 'completed',
    plan: () => ({ sessionKind: 'oculus', script: [[y(says(CHANT, 'max_tokens')), y(outputCut())], [y(says(CHANT, 'max_tokens')), y(outputCut())], [y(says('never asked'))]] }),
  },
  {
    name: 'chant_cut_once',
    transitions: ['chant_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[y(says(CHANT))], [y(says('an honest reply.'))]] }),
  },
  {
    name: 'chant_twice_left_alone',
    transitions: ['chant_recovery'],
    terminal: 'loop_stopped',
    plan: () => ({ script: [[y(says(CHANT))], [y(says(CHANT))], [y(says('never asked'))]] }),
  },
  {
    name: 'chant_twice_with_a_screen',
    transitions: ['chant_recovery'],
    terminal: 'completed',
    plan: () => ({ sessionKind: 'oculus', script: [[y(says(CHANT))], [y(says(CHANT))], [y(says('never asked'))]] }),
  },
  {
    name: 'chant_twice_key_on',
    transitions: ['chant_recovery'],
    terminal: 'loop_stopped',
    plan: () => ({ sessionKind: 'oculus', loopGuard: true, script: [[y(says(CHANT))], [y(says(CHANT))], [y(says('never asked'))]] }),
  },
  {
    name: 'chant_seen_in_the_stream',
    transitions: ['chant_recovery'],
    terminal: 'completed',
    plan: () => ({ script: [[...Array.from({ length: 120 }, () => y(delta(SENTENCE))), y(says(SENTENCE.repeat(120)))], [y(says('an honest reply.'))]] }),
  },
  {
    name: 'turn_budget_closing_reply',
    transitions: ['next_turn'],
    terminal: 'max_turns',
    plan: () => ({ maxTurns: 1, script: [[y(calls('tu_mx', 'EchoTool', { text: 'x' }))], [y(says('CLOSING WORDS: x was echoed; nothing remains.'))]] }),
  },
  {
    name: 'turn_budget_closing_tool_call',
    transitions: ['next_turn'],
    terminal: 'max_turns',
    plan: () => ({ maxTurns: 1, script: [[y(calls('tu_a', 'EchoTool', { text: 'a' }))], [y(calls('tu_b', 'EchoTool', { text: 'b' }))]] }),
  },
  {
    name: 'turn_budget_closing_api_error',
    transitions: ['next_turn'],
    terminal: 'max_turns',
    plan: () => ({ maxTurns: 1, script: [[y(calls('tu_mx', 'EchoTool', { text: 'x' }))], [y(createAssistantAPIErrorMessage({ content: 'API Error: 500 upstream' }))]] }),
  },
  {
    name: 'api_error_reply',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ script: [[y(createAssistantAPIErrorMessage({ content: 'API Error: 500 upstream' }))]] }),
  },
  {
    name: 'announced_step_nudged',
    transitions: ['announced_step_nudge'],
    terminal: 'completed',
    plan: () => ({ script: [[y(says("I'll start by reading the config:"))], [y(says('The config holds two keys.'))]] }),
  },
  {
    name: 'announced_step_twice',
    transitions: ['announced_step_nudge'],
    terminal: 'completed',
    plan: () => ({ script: [[y(says("I'll start by reading the config:"))], [y(says('Next, I will add the subtract function.'))], [y(says('never asked'))]] }),
  },
  {
    name: 'announced_step_before_stop_hook',
    transitions: ['announced_step_nudge', 'stop_hook_blocking'],
    terminal: 'completed',
    plan: () => {
      let judged = 0
      return {
        before: stopGuard('rig-stop-after-announce', async () => (judged++ === 0 ? { hold: true, words: 'RIG-KEEP-WORKING: not done yet' } : { hold: false })),
        script: [[y(says("I'll start by reading the config:"))], [y(says('The config holds two keys.'))], [y(says('final answer'))]],
      }
    },
  },
  {
    name: 'stop_hook_blocks',
    transitions: ['stop_hook_blocking'],
    terminal: 'completed',
    plan: () => {
      let judged = 0
      return {
        before: stopGuard('rig-stop-block', async () => (judged++ === 0 ? { hold: true, words: 'RIG-KEEP-WORKING: not done yet' } : { hold: false })),
        script: [[y(says('first answer'))], [y(says('second answer'))]],
      }
    },
  },
  {
    name: 'stop_hook_prevents',
    transitions: [],
    terminal: 'stop_hook_prevented',
    plan: () => ({ before: hooks({ 'turn.answer': [{ name: 'rig halt', run: `echo '{"stop": "rig halt"}'` }] }), script: [[y(says('answer'))]] }),
  },
  {
    name: 'checkpoint_left_open',
    transitions: ['checkpoint_settle_guard'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'Checkpoint' }], seed: liveCheckpoint(), script: [[y(says('the store lives in sessionStorage.'))], [y(says('settled.'))]] }),
  },
  {
    name: 'checkpoint_then_queued_message',
    transitions: ['checkpoint_settle_guard', 'queued_message'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'Checkpoint' }], agentId: AGENT, querySource: 'agent:custom', appState: crewTask(['read the contract and conform to it']), seed: liveCheckpoint(), script: [[y(says('the store lives in sessionStorage.'))], [y(says('settled.'))], [y(says('it conforms now.'))]] }),
  },
  {
    name: 'queued_message_for_a_crewmate',
    transitions: ['queued_message'],
    terminal: 'completed',
    plan: () => ({ agentId: AGENT, querySource: 'agent:custom', appState: crewTask(['read the contract and conform to it']), script: [[y(says('the note is written.'))], [y(says('it conforms now.'))]] }),
  },
  {
    name: 'blocking_limit_unarmed',
    transitions: [],
    terminal: 'blocking_limit',
    plan: () => ({ env: BLOCKED, querySource: 'side_question', seed: [ask('hello there rig'), fat('previous fat turn', 5_000)], script: [[y(says('never asked'))]] }),
  },
  {
    name: 'blocking_limit_armed_no_history',
    transitions: [],
    terminal: 'blocking_limit',
    plan: () => ({ env: BLOCKED, seed: [ask('hello there rig'), fat('previous fat turn', 5_000)], script: [[y(says('never asked'))]] }),
  },
  {
    name: 'estimate_overflow_fold_lands',
    transitions: ['overflow_recovery'],
    terminal: 'completed',
    plan: () => ({ env: BLOCKED_NO_AUTO_FOLD, seed: [ask('an old question'), fat('an old fat answer', 5_000), ask('hello there rig')], autocompact: [{ wasCompacted: false }, folded(50)], script: [[y(says('after the fold'))]] }),
  },
  {
    name: 'estimate_overflow_fold_fails',
    transitions: ['overflow_recovery'],
    terminal: 'blocking_limit',
    plan: () => ({ env: BLOCKED_NO_AUTO_FOLD, seed: [ask('an old question'), fat('an old fat answer', 5_000), ask('hello there rig')], autocompact: [{ wasCompacted: false }, { wasCompacted: false }], script: [[y(says('never asked'))]] }),
  },
  {
    name: 'rapid_refill_notice',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ autocompact: [{ wasCompacted: false, rapidRefillBreakerTripped: true }], script: [[y(says('the answer beside the notice'))]] }),
  },
  {
    name: 'rapid_refill_breaker_ends',
    transitions: [],
    terminal: 'rapid_refill_breaker',
    plan: () => ({ env: BLOCKED, seed: [ask('an old question'), fat('an old fat answer', 5_000), ask('hello there rig')], autocompact: [{ wasCompacted: false, rapidRefillBreakerTripped: true }], script: [[y(says('never asked'))]] }),
  },
  {
    name: 'compaction_boundary',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ seed: [ask('hello there rig'), fat('old fat turn', 700)], autocompact: [folded()], script: [[y(says('post-compact turn'))]] }),
  },
  {
    name: 'compaction_recomposes',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ recompose: true, seed: [ask('hello there rig'), fat('old fat turn', 700)], autocompact: [folded()], script: [[y(says('post-compact turn'))]] }),
  },
  {
    name: 'compaction_paused_notice',
    transitions: [],
    terminal: 'completed',
    plan: () => ({ autocompact: [{ wasCompacted: false, paused: true, refusal: 'folding is paused for this run' }], script: [[y(says('the answer beside the notice'))]] }),
  },
  {
    name: 'tool_changes_the_context',
    transitions: ['next_turn', 'next_turn'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'MarkTool', serial: true, marks: true }], script: [[y(calls('tu_m1', 'MarkTool', { text: 'one' }))], [y(calls('tu_m2', 'MarkTool', { text: 'two' }))], [y(says('marked twice.'))]] }),
  },
  {
    name: 'tools_refreshed_between_turns',
    transitions: ['next_turn'],
    terminal: 'completed',
    plan: () => ({ refreshedTools: [{ name: 'LateTool' }], script: [[y(calls('tu_rf', 'EchoTool', { text: 'x' }))], [y(says('one more tool now.'))]] }),
  },
  {
    name: 'rewind_settles',
    transitions: ['next_turn'],
    terminal: 'completed',
    plan: () => ({ tools: [{ name: 'Checkpoint' }, { name: 'Rewind' }], seed: liveCheckpoint(), script: [[y(calls('rw_1', 'Rewind', { report: 'the store lives in sessionStorage/' }))], [y(says('back at the checkpoint.'))]] }),
  },
  {
    name: 'abort_mid_tool',
    transitions: [],
    terminal: 'aborted_tools',
    plan: () => ({ tools: [{ name: 'AbortTool', result: 'finished-during-abort', onCall: rig => rig.abortController.abort() }], script: [[y(calls('tu_mt', 'AbortTool', {}))]] }),
  },
  {
    name: 'abort_mid_tool_at_turn_budget',
    transitions: [],
    terminal: 'aborted_tools',
    plan: () => ({ maxTurns: 1, tools: [{ name: 'AbortTool', result: 'finished-during-abort', onCall: rig => rig.abortController.abort() }], script: [[y(calls('tu_mt2', 'AbortTool', {}))]] }),
  },
  {
    name: 'tool_hook_stops',
    transitions: [],
    terminal: 'hook_stopped',
    plan: () => ({ before: hooks({ 'tool.before': [{ name: 'rig tool halt', match: 'EchoTool', run: `echo '{"stop": "rig tool halt"}'` }] }), script: [[y(calls('tu_hs', 'EchoTool', { text: 'x' }))]] }),
  },
  {
    name: 'tool_loop_stopped',
    transitions: ['next_turn', 'next_turn'],
    terminal: 'loop_stopped',
    plan: () => ({
      tools: [{ name: 'Bash', serial: true, result: 'FAIL: bun test exited 1' }],
      script: [
        [y(calls('failure_1', 'Bash', { command: 'bun test', description: 'Run the tests' }))],
        [y(calls('failure_2', 'Bash', { command: 'bun test', description: 'Run the tests' }))],
        [y(calls('failure_3', 'Bash', { command: 'bun test', description: 'Run the tests' }))],
        [y(says('never asked'))],
      ],
    }),
  },
  {
    name: 'paused_thought_without_words',
    transitions: ['pause_turn_continuation'],
    terminal: 'completed',
    plan: () => ({ tools: [], script: [[y(thinks('pause_turn'))], [y(says('the reply, said.'))]] }),
  },
  {
    name: 'turn_budget_closing_chant',
    transitions: ['next_turn', 'chant_recovery'],
    terminal: 'max_turns',
    plan: () => ({ maxTurns: 1, script: [[y(calls('tu_mx', 'EchoTool', { text: 'x' }))], [y(says(CHANT))], [y(says('CLOSING WORDS: nothing remains.'))]] }),
  },
  {
    name: 'paused_reply_then_overflow',
    transitions: ['overflow_recovery'],
    terminal: 'completed',
    plan: () => ({ tools: [], seed: history(), autocompact: [{ wasCompacted: false }, folded()], script: [[y(pauses('Searching…')), y(overflowed(PROVIDER_OVERFLOW))], [y(says('after the fold'))]] }),
  },
  {
    name: 'stream_fault_stamped_with_an_overflow',
    transitions: ['overflow_recovery'],
    terminal: 'completed',
    plan: () => ({ seed: history(), autocompact: [{ wasCompacted: false }, folded()], script: [[y(says('the first half of the answer', 'stop_sequence')), y(faultedPastTheWindow())], [y(says('after the fold'))]] }),
  },
]
