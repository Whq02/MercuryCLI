#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_MODEL', 'MERCURY_HOME']) delete process.env[k]
const scratch = mkdtempSync(join(tmpdir(), 'roster-refresh-build-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0-proof' }

let failures = 0
let count = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  count++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const economy = await import('../../src/services/providers/toolEconomy.ts')
const { restoreBoundPrefixFromMessages } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const ledger = await import('../../src/services/providers/anthropic/prefixLedger.ts')
const { prefixLedgerPath } = await import('../../src/services/providers/anthropic/prefixRecordStore.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

const tool = (name: string, over: Record<string, unknown> = {}): Tool => ({ name, searchHint: `${name.toLowerCase()} fixture`, description: async () => name, prompt: async () => name, inputSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) } as never, inputJSONSchema: { type: 'object', properties: { text: { type: 'string' } } }, call: async () => ({ data: null }), ...over } as unknown as Tool)
const RETIRED = 'RetiredDispatch'
const owner = String(processMainOwner())
const first = createUserMessage({ content: 'the session that began on the earlier build' }) as unknown as Message
const model = 'claude-opus-4-8'
const retiredDefinition = JSON.stringify({ name: RETIRED, description: 'the retired dispatch tool', input_schema: { type: 'object' } })
const definitionOf = (name: string): string => JSON.stringify({ name, description: name, input_schema: { type: 'object', properties: { text: { type: 'string' } } } })

function recordFromEarlierBuild(roster: Array<{ name: string; deferred: boolean; definition?: string }>): Message[] {
  const key = economy.conversationRosterKey(owner, [first], model)
  const saved = createAttachmentMessage({ type: 'bound_prefix', boundKey: key, rosterEnabled: true, roster, sections: [], systemContext: {} } as never) as unknown as Message
  return [first, saved]
}
function writeLedger(build: string | undefined): void {
  const path = prefixLedgerPath()
  mkdirSync(dirname(path), { recursive: true })
  const key = economy.conversationRosterKey(owner, [first], model)
  writeFileSync(path, JSON.stringify({ version: 1, owner, ...(build !== undefined ? { build } : {}), record: { key, whole: 'x', system: [], tools: [], messages: [], wireMessageIds: [], dropped: [] }, drops: null }))
}
async function planAfterRestore(messages: Message[], livePool: Tool[]): Promise<Awaited<ReturnType<typeof economy.planToolPayload>>> {
  economy.clearToolRosterLatches()
  economy.clearToolRosterRestore()
  clearToolSchemaCache()
  ledger.resetPrefixLedger()
  restoreBoundPrefixFromMessages(messages, { rosterOnly: true })
  return economy.planToolPayload({ model, tools: livePool, messages, latchKey: owner, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [] })
}
const names = (plan: { roster: ReadonlyArray<{ name: string }> }): string[] => plan.roster.map(t => t.name)

