;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const TMP = tmpdir()
const HOME = mkdtempSync(join(TMP, 'nested-turn-'))
const REAL_HOME = realpathSync(HOME)
const asName = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')
const PLACES: Array<[string, string]> = [
  [REAL_HOME, '<home>'],
  [HOME, '<home>'],
  [asName(REAL_HOME), '<home as a name>'],
  [asName(HOME), '<home as a name>'],
  [realpathSync(TMP), '<tmp>'],
  [TMP, '<tmp>'],
]
const CWD = join(HOME, 'project')
mkdirSync(CWD)
process.env.MERCURY_CONFIG_DIR = join(HOME, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-nested-turn-not-a-real-key'
for (const name of [
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'NODE_ENV',
]) {
  delete process.env[name]
}
globalThis.fetch = Object.assign(async () => {
  throw new Error('the network is not part of this rig')
}, globalThis.fetch)

type Row = Record<string, unknown>

type ModelStep = { kind: 'yield'; value: unknown } | { kind: 'do'; fn: () => void } | { kind: 'throw'; error: unknown }

type Tape = {
  log: unknown[]
  mask: (value: unknown) => unknown
  script: ModelStep[][]
  turns: number
  modelCalls: number
  ends: string[]
}

type NestedScenario = {
  name: string
  starter: 'runAgent' | 'runForkedAgent' | 'runCrewmateHook'
  ends: string[]
  outcome: string
  run: (tape: Tape) => Promise<unknown>
}

export type NestedRecording = {
  name: string
  starter: string
  turns: number
  modelCalls: number
  ends: string[]
  outcome: unknown
  log: unknown[]
}

const CLOCK_KEYS = new Set(['waitedMs', 'elapsedMs', 'durationMs', 'sinceMs', 'startTime', 'sentAt', 'atMs', 'ttftMs', 'totalDurationMs'])
const LONG_TEXT = 2_000
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g
const DAY = /\d{4}-\d{2}-\d{2}/g
const AGENT_ID = /a(?:[a-z_]+-)?[0-9a-f]{16}(?![0-9a-f])/g
const PROJECT = /(\/config\/projects\/)[^/\s]+/g

function masker(): (value: unknown) => unknown {
  const ids = new Map<string, string>()
  const words = (raw: string): string => {
    const masked = PLACES.reduce((text, [place, name]) => text.split(place).join(name), raw)
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
      .replace(DAY, '<day>')
      .replace(AGENT_ID, '<agent>')
      .replace(PROJECT, '$1<project>')
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

const { query } = await import('../../src/engine/turnDoor.ts')
const { productionDeps } = await import('../../src/engine/turn-entry/turnLoopDeps.ts')

let tape: Tape | undefined

const namesOf = (tools: unknown): string[] => (Array.isArray(tools) ? tools.map(tool => String((tool as Row).name)) : [])
const endOf = (terminal: unknown): string => String((terminal as { reason?: unknown } | null | undefined)?.reason ?? JSON.stringify(terminal))

function scriptedDeps(on: Tape, turn: number): Row {
  return {
    async *callModel(request: Row) {
      const call = ++on.modelCalls
      const options = (request.options ?? {}) as Row
      on.log.push(on.mask({ lane: 'model', turn, call, model: options.model, querySource: options.querySource, tools: namesOf(request.tools), messages: request.messages }))
      for (const step of on.script[call - 1] ?? [{ kind: 'yield', value: says('the script of this rig ran out.') } as ModelStep]) {
        if (step.kind === 'throw') throw step.error
        if (step.kind === 'do') step.fn()
        else yield step.value
      }
    },
    autocompact: async () => ({ wasCompacted: false }),
    microcompact: async (messages: unknown[]) => ({ messages }),
  }
}

function startTurn(params: Row): AsyncGenerator<unknown, unknown> {
  const on = tape
  if (on === undefined) throw new Error('a nested turn was started outside a scenario of this rig')
  const turn = ++on.turns
  const context = (params.toolUseContext ?? {}) as Row
  on.log.push(
    on.mask({
      lane: 'door',
      turn,
      started: {
        querySource: params.querySource,
        maxTurns: params.maxTurns,
        maxOutputTokensOverride: params.maxOutputTokensOverride,
        skipCacheWrite: params.skipCacheWrite,
        agentId: context.agentId,
        agentKind: context.agentKind,
        tools: namesOf((context.options as Row | undefined)?.tools),
        engineModel: (context.options as Row | undefined)?.engineModel,
        systemPrompt: params.systemPrompt,
        userContext: params.userContext,
        systemContext: params.systemContext,
        messages: params.messages,
      },
    }),
  )
  const deps = { ...((params.deps as Row | undefined) ?? (productionDeps() as unknown as Row)), ...scriptedDeps(on, turn) }
  const inner = query({ ...params, deps } as never) as AsyncGenerator<unknown, unknown>
  return (async function* () {
    let settled = false
    try {
      for (;;) {
        const next = await inner.next()
        if (next.done) {
          settled = true
          on.ends.push(endOf(next.value))
          on.log.push(on.mask({ lane: 'door', turn, terminal: next.value }))
          return next.value
        }
        on.log.push(on.mask({ lane: 'door', turn, yielded: next.value }))
        yield next.value
      }
    } catch (error) {
      settled = true
      on.ends.push('threw')
      on.log.push(on.mask({ lane: 'door', turn, threw: error }))
      throw error
    } finally {
      if (!settled) {
        on.ends.push('left before its terminal')
        on.log.push({ lane: 'door', turn, left: 'before its terminal' })
        await inner.return(undefined as never).catch(() => {})
      }
    }
  })()
}

const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setOriginalCwd(CWD)
bootstrap.setCwdState(CWD)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { setPathTrusted } = await import('../../src/platform/config/trust.ts')
setPathTrusted(CWD)
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { flushSessionStorage } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { hookAnswerSchema } = await import('../../src/integrations/event-hooks/contract.ts')
const { SYNTHETIC_OUTPUT_TOOL_NAME } = await import('../../src/tools/kit/names/syntheticOutput.ts')
const { runAgent } = await import('../../src/tools/crewmate/runCrewmate.ts')
const { runForkedAgent } = await import('../../src/crew/agents/forkedAgent.ts')
const { runCrewmateHook } = await import('../../src/integrations/event-hook-runners/crewmateRunner.ts')

const MODEL = 'claude-opus-4-8'
const ECHO = 'EchoTool'

type AssistantRow = ReturnType<typeof createAssistantMessage>
const y = (value: unknown): ModelStep => ({ kind: 'yield', value })
const says = (words: string, stop = 'end_turn'): AssistantRow => {
  const row = createAssistantMessage({ content: words })
  row.message.stop_reason = stop as never
  return row
}
const calls = (id: string, name: string, input: Row): AssistantRow => {
  const row = createAssistantMessage({ content: [{ type: 'tool_use', id, name, input }] as never })
  row.message.stop_reason = 'tool_use' as never
  return row
}
const streamed = (event: Row): unknown => ({ type: 'stream_event', event })
const usage = (input: number, output: number): Row => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })

function echoTool(on: Tape): never {
  return {
    name: ECHO,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => ECHO,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Row, ctx: Row) {
      on.log.push(on.mask({ lane: 'tool', tool: ECHO, input, agentId: ctx.agentId }))
      return { data: `echo:${String(input?.text ?? '')}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}

const allow = (async (_tool: unknown, input: Row) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never

function parentContext(tools: unknown[], messages: unknown[] = []): Row {
  let state = { ...getDefaultAppState(), effortValue: 'high' } as Row
  const set = (update: (prev: never) => never): void => {
    state = update(state as never)
  }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools,
      engineModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => state,
    setAppState: set,
    setAppStateForTasks: set,
    messages,
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs() {},
    setResponseLength() {},
    updateFileHistoryState() {},
    updateAttributionState() {},
    startTurn,
  }
}

async function crewmate(on: Tape, maxTurns: number | undefined): Promise<unknown> {
  const tools = [echoTool(on)]
  const stream = runAgent({
    agentDefinition: { agentType: 'mercury-crew', whenToUse: 'rig', source: 'projectSettings', getSystemPrompt: () => 'Run the rig.' } as never,
    promptMessages: [createUserMessage({ content: 'Echo once, then say you are done.' })],
    toolUseContext: parentContext(tools) as never,
    canUseTool: allow,
    isAsync: true,
    canShowPermissionPrompts: true,
    querySource: 'agent:custom:nested-rig' as never,
    availableTools: tools as never,
    useExactTools: true,
    model: MODEL,
    override: { agentId: `rig-${crypto.randomUUID()}` as never },
    description: 'nested rig',
    cwd: CWD,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    onQueryProgress: (message: unknown) => {
      on.log.push(on.mask({ lane: 'outer', progress: (message as Row).type }))
    },
  } as never)
  let step = await stream.next()
  while (!step.done) {
    on.log.push(on.mask({ lane: 'outer', yielded: step.value }))
    step = await stream.next()
  }
  return { returned: step.value }
}

async function fork(on: Tape, maxTurns: number): Promise<unknown> {
  const tools = [echoTool(on)]
  const history = [createUserMessage({ content: 'an old question' }), says('an old answer')]
  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: 'Summarise this rig.' })],
    cacheSafeParams: {
      systemPrompt: asSystemPrompt(['rig']),
      userContext: {},
      systemContext: {},
      toolUseContext: parentContext(tools, history) as never,
      forkContextMessages: history as never,
    },
    canUseTool: allow,
    querySource: 'compact' as never,
    forkLabel: 'compact',
    maxTurns,
    onMessage: (message: unknown) => {
      on.log.push(on.mask({ lane: 'outer', onMessage: message }))
    },
    onStreamEvent: (event: unknown) => {
      on.log.push(on.mask({ lane: 'outer', onStreamEvent: event }))
    },
  } as never)
  return { returned: result }
}

async function hookCrewmate(on: Tape, signal: AbortSignal): Promise<unknown> {
  const tools = [echoTool(on)]
  const end = await runCrewmateHook({
    text: 'Check the rig.',
    name: 'rig-crewmate',
    event: 'turn.answer',
    payloadJson: '{"turn_id":"t1","answer":"hello","again":false}',
    answerSchema: hookAnswerSchema('turn.answer'),
    timeoutMs: 30_000,
    signal,
    toolUseContext: parentContext(tools) as never,
  } as never)
  return { returned: end }
}

const spoken = (input: number, output: number): ModelStep[] => [
  y(streamed({ type: 'message_start', message: { usage: usage(input, 0) } })),
  y(streamed({ type: 'message_delta', usage: usage(input, output) })),
  y(streamed({ type: 'message_stop' })),
]

export const NESTED: NestedScenario[] = [
  {
    name: 'crewmate_runs_a_tool_and_answers',
    starter: 'runAgent',
    ends: ['completed'],
    outcome: 'returned',
    run: on => {
      on.script = [[y(calls('tu_crew_1', ECHO, { text: 'one' }))], [y(says('the crewmate is done.'))]]
      return crewmate(on, undefined)
    },
  },
  {
    name: 'crewmate_stopped_by_its_turn_budget',
    starter: 'runAgent',
    ends: ['left before its terminal'],
    outcome: 'returned',
    run: on => {
      on.script = [[y(calls('tu_crew_1', ECHO, { text: 'one' }))], [y(calls('tu_crew_2', ECHO, { text: 'two' }))], [y(calls('tu_crew_3', ECHO, { text: 'three' }))]]
      return crewmate(on, 1)
    },
  },
  {
    name: 'forked_agent_runs_a_tool_and_answers',
    starter: 'runForkedAgent',
    ends: ['completed'],
    outcome: 'returned',
    run: on => {
      on.script = [
        [...spoken(40, 7), y(calls('tu_fork_1', ECHO, { text: 'one' }))],
        [...spoken(55, 9), y(says('the rig, summarised.'))],
      ]
      return fork(on, 3)
    },
  },
  {
    name: 'forked_agent_stopped_by_its_turn_budget',
    starter: 'runForkedAgent',
    ends: ['max_turns'],
    outcome: 'returned',
    run: on => {
      on.script = [[...spoken(40, 7), y(calls('tu_fork_1', ECHO, { text: 'one' }))], [...spoken(55, 9), y(calls('tu_fork_2', ECHO, { text: 'two' }))], [y(calls('tu_fork_3', ECHO, { text: 'three' }))]]
      return fork(on, 1)
    },
  },
  {
    name: 'hook_crewmate_reads_and_answers',
    starter: 'runCrewmateHook',
    ends: ['left before its terminal'],
    outcome: 'answered',
    run: on => {
      on.script = [[y(calls('tu_hook_1', ECHO, { text: 'one' }))], [y(calls('tu_hook_2', SYNTHETIC_OUTPUT_TOOL_NAME, {}))]]
      return hookCrewmate(on, new AbortController().signal)
    },
  },
  {
    name: 'hook_crewmate_cancelled_by_its_run',
    starter: 'runCrewmateHook',
    ends: ['aborted_streaming'],
    outcome: 'cancelled',
    run: on => {
      const outer = new AbortController()
      on.script = [[y(calls('tu_hook_1', ECHO, { text: 'one' }))], [y(streamed({ type: 'ping' })), { kind: 'do', fn: () => outer.abort() }]]
      return hookCrewmate(on, outer.signal)
    },
  },
]

export async function record(scenario: NestedScenario): Promise<NestedRecording> {
  const log: unknown[] = []
  const on: Tape = { log, mask: masker(), script: [], turns: 0, modelCalls: 0, ends: [] }
  bootstrap.regenerateSessionId()
  tape = on
  let outcome: unknown
  try {
    outcome = await scenario.run(on)
  } catch (error) {
    outcome = { thrown: error }
  }
  await flushSessionStorage().catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 5))
  tape = undefined
  return { name: scenario.name, starter: scenario.starter, turns: on.turns, modelCalls: on.modelCalls, ends: on.ends, outcome: on.mask(outcome), log }
}
