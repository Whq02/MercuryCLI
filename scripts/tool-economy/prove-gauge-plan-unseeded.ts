#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_MODEL', 'MERCURY_HOME']) delete process.env[k]
const scratch = mkdtempSync(join(tmpdir(), 'gauge-plan-unseeded-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const GAUGE_PLAN_WHERE = 'change planToolPayloadUnseeded and planToolPayload in src/models/roads/toolEconomy.ts (the unseeded plan reads a latch and never writes one; the lane plan seeds the latch and spends the restored record), or the turn machine in src/engine/loop/turn-machine.ts'
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail.includes('src/') ? '' : `${GAUGE_PLAN_WHERE}${detail ? ' | ' : ''}`}${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { z } = await import('zod')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { ToolSearchTool } = await import('../../src/tools/tool-search/ToolSearchTool.ts')
const { planToolPayload, planToolPayloadUnseeded, toolsOnTheWire, toolRosterLatchFor, clearToolRosterLatches, armToolRosterRestore, clearToolRosterRestore, conversationRosterKey } = await import('../../src/models/roads/toolEconomy.ts')
const { rosterOwnerFromToolUseContext } = await import('../../src/engine/run-owner/resolveOwner.ts')
const { runEventCore } = await import('../../src/engine/loop/turn-machine.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
type Tool = import('../../src/tools/kit/tool.ts').Tool
type Message = import('../../src/engine/message-shapes/message.ts').Message

function fixtureTool(name: string, flags: { shouldDefer?: boolean } = {}): Tool {
  return {
    name,
    ...flags,
    searchHint: `${name.toLowerCase()} fixture work`,
    prompt: async () => `${name}: a fixture tool`,
    description: async () => `${name} fixture`,
    inputSchema: z.object({ path: z.string() }),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    userFacingName: () => name,
    call: async () => ({ data: 'fixture' }),
  } as unknown as Tool
}

const permissionContext = getEmptyToolPermissionContext()
const MODEL = 'claude-sonnet-5'
const pool: Tool[] = [fixtureTool('Plain'), ToolSearchTool as never, fixtureTool('F', { shouldDefer: true })]
const restoredMarks = [
  { name: 'Plain', deferred: false },
  { name: 'ToolSearch', deferred: false },
  { name: 'RetiredTool', deferred: false },
  { name: 'F', deferred: true },
]
const laneInput = (messages: Message[], latchKey: string) => ({ model: MODEL, tools: pool, messages, latchKey, getToolPermissionContext: async () => permissionContext, agents: [], source: 'query' as const })

section('§1 the planner alone: an unseeded plan reads a latch that exists and never writes one; the lane\'s first plan still seeds the restore and names the retired tool')
{
  const first = createUserMessage({ content: 'begin' }) as Message
  const messages = [first]
  clearToolRosterLatches()
  clearToolRosterRestore()
  armToolRosterRestore({ key: conversationRosterKey('owner-a', messages, MODEL), enabled: true, marks: restoredMarks })
  const gauge = await planToolPayloadUnseeded({ ...laneInput(messages, 'owner-a'), source: 'gauge' })
  check('the gauge-style plan under the conversation key seeds no latch (the restore stays armed for the lane)', toolRosterLatchFor('owner-a', messages, MODEL) === undefined && gauge.restoredMissingTools.length === 0, `latch=${String(toolRosterLatchFor('owner-a', messages, MODEL) !== undefined)} missing=${gauge.restoredMissingTools.join(',')}`)
  const lane = await planToolPayload(laneInput(messages, 'owner-a'))
  check('the lane\'s plan, after the gauge\'s, is the conversation\'s first: it seeds the latch and returns the retired bound tool (R3)', lane.restoredMissingTools.length === 1 && lane.restoredMissingTools[0] === 'RetiredTool' && toolRosterLatchFor('owner-a', messages, MODEL) !== undefined, lane.restoredMissingTools.join(',') || '(none)')
  const gaugeAfter = await planToolPayloadUnseeded({ ...laneInput(messages, 'owner-a'), source: 'gauge' })
  check('once the lane has latched, the unseeded plan reads that latch: the same roster, in the same order, deferral as taken', gaugeAfter.roster.map(t => t.name).join(',') === lane.roster.map(t => t.name).join(',') && gaugeAfter.enabled === lane.enabled && [...gaugeAfter.deferredNames].join(',') === [...lane.deferredNames].join(','), `${gaugeAfter.roster.map(t => t.name).join(',')} vs ${lane.roster.map(t => t.name).join(',')}`)
  check('a later plan under the key returns no missing tool (the declaration is made once)', gaugeAfter.restoredMissingTools.length === 0 && (await planToolPayload(laneInput(messages, 'owner-a'))).restoredMissingTools.length === 0)

  clearToolRosterLatches()
  clearToolRosterRestore()
  const fresh = [createUserMessage({ content: 'begin again' }) as Message]
  const unlatched = await planToolPayloadUnseeded({ ...laneInput(fresh, 'owner-b'), source: 'gauge' })
  const latchedFirst = await planToolPayload(laneInput(fresh, 'owner-b'))
  check('with no record armed, the unseeded plan and the lane\'s first plan read the same roster from the same live gates (the gauge\'s numbers do not move)', unlatched.roster.map(t => t.name).join(',') === latchedFirst.roster.map(t => t.name).join(',') && unlatched.enabled === latchedFirst.enabled, `${unlatched.roster.map(t => t.name).join(',')} vs ${latchedFirst.roster.map(t => t.name).join(',')}`)
  clearToolRosterLatches()
}

section('§2 the real turn machine: the request gauge plans before the model is called; the lane\'s plan inside the call still reads the restored record\'s missing tool')
{
  clearToolRosterLatches()
  clearToolRosterRestore()
  const first = createUserMessage({ content: 'resume: read the plan' }) as Message
  let state = getDefaultAppState()
  const context = {
    abortController: new AbortController(),
    options: { commands: [], tools: pool, engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state,
    setAppState: (f: (prior: typeof state) => typeof state) => { state = f(state) },
    messages: [], readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
  }
  const ownerKey = String(rosterOwnerFromToolUseContext(context as never))
  armToolRosterRestore({ key: conversationRosterKey(ownerKey, [first], MODEL), enabled: true, marks: restoredMarks })
  let latchBeforeCall: boolean | null = null
  let laneMissing: readonly string[] | null = null
  const machine = runEventCore({
    messages: [first], systemPrompt: ['fixture'], userContext: {}, systemContext: {}, querySource: 'sdk', toolUseContext: context,
    canUseTool: async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    deps: {
      async *callModel(params: { messages: Message[] }) {
        latchBeforeCall = toolRosterLatchFor(ownerKey, params.messages, MODEL) !== undefined
        const plan = await planToolPayload(laneInput(params.messages, ownerKey))
        laneMissing = plan.restoredMissingTools
        const message = createAssistantMessage({ content: 'done' })
        message.message.stop_reason = 'end_turn'
        yield message
      },
      autocompact: async () => ({ wasCompacted: false }), microcompact: async (messages: unknown[]) => ({ messages }), uuid: () => crypto.randomUUID(),
    },
  } as never, [])
  for await (const _event of machine) {}
  check('the gauge ran before the call and left the conversation unlatched', latchBeforeCall === false, String(latchBeforeCall))
  check('the lane\'s plan inside the call is the conversation\'s first: it returns the retired bound tool for the R3 declaration', laneMissing !== null && laneMissing.length === 1 && laneMissing[0] === 'RetiredTool', laneMissing === null ? 'the model was not called' : laneMissing.join(',') || '(none)')
  clearToolRosterLatches()
  clearToolRosterRestore()
}

section('§3 the owners: the gauge and the local warm read the one unseeded planner; the lanes plan latched')
{
  const usage = { input_tokens: 4_000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  async function turnWhoseLaneNeverPlans(tools: Tool[], opts: { toolRound: boolean; restore: boolean }) {
    clearToolRosterLatches()
    clearToolRosterRestore()
    const first = createUserMessage({ content: 'resume: read the plan' }) as Message
    let state = getDefaultAppState()
    const context = {
      abortController: new AbortController(),
      options: { commands: [], tools, engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => state,
      setAppState: (f: (prior: typeof state) => typeof state) => { state = f(state) },
      messages: [], readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
    }
    const ownerKey = String(rosterOwnerFromToolUseContext(context as never))
    if (opts.restore) armToolRosterRestore({ key: conversationRosterKey(ownerKey, [first], MODEL), enabled: true, marks: restoredMarks })
    const latchedAtCall: boolean[] = []
    const replies: Array<{ contextGauge?: { fixed?: { digest?: string } } }> = []
    const machine = runEventCore({
      messages: [first], systemPrompt: ['fixture'], userContext: {}, systemContext: {}, querySource: 'sdk', toolUseContext: context,
      canUseTool: async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
      deps: {
        async *callModel(params: { messages: Message[] }) {
          latchedAtCall.push(toolRosterLatchFor(ownerKey, params.messages, MODEL) !== undefined)
          const calling = opts.toolRound && latchedAtCall.length === 1
          const message = createAssistantMessage({ content: calling ? ([{ type: 'tool_use', id: 'toolu_plain', name: 'Plain', input: { path: '/x' } }] as never) : 'done', usage: usage as never })
          message.message.stop_reason = calling ? 'tool_use' : 'end_turn'
          replies.push(message as never)
          yield message
        },
        autocompact: async () => ({ wasCompacted: false }), microcompact: async (messages: unknown[]) => ({ messages }), uuid: () => crypto.randomUUID(),
      },
    } as never, [])
    let step = await machine.next()
    while (!step.done) step = await machine.next()
    return {
      first,
      ownerKey,
      ended: String((step.value as { reason?: unknown }).reason),
      latchedAtCall: latchedAtCall.join(','),
      latchedAfter: toolRosterLatchFor(ownerKey, [first], MODEL) !== undefined,
      fixed: replies.map(reply => reply.contextGauge?.fixed?.digest?.slice(0, 12) ?? 'no gauge').join(','),
    }
  }
  const plannedFor = async (tools: Tool[]): Promise<string> =>
    toolsOnTheWire(await planToolPayloadUnseeded({ ...laneInput([createUserMessage({ content: 'resume: read the plan' }) as Message], 'owner-of-no-turn'), tools, source: 'gauge' })).map(tool => tool.name).join(',')
  const plain = fixtureTool('Plain')
  const pools: Array<[string, Tool[]]> = [['Plain alone', [plain]], ['Plain beside ToolSearch', [plain, ToolSearchTool as never]], ['Plain, ToolSearch and a deferring F', pool]]
  const sized: Array<{ pool: string; planned: string; fixed: string }> = []
  for (const [name, tools] of pools) sized.push({ pool: name, planned: await plannedFor(tools), fixed: (await turnWhoseLaneNeverPlans(tools, { toolRound: false, restore: false })).fixed })
  const [alone, beside, deferring] = sized as [(typeof sized)[number], (typeof sized)[number], (typeof sized)[number]]
  check(
    'the request gauge plans through planToolPayloadUnseeded: a pool the planner plans as another gives the request the same fixed part, and a pool it plans otherwise gives another',
    beside.planned === alone.planned && deferring.planned !== alone.planned && alone.fixed !== 'no gauge' && deferring.fixed !== 'no gauge' && beside.fixed === alone.fixed && deferring.fixed !== alone.fixed,
    `makeRequest (src/engine/loop/turn/makeRequest.ts) must size the request's fixed part from toolsOnTheWire(planToolPayloadUnseeded({ …, source: 'gauge' })), never from the pool it is handed; the planner's roster and the fixed part the reply was stamped with read ${JSON.stringify(sized)}`,
  )
  const runnable = { ...plain, mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }) } as unknown as Tool
  const round = await turnWhoseLaneNeverPlans([runnable, ToolSearchTool as never, fixtureTool('F', { shouldDefer: true })], { toolRound: true, restore: true })
  const laneFirst = (await planToolPayload(laneInput([round.first], round.ownerKey))).restoredMissingTools.join(',') || '(none)'
  check(
    'nothing else in the turn machine plans: over a run of two model calls and a tool round whose lane never plans, the conversation stays unlatched and the restored record unspent, so the lane\'s first plan after it still names the retired tool',
    round.ended === 'completed' && round.latchedAtCall === 'false,false' && round.latchedAfter === false && laneFirst === 'RetiredTool',
    `no step under src/engine/loop/turn/ may plan with a latch key: planToolPayload seeds the conversation's roster and spends the restored record, and the gauge's plan is the unseeded one; the run ended ${round.ended}, the latch read [${round.latchedAtCall}] at its model calls and ${String(round.latchedAfter)} after it, and the lane's first plan after it names ${laneFirst}`,
  )
  clearToolRosterLatches()
  clearToolRosterRestore()
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
