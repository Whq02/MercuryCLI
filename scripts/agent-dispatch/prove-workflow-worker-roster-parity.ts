#!/usr/bin/env bun
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.MERCURY_CONCOURSE_WORKER
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/services/providers/callModelRouter.ts')
await import('../../src/utils/messages.ts')
await import('../../src/Tool.ts')
const { resolveWorkerTools } = await import('../../src/tools/AgentTool/agentToolUtils.ts')

type Named = { name: string }
type Capture = { agentType: string; isAsync: boolean; names: string[] }
const captures: Capture[] = []
const realRunAgent = await import('../../src/tools/AgentTool/runAgent.ts')
mock.module('../../src/tools/AgentTool/runAgent.ts', () => ({
  ...realRunAgent,
  runAgent: async function* (opts: {
    agentDefinition: { agentType: string }
    isAsync: boolean
    availableTools: Named[]
  }) {
    captures.push({
      agentType: opts.agentDefinition.agentType,
      isAsync: opts.isAsync,
      names: opts.availableTools.map(t => t.name),
    })
    yield {
      type: 'assistant',
      message: {
        id: `fixture-response-${captures.length}`,
        content: [{ type: 'text', text: 'fixture answer' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      },
    }
  },
}))

const { makeWorkflowHooks, WORKFLOW_SUBAGENT_DEF } = await import('../../src/tools/WorkflowTool/agentHooks.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sorted = (list: readonly Named[]): string[] => list.map(t => t.name).sort()
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((n, i) => n === b[i])
const isMcp = (n: string): boolean => n.startsWith('mcp__')
const show = (list: string[]): string => `${list.length} [${list.join(' ')}]`

const fixtureMcp = [
  { name: 'mcp__fixture__lookup', description: 'fixture', inputSchema: {}, isEnabled: () => true },
  { name: 'mcp__fixture__store', description: 'fixture', inputSchema: {}, isEnabled: () => true },
]
const permissionContext = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
}
const readerDef = {
  agentType: 'fixture-reader',
  whenToUse: 'fixture',
  source: 'user',
  baseDir: '/fixture',
  tools: ['Read', 'Grep'],
  getSystemPrompt: () => 'read only',
}

function harness(): { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> } {
  return makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext: permissionContext, mcp: { tools: fixtureMcp } }),
      options: { agentDefinitions: { activeAgents: [readerDef] }, mainLoopModel: 'fixture-model', mcpClients: [] },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: () => {},
    onAgentController: () => {},
    seedPhaseTitles: [],
  } as never) as never
}

const pool = assembleToolPool({ ...permissionContext, mode: 'implement' } as never, fixtureMcp as never)
const poolNames = sorted(pool)
const general = getBuiltInAgents().find(a => a.agentType === 'mercury-crew')
if (general === undefined) {
  console.error('prove-workflow-worker-roster-parity: the built-in mercury-crew definition is missing')
  process.exit(1)
}
const crewmate = sorted(resolveWorkerTools(general, 'implement', pool, true))
console.log(`  fixture pool: ${show(poolNames)}`)
console.log(`  background crewmate (mercury-crew, async): ${show(crewmate)}`)

section('§1 THE BUILT-IN WORKFLOW WORKER CARRIES A BACKGROUND CREWMATE\'S BOX')
{
  captures.length = 0
  const result = await harness().agent('list the fixture files')
  check('the workflow agent() settled on the fixture answer', result === 'fixture answer', String(result))
  check('the dispatch reached the agent runner exactly once', captures.length === 1, `dispatches=${captures.length}`)
  const worker = captures[0]
  if (worker !== undefined) {
    const wire = [...worker.names].sort()
    check('the built-in workflow worker was dispatched', worker.agentType === WORKFLOW_SUBAGENT_DEF.agentType, worker.agentType)
    check(
      "the worker's roster equals a background mercury-crew crewmate's from the same pool, by name",
      same(wire, crewmate),
      `workflow ${show(wire)} | crewmate ${show(crewmate)}`,
    )
    check('the session MCP tools still ride the roster', fixtureMcp.every(t => wire.includes(t.name)), wire.filter(isMcp).join(' '))
    check('the whole session pool does not reach the wire', wire.length < poolNames.length, `wire=${wire.length} pool=${poolNames.length}`)
  }
}

section("§2 A CUSTOM agentType WITH tools: ['Read','Grep'] FOLLOWS ITS DEFINITION AS THE AGENT TOOL WOULD")
{
  captures.length = 0
  const result = await harness().agent('read the fixture', { agentType: 'fixture-reader' })
  check('the workflow agent() settled on the fixture answer', result === 'fixture answer', String(result))
  const worker = captures[0]
  check('the dispatch reached the agent runner exactly once', captures.length === 1, `dispatches=${captures.length}`)
  if (worker !== undefined) {
    const wire = [...worker.names].sort()
    const law = sorted(resolveWorkerTools(readerDef as never, 'implement', pool, true))
    check('the custom type was dispatched', worker.agentType === 'fixture-reader', worker.agentType)
    check(
      'the built-ins on the wire are exactly Read and Grep',
      same(wire.filter(n => !isMcp(n)), ['Grep', 'Read']),
      show(wire.filter(n => !isMcp(n))),
    )
    check(
      "the roster equals the Agent tool's derivation for the same definition and pool (MCP included exactly as that law admits it)",
      same(wire, law),
      `workflow ${show(wire)} | agent-tool ${show(law)}`,
    )
  }
}

section('§3 THE DISPATCH SEAM')
{
  const src = readFileSync(join(import.meta.dir, '../../src/tools/WorkflowTool/agentHooks.ts'), 'utf8')
  const adapterAt = src.indexOf('async function* adapterSpawnStream(')
  const adapter = src.slice(adapterAt, adapterAt + 2400)
  const spliceAt = src.indexOf('function spliceStructuredTool(')
  const splice = src.slice(spliceAt, spliceAt + 700)
  const lawAt = src.indexOf('function workflowWorkerTools(')
  const law = src.slice(lawAt, lawAt + 900)
  check('one derivation owns the worker roster and it rides resolveWorkerTools', lawAt >= 0 && /resolveWorkerTools\(/.test(law), lawAt >= 0 ? law.slice(0, 120).replace(/\s+/g, ' ') : 'no workflowWorkerTools in agentHooks.ts')
  check("the adapter's pool rides that derivation, never a bare assembleToolPool", adapterAt >= 0 && /workflowWorkerTools\(/.test(adapter) && !/assembleToolPool\(/.test(adapter))
  check('the schema-bound pool rides the same derivation', spliceAt >= 0 && /workflowWorkerTools\(/.test(splice) && !/assembleToolPool\(/.test(splice))
}

section('§4 THE DOC WORDS')
{
  const prompt = readFileSync(join(import.meta.dir, '../../src/tools/WorkflowTool/workflowPrompt.ts'), 'utf8')
  check('the Workflow tool prompt says a workflow agent carries a background sub-agent\'s tool box', /same tool box as a background sub-agent/.test(prompt))
}

if (failures > 0) {
  console.error(`\nprove-workflow-worker-roster-parity: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-workflow-worker-roster-parity: all green')