try {
  section('§1 a session resumed on a NEW build replays the recorded roster byte for byte: the bound tool this build retired rides as its recorded stub, and the new tool takes the joiner road (the Heroes 03:46 restart dropped 66 thinking blocks here)')
  {
    writeLedger('1.0.0-beta.33')
    const record = recordFromEarlierBuild([{ name: 'Bash', deferred: false, definition: definitionOf('Bash') }, { name: 'Read', deferred: false, definition: definitionOf('Read') }, { name: RETIRED, deferred: false, definition: retiredDefinition }, { name: 'Browser', deferred: true, definition: definitionOf('Browser') }])
    const plan = await planAfterRestore(record, [tool('Bash'), tool('Read'), tool('Crewmate'), tool('Browser', { shouldDefer: true }), tool('WebFetch', { shouldDefer: true })])
    check('the roster opens with the recorded names in the recorded order', j(names(plan).slice(0, 4)) === j(['Bash', 'Read', RETIRED, 'Browser']), j(names(plan)))
    check('the retired bound tool rides as its recorded stub (its definition re-sends; a call refuses as an unknown tool)', names(plan).includes(RETIRED) && plan.restoredMissingTools.length === 0, j(plan.restoredMissingTools))
    check('a new deferrable tool joins at the END, deferred — an unreferenced deferred tool is outside the bound prefix', names(plan).at(-1) === 'WebFetch' && plan.deferredNames.has('WebFetch'), j(names(plan)))
    check('a new tool the roster would list in full is held for the lawful boundary, never spliced into the bound prefix', !names(plan).includes('Crewmate') && economy.heldToolsAtLastPlan(owner, record).includes('Crewmate'), j(economy.heldToolsAtLastPlan(owner, record)))
    const bash = await toolToAPISchema(plan.roster.find(t => t.name === 'Bash')!, { getToolPermissionContext: async () => getEmptyToolPermissionContext(), tools: plan.roster, agents: [], model, conversationKey: plan.conversationKey, bound: plan.isBound('Bash') })
    check('a bound tool goes out with its RECORDED definition even though this build renders it differently', j(bash) === definitionOf('Bash'), j(bash))
  }
  section('§2 the same build respawned (a daemon respawn, a resume): the recorded roster is replayed as first sent')
  {
    writeLedger('1.0.0-proof')
    const record = recordFromEarlierBuild([{ name: 'Bash', deferred: false, definition: definitionOf('Bash') }, { name: 'Read', deferred: false, definition: definitionOf('Read') }, { name: RETIRED, deferred: false, definition: retiredDefinition }])
    const plan = await planAfterRestore(record, [tool('Bash'), tool('Read'), tool('Crewmate')])
    check('the roster is the record: the retired name rides as its recorded stub and the joiner waits for the lawful boundary', names(plan).includes(RETIRED) && !names(plan).includes('Crewmate'), j(names(plan)))
  }
  section('§3 a record with no ledger beside it whose bound tool has no saved definition: the roster cannot be replayed, so it is decided afresh and the loss is declared')
  {
    rmSync(prefixLedgerPath(), { force: true })
    const plan = await planAfterRestore(recordFromEarlierBuild([{ name: 'Bash', deferred: false }, { name: RETIRED, deferred: false }]), [tool('Bash'), tool('Read'), tool('Crewmate')])
    check('the live pool decides the roster and the missing tool is declared for the lawful-change receipt', names(plan).includes('Crewmate') && !names(plan).includes(RETIRED) && plan.restoredMissingTools.includes(RETIRED), j(plan))
  }
  section('§4 a recorded deferred tool nobody referenced is outside the bound prefix: this build may drop it, rename it or change its input without moving the prefix')
  {
    writeLedger('1.0.0-beta.33')
    const record = recordFromEarlierBuild([{ name: 'Bash', deferred: false, definition: definitionOf('Bash') }, { name: 'mcp__media__generate_old', deferred: true, definition: definitionOf('mcp__media__generate_old') }, { name: 'mcp__media__generate', deferred: true, definition: definitionOf('mcp__media__generate') }])
    const generate = tool('mcp__media__generate', { isMcp: true, inputJSONSchema: { type: 'object', properties: { text: { type: 'string' }, model: { type: 'string', enum: ['z-image-turbo', 'qwen-image-21'] } } } })
    const plan = await planAfterRestore(record, [tool('Bash'), generate])
    check('the unreferenced deferred tool this build no longer offers rides as its recorded stub, declared nowhere', names(plan).includes('mcp__media__generate_old') && plan.restoredMissingTools.length === 0, j(plan.restoredMissingTools))
    check('an unreferenced deferred tool is unbound; a bound tool is bound', plan.isBound('mcp__media__generate') === false && plan.isBound('Bash') === true)
    const live = await toolToAPISchema(generate, { getToolPermissionContext: async () => getEmptyToolPermissionContext(), tools: plan.roster, agents: [], model, conversationKey: plan.conversationKey, deferLoading: true, bound: plan.isBound('mcp__media__generate') })
    check('the unreferenced deferred tool goes out with its LIVE input (the new model name reaches the wire at once)', j((live as { input_schema?: { properties?: { model?: unknown } } }).input_schema?.properties?.model).includes('qwen-image-21'), j(live))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('ROSTER REPLAY ON BUILD MOVE RED')
  process.exit(1)
}
console.log('ROSTER REPLAY ON BUILD MOVE GREEN')
