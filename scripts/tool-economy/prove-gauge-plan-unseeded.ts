#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { z } = await import('zod')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { planToolPayload, planToolPayloadUnseeded, toolRosterLatchFor, clearToolRosterLatches, armToolRosterRestore, clearToolRosterRestore, conversationRosterKey } = await import('../../src/services/providers/toolEconomy.ts')
const { rosterOwnerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const { runEventCore } = await import('../../src/run-core/turn-machine.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

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
  const turnMachine = readFileSync(new URL('../../src/run-core/turn-machine.ts', import.meta.url), 'utf8')
  const warm = readFileSync(new URL('../../src/services/providers/local/localWarm.ts', import.meta.url), 'utf8')
  check('the request gauge plans through planToolPayloadUnseeded and nothing else in the turn machine plans', /toolsOnTheWire\(await planToolPayloadUnseeded\(\{[\s\S]{0,600}source: 'gauge'/.test(turnMachine) && !/\bplanToolPayload\(/.test(turnMachine))
  check('the local warm plans through the same owner, no copy of the latch check', warm.includes('planToolPayloadUnseeded({') && !warm.includes('toolRosterLatchFor'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
