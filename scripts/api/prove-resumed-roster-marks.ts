#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_MODEL']) delete process.env[k]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'resumed-roster-marks-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
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
const { isDeferredToolFor, isDeferredTool } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { planToolPayload, clearToolRosterLatches, armToolRosterRestore, clearToolRosterRestore, conversationRosterKey } = await import('../../src/services/providers/toolEconomy.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { buildSchemaNotSentHint } = await import('../../src/services/tools/toolExecution.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

function fixtureTool(name: string, flags: { shouldDefer?: boolean; loadInFullOnCloud?: boolean } = {}): Tool {
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
const F = fixtureTool('F', { shouldDefer: true })
const G = fixtureTool('G')
const H = fixtureTool('H', { shouldDefer: true, loadInFullOnCloud: true })
const Sleepy = fixtureTool('Sleepy', { shouldDefer: true })
const Plain = fixtureTool('Plain')
const pool: Tool[] = [Plain, ToolSearchTool as never, F, G, H, Sleepy]
const first = createUserMessage({ content: 'begin' }) as Message

check('the declarations: F is deferred by its flags, G is loaded (no flag), H loads in full on cloud, Sleepy is deferred', isDeferredTool(F) && !isDeferredTool(G) && isDeferredToolFor(H, MODEL) === false && isDeferredTool(Sleepy))

section('§1 a conversation whose record loads F and defers G and H — every reader follows the record')
{
  const record = createAttachmentMessage({
    type: 'bound_prefix',
    boundKey: conversationRosterKey('restored', [first], MODEL),
    rosterEnabled: true,
    roster: [
      { name: 'Plain', deferred: false },
      { name: 'ToolSearch', deferred: false },
      { name: 'F', deferred: false },
      { name: 'G', deferred: true },
      { name: 'H', deferred: true },
      { name: 'Sleepy', deferred: true },
    ],
    sections: [],
    systemContext: {},
  })
  const messages: Message[] = [first, record]
  check('F (deferred by its flags) reads LOADED under the record', isDeferredToolFor(F, MODEL, undefined, messages) === false)
  check('G (loaded by its flags, no mark at all) reads DEFERRED under the record', isDeferredToolFor(G, MODEL, undefined, messages) === true)
  check('H (loads in full on cloud by its flags) reads DEFERRED under the record', isDeferredToolFor(H, MODEL, undefined, messages) === true)
  check('a tool the record does not name falls back to its flags (a fresh fixture, deferred by declaration)', isDeferredToolFor(fixtureTool('Unrecorded', { shouldDefer: true }), MODEL, undefined, messages) === true && isDeferredToolFor(fixtureTool('UnrecordedPlain'), MODEL, undefined, messages) === false)
  check('with no record in the history the flags decide', isDeferredToolFor(F, MODEL, undefined, [first]) === true && isDeferredToolFor(G, MODEL, undefined, [first]) === false)
  check('a record for another conversation (a different first row) is not read', isDeferredToolFor(F, MODEL, undefined, [createUserMessage({ content: 'elsewhere' }) as Message, record]) === true)
  check('a record for another model is not read', isDeferredToolFor(F, 'claude-opus-5', undefined, messages) === true)
  const delta = getDeferredToolsDeltaAttachment(pool, MODEL, messages)[0] as { addedNames?: string[] } | undefined
  check('the announcement does not list F and does list G, H and Sleepy', delta !== undefined && !(delta.addedNames ?? []).includes('F') && ['G', 'H', 'Sleepy'].every(name => (delta.addedNames ?? []).includes(name)), delta === undefined ? 'no row' : (delta.addedNames ?? []).join(', '))
  check('the schema-not-sent hint stays silent for F', buildSchemaNotSentHint(F, messages, pool, MODEL) === null)
  check('…and fires for G, whose schema the record says was not sent', buildSchemaNotSentHint(G, messages, pool, MODEL) !== null)
  const searchContext = {
    messages,
    options: { tools: pool, engineModel: MODEL },
    getAppState: () => ({ toolPermissionContext: { ...permissionContext, mode: 'default' }, mcp: { clients: [] } }),
  }
  const search = await ToolSearchTool.call({ query: 'select:Sleepy', max_results: 5 }, searchContext as never)
  check("ToolSearch's total_deferred_tools counts G, H and Sleepy and leaves F out", search.data.total_deferred_tools === 3, String(search.data.total_deferred_tools))
  const keyword = await ToolSearchTool.call({ query: 'g fixture work', max_results: 5 }, searchContext as never)
  check('a keyword search finds G in the drawer', keyword.data.matches.includes('G'), keyword.data.matches.join(', '))
  clearToolRosterLatches()
  clearToolRosterRestore()
  armToolRosterRestore({ key: record.attachment.boundKey, enabled: true, marks: record.attachment.roster })
  const plan = await planToolPayload({ model: MODEL, tools: pool, messages, latchKey: 'restored', getToolPermissionContext: async () => permissionContext, agents: [] })
  check('the restored plan sends F loaded and G and H deferred — the wire and the readers agree', !plan.deferredNames.has('F') && plan.deferredNames.has('G') && plan.deferredNames.has('H') && plan.deferredNames.has('Sleepy'), [...plan.deferredNames].join(', '))
  const schemaF = await toolToAPISchema(F, { getToolPermissionContext: async () => permissionContext, tools: plan.roster, agents: [], model: MODEL, deferLoading: plan.deferredNames.has('F') }) as { defer_loading?: boolean }
  const schemaG = await toolToAPISchema(G, { getToolPermissionContext: async () => permissionContext, tools: plan.roster, agents: [], model: MODEL, deferLoading: plan.deferredNames.has('G') }) as { defer_loading?: boolean }
  check("F's schema carries no defer_loading; G's carries it", schemaF.defer_loading === undefined && schemaG.defer_loading === true)
  clearToolRosterRestore()
  clearToolRosterLatches()
}

section('§2 a record with deferral off loads everything it names')
{
  const record = createAttachmentMessage({
    type: 'bound_prefix',
    boundKey: conversationRosterKey('restored-off', [first], MODEL),
    rosterEnabled: false,
    roster: [{ name: 'F', deferred: true }, { name: 'Sleepy', deferred: true }],
    sections: [],
    systemContext: {},
  })
  const messages: Message[] = [first, record]
  check('F and Sleepy read loaded when the record says deferral was off', isDeferredToolFor(F, MODEL, undefined, messages) === false && isDeferredToolFor(Sleepy, MODEL, undefined, messages) === false)
}

section('§3 the newest record wins, and the record is read once per messages array')
{
  const older = createAttachmentMessage({ type: 'bound_prefix', boundKey: conversationRosterKey('restored', [first], MODEL), rosterEnabled: true, roster: [{ name: 'F', deferred: true }], sections: [], systemContext: {} })
  const newer = createAttachmentMessage({ type: 'bound_prefix', boundKey: conversationRosterKey('restored', [first], MODEL), rosterEnabled: true, roster: [{ name: 'F', deferred: false }], sections: [], systemContext: {} })
  check('the newest record decides', isDeferredToolFor(F, MODEL, undefined, [first, older, newer]) === false && isDeferredToolFor(F, MODEL, undefined, [first, newer, older]) === true)
  const plain: Message[] = [first, newer]
  let indexReads = 0
  const counted = new Proxy(plain, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) indexReads++
      return Reflect.get(target, property, receiver)
    },
  })
  isDeferredToolFor(F, MODEL, undefined, counted)
  const afterOne = indexReads
  const tools = Array.from({ length: 40 }, (_, i) => fixtureTool(`T${i}`, { shouldDefer: true }))
  for (const tool of [...tools, F, G, H]) isDeferredToolFor(tool, MODEL, undefined, counted)
  check(`the history is scanned once for the array, not once per tool (${afterOne} index reads after one lookup, ${indexReads} after forty-four)`, afterOne > 0 && indexReads === afterOne)
  const grown: Message[] = [first, newer, older]
  const countedGrown = new Proxy(grown, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) indexReads++
      return Reflect.get(target, property, receiver)
    },
  })
  check('a different array is read afresh', isDeferredToolFor(F, MODEL, undefined, countedGrown) === true)
  counted.push(older as never)
  check('a message appended to the same array is seen (the newest record is now the older mark)', isDeferredToolFor(F, MODEL, undefined, counted) === true)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
