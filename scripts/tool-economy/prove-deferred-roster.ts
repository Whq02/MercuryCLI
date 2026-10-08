#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'deferred-roster-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fixture: { command: 'true', args: [], connect: 'stdio' } })
process.env.TYPESAFE_API_KEY = 'proof-key-deferred-roster-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(config => ({ ...config, jev: { ...(config.jev ?? {}), enabled: true } }))
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { planToolPayload, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool, getAllBaseTools } = await import('../../src/tools.ts')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

const EIGHT = ['JevEval', 'Debug', 'Git', 'AstEdit', 'Test', 'Monitor', 'Checkpoint', 'Rewind']
const LOADED = ['Agent', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Skill', 'Eval', 'AstSearch', 'ChangeSet', 'LspRead', 'ToolSearch']
const BENCH_ROSTER = [
  ...LOADED,
  ...EIGHT,
  'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest',
  'ApolloReview', 'AskUserQuestion', 'Browser', 'Computer', 'ContextLeft', 'Correct', 'EnterWorktree', 'ExitWorktree', 'Inspect', 'Journey', 'Launch', 'NotebookEdit', 'ProviderSearch', 'Recall', 'RecordConvention', 'Reflect', 'Retain', 'SendMessage', 'Service', 'Sleep', 'Structure', 'TaskStop', 'Transaction', 'WebFetch', 'WebSearch', 'Workflow',
]
const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5']

const permissionContext = getEmptyToolPermissionContext()
const pool: Tool[] = [...assembleToolPool(permissionContext, [])]
const catalogue = getAllBaseTools()
const absentHere = BENCH_ROSTER.filter(name => !pool.some(item => item.name === name))
for (const name of absentHere) {
  const tool = catalogue.find(item => item.name === name)
  if (tool !== undefined) pool.push(tool)
}
const { computerToolEnabled } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const BENCH_HERE = computerToolEnabled() ? BENCH_ROSTER : BENCH_ROSTER.filter(name => name !== 'Computer')
const missing = BENCH_HERE.filter(name => !pool.some(item => item.name === name))
console.log(`  the pool: ${pool.length} tools · added from the catalogue because this environment's gates leave them out: ${absentHere.join(', ') || 'none'}${computerToolEnabled() ? '' : ' · Computer is not in this build (no desktop driver)'}`)
check('every tool of the bench roster this build offers is in the pool', missing.length === 0, missing.join(', '))
const roster: Tool[] = BENCH_HERE.flatMap(name => pool.filter(tool => tool.name === name))
const first = createUserMessage({ content: 'Reply with exactly: ok' }) as Message

section('§1 the plan on the block form, first party — the eight are deferred and exactly thirteen load in full')
for (const model of MODELS) {
  clearToolRosterLatches()
  const wire = deferralWireFormFor(model)
  check(`${model} rides the block form, first party`, wire.form === 'block' && wire.why === 'first-party-contract', `${wire.form}/${wire.why}`)
  const plan = await planToolPayload({ model, tools: roster, messages: [first], getToolPermissionContext: async () => permissionContext, agents: [], source: 'deferred-roster' })
  check(`${model}: deferral is on`, plan.enabled === true)
  const notDeferred = EIGHT.filter(name => !plan.deferredNames.has(name))
  check(`${model}: deferredNames holds all eight (JevEval, Debug, Git, AstEdit, Test, Monitor, Checkpoint, Rewind)`, notDeferred.length === 0, `still loaded: ${notDeferred.join(', ')}`)
  const loaded = plan.roster.map(tool => tool.name).filter(name => !plan.deferredNames.has(name)).sort()
  const expected = [...LOADED].sort()
  check(`${model}: the roster names not in deferredNames are exactly the thirteen, with LspRead in full`, loaded.join(',') === expected.join(','), `loaded: ${loaded.join(', ')}`)
  const schemas = await Promise.all(EIGHT.map(async name => {
    const tool = roster.find(item => item.name === name)!
    const schema = await toolToAPISchema(tool, { getToolPermissionContext: async () => permissionContext, tools: plan.roster, agents: [], model, deferLoading: plan.deferredNames.has(name) }) as { name?: string; defer_loading?: boolean }
    return { name, schema }
  }))
  check(`${model}: the block-form schema of each of the eight carries defer_loading: true`, schemas.every(({ schema }) => schema.defer_loading === true && typeof schema.name === 'string'), schemas.filter(({ schema }) => schema.defer_loading !== true).map(({ name }) => name).join(', '))
  const loadedSchemas = await Promise.all(LOADED.map(async name => {
    const tool = roster.find(item => item.name === name)!
    return toolToAPISchema(tool, { getToolPermissionContext: async () => permissionContext, tools: plan.roster, agents: [], model, deferLoading: plan.deferredNames.has(name) }) as { defer_loading?: boolean }
  }))
  check(`${model}: none of the thirteen carries the mark`, loadedSchemas.every(schema => schema.defer_loading === undefined))
  const bytes = (schema: unknown): number => Buffer.byteLength(JSON.stringify(schema), 'utf8')
  const eightBytes = schemas.reduce((sum, { schema }) => sum + bytes(schema), 0)
  const loadedBytes = loadedSchemas.reduce((sum, schema) => sum + bytes(schema), 0)
  console.log(`  ${model}: ${plan.roster.length} definitions ride; ${loadedSchemas.length} loaded in full (${loadedBytes.toLocaleString()} bytes) · the eight deferred (${eightBytes.toLocaleString()} bytes, defer_loading included)`)
}

section('§2 the declarations — each of the eight declares itself deferrable and none loads in full on cloud')
for (const name of EIGHT) {
  const tool = roster.find(item => item.name === name) as Tool & { shouldDefer?: boolean; loadInFullOnCloud?: boolean }
  check(`${name}: shouldDefer is true and loadInFullOnCloud is not set`, tool.shouldDefer === true && tool.loadInFullOnCloud !== true, `shouldDefer=${String(tool.shouldDefer)} loadInFullOnCloud=${String(tool.loadInFullOnCloud)}`)
}
clearToolRosterLatches()

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
