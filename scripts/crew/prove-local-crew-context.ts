#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'local-crew-context-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_CREWS_DIR', 'NODE_ENV']) delete process.env[key]
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/tools/AgentTool/AgentTool.tsx')
const { streamOllamaChat } = await import('../../src/services/providers/local/ollamaChatTransport.ts')
const { mapCompatUsageToAnthropic } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { getTokenCountFromUsage } = await import('../../src/utils/tokenUsage.ts')
const { contextFill } = await import('../../src/utils/tokens.ts')
const runAgentModule = await import('../../src/tools/AgentTool/runAgent.ts')
const MODEL = 'local/fixture-context'
let turns = 0
let expectedContext = 0
const wireRows = [
  { prompt_eval_count: 12000, eval_count: 300 },
  { prompt_eval_count: 14000, eval_count: 500, prompt_eval_cached_count: 10000 },
  {},
]
async function* fixtureRunAgent(): AsyncGenerator<unknown> {
  const turn = turns++
  const message = createAssistantMessage({ content: 'The fixture answer.' })
  message.message.model = MODEL
  message.message.id = `local-response-${turn}`
  const realFetch = globalThis.fetch
  let usage: Parameters<typeof mapCompatUsageToAnthropic>[0]
  globalThis.fetch = (async () => new Response(JSON.stringify({ model: 'fixture-context', message: { role: 'assistant', content: 'The fixture answer.' }, done: true, done_reason: 'stop', ...wireRows[turn] }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })) as typeof fetch
  try {
    for await (const event of streamOllamaChat({ url: 'http://127.0.0.1:1/api/chat', request: { model: 'fixture-context', messages: [{ role: 'user', content: 'fixture' }] } }, {})) {
      if (event.type === 'usage') usage = event.usage
      if (event.type === 'stream-fault') throw new Error(JSON.stringify(event.fault))
    }
  } finally {
    globalThis.fetch = realFetch
  }
  yield message
  message.message.usage = mapCompatUsageToAnthropic(usage) as never
  expectedContext = getTokenCountFromUsage(message.message.usage)
  const gauge = contextFill([message])
  if (expectedContext > 0 && gauge.tokens !== expectedContext) throw new Error(`gauge disagrees: ${gauge.tokens}/${expectedContext}`)
}
mock.module('../../src/tools/AgentTool/runAgent.ts', () => ({ ...runAgentModule, runAgent: fixtureRunAgent }))
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { spawnInProcessCrewmate } = await import('../../src/utils/swarm/spawnInProcess.ts')
const { runInProcessCrewmate } = await import('../../src/utils/swarm/inProcessRunner.ts')
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
const crew = await import('../../src/services/engine-connector/crewFacts.ts')
const { writeCrewFileAsync, getCrewFilePath } = await import('../../src/utils/swarm/crewHelpers.ts')
const { sendLiveMessage } = await import('../../src/services/crew/liveComms.ts')
const { formatAgentId } = await import('../../src/utils/agentId.ts')
type AppState = import('../../src/state/AppState.tsx').AppState
const group = 'context-fixture'
const name = 'local-scout'
const lead = 'crew-lead'
const leadId = formatAgentId(lead, group)
let state = { ...getDefaultAppState(), crewContext: { crewName: group, crewFilePath: getCrewFilePath(group), leadAgentId: leadId, crewmates: {} } } as AppState
const setAppState = (update: (state: AppState) => AppState): void => { state = update(state) }
const member = (n: string) => ({ agentId: formatAgentId(n, group), name: n, agentType: 'mercury-crew', model: MODEL, joinedAt: 1000, tmuxPaneId: 'in-process', cwd: process.cwd(), subscriptions: [], backendType: 'in-process' })
await writeCrewFileAsync(group, { name: group, createdAt: 1000, leadAgentId: leadId, leadSessionId: String(getSessionId()), members: [member(lead), member(name)] } as never)
const context = { options: { tools: [], commands: [], mainLoopModel: MODEL, mcpClients: [], mcpResources: {}, debug: false, verbose: false, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: [] } }, messages: [], abortController: new AbortController(), getAppState: () => state, setAppState, setAppStateForTasks: setAppState, readFileState: new Map(), toolUseId: 'local-fixture-launch' } as never
const spawn = await spawnInProcessCrewmate({ name, crewName: group, prompt: 'Inspect the fixture.', model: MODEL }, { setAppState })
if (!spawn.success || !spawn.taskId || !spawn.crewmateContext || !spawn.abortController) throw new Error(spawn.error ?? 'fixture spawn failed')
const taskId = spawn.taskId
const done = runInProcessCrewmate({ identity: { agentId: formatAgentId(name, group), agentName: name, crewName: group, parentSessionId: String(getSessionId()) }, taskId, prompt: 'Inspect the fixture.', crewmateContext: spawn.crewmateContext, abortController: spawn.abortController, toolUseContext: context, model: MODEL, systemPrompt: 'Fixture only.', systemPromptMode: 'replace', transcriptAgentId: spawn.transcriptAgentId })
let failures = 0
const check = (label: string, good: boolean, detail = ''): void => { if (!good) failures++; console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good ? ` — ${detail}` : ''}`) }
const waitIdle = async (n: number): Promise<void> => {
  const deadline = Date.now() + 30000
  while (turns < n || (state.tasks[taskId] as { isIdle?: boolean } | undefined)?.isIdle !== true) {
    if (Date.now() > deadline) throw new Error(`fixture never reached idle turn ${n}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const facts = () => crew.crewAgentFactsOf(projectWorkRoster(state.tasks).find(row => row.id === taskId)!, 'fixture')!
try {
  await waitIdle(1)
  const first = facts()
  check('local settled usage reaches the row after the generator finishes', first.tokens?.context === 12300 && expectedContext === 12300, crew.crewTokensLabel(first) ?? '—')
  check('local context uses the same usage count as the parent gauge', first.tokens?.context === expectedContext, JSON.stringify(first.tokens))
  await sendLiveMessage(group, { to: name, from: lead, text: 'Read the next fixture.', timestamp: new Date().toISOString() })
  await waitIdle(2)
  const second = facts()
  check('local context replaces with the newest measured reply', second.tokens?.context === 14500 && expectedContext === 14500, JSON.stringify(second.tokens))
  check('tokens used accumulate across crewmate chat turns', second.tokens?.input === 16000 && second.tokens.output === 800 && second.tokens.total === 16800, JSON.stringify(second.tokens))
  await sendLiveMessage(group, { to: name, from: lead, text: 'Read the usage-less fixture.', timestamp: new Date().toISOString() })
  await waitIdle(3)
  check('a usage-less local reply never fabricates a zero or erases the last reading', facts().tokens?.context === 14500 && facts().tokens?.total === 16800, JSON.stringify(facts().tokens))
} finally {
  spawn.abortController.abort()
  await done
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`local-crew-context: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
