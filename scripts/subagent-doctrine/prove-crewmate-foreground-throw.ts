#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log("crewmate-foreground-throw: a throw inside the foreground consumer's loop body hands the run back, so its teardown finally runs once")

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/services/providers/callModelRouter.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
await import('../../src/Tool.ts')
const realRunAgent = await import('../../src/tools/AgentTool/runAgent.ts')

let finallyRuns = 0
let yielded = 0
mock.module('../../src/tools/AgentTool/runAgent.ts', () => ({
  ...realRunAgent,
  runAgent: async function* () {
    try {
      yielded += 1
      yield createAssistantMessage({ content: 'first row' })
      yielded += 1
      yield createAssistantMessage({ content: 'second row' })
    } finally {
      finallyRuns += 1
    }
  },
}))

const { runForegroundAgentExecution } = await import('../../src/tools/AgentTool/foregroundExecution.tsx')
const { MERCURY_CREW_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryCrewAgent.ts')

let state: Record<string, unknown> = { tasks: {}, toolPermissionContext: { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, additionalWorkingDirectories: new Map() } }
const setAppState = (f: (prev: typeof state) => typeof state): void => {
  state = f(state)
}
const thrown = 'the consumer threw inside its loop body'
let result: unknown = 'not settled'
try {
  result = await runForegroundAgentExecution({
    runAgentParams: { agentDefinition: MERCURY_CREW_AGENT, promptMessages: [], toolUseContext: {} as never, canUseTool: (async () => ({ behavior: 'allow' })) as never, isAsync: false, querySource: 'agent:builtin:mercury-crew' as never, override: {}, availableTools: [], description: 'throwing consumer' } as never,
    promptMessages: [createUserMessage({ content: 'work' })],
    prompt: 'work',
    description: 'throwing consumer',
    metadata: { prompt: 'work', resolvedAgentModel: 'fixture-model', isBuiltInAgent: true, startTime: Date.now(), agentType: 'mercury-crew', isAsync: false },
    startTime: Date.now(),
    syncAgentId: 'agent-fg-throw' as never,
    syncAgentContext: { agentType: 'subagent', agentId: 'agent-fg-throw' } as never,
    selectedAgent: MERCURY_CREW_AGENT,
    toolUseContext: {
      options: { tools: [], commands: [], mcpClients: [], agentDefinitions: { activeAgents: [] } },
      abortController: new AbortController(),
      getAppState: () => state,
      setAppState,
      toolUseId: 'tu-fg-throw',
      setResponseLength: () => {
        throw new Error(thrown)
      },
      readFileState: new Map(),
      messages: [],
    } as never,
    assistantMessage: createAssistantMessage({ content: 'launching' }) as never,
    rootSetAppState: setAppState as never,
    backgroundTasksDisabled: true,
    cleanupWorktreeIfNeeded: async () => ({}),
  })
} catch (error) {
  result = { threw: String(error) }
}

check('the consumer settled a failed result carrying the loop body\'s own words', typeof result === 'object' && result !== null && (result as { data?: { status?: string; error?: string } }).data?.status === 'failed' && String((result as { data?: { error?: string } }).data?.error).includes(thrown), JSON.stringify(result).slice(0, 300))
check('the run was handed back: its finally ran exactly once', finallyRuns === 1, `finally ran ${finallyRuns} time(s)`)
check('the run was not read on past the throw (one row yielded)', yielded === 1, `yielded ${yielded}`)
const src = readFileSync(join(ROOT, 'src/tools/AgentTool/foregroundExecution.tsx'), 'utf8')
check('both hand-iterated roads return the generator in their catch (the foreground loop and the detached continuation)', (src.match(/await agentIterator\.return\(undefined\)\.catch\(\(\) => undefined\)/g) ?? []).length === 2)

console.log(`\ncrewmate-foreground-throw: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
