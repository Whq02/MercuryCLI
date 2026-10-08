import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'summary-request-roads-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { startOverflowFixture, OVERFLOW_LANES } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { compactConversation, partialCompactConversation } = await import('../../src/services/compact/compact.ts')
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, details: unknown = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(details)}`}`)
}
const forbidden = /<analysis\b|(?:show|reveal|expose|wrap)[^.\n]{0,100}(?:reasoning|thinking)|produce the analysis/i
const summary = 'The synthetic parser accepts quoted commas and its 14 checks passed. Preserve the test command and continue with CLI verification.'
const custom = 'Preserve the test command exactly.'
try {
  const roads = [...OVERFLOW_LANES, { lane: 'openrouter-responses', model: OVERFLOW_LANES.find(road => road.lane === 'openrouter')!.model, dialect: 'responses' }]
  for (const road of roads) {
    for (const direction of ['full', 'from', 'up_to'] as const) {
      const tools = road.lane === 'openrouter-responses' ? [ToolSearchTool, FileReadTool, { ...FileReadTool, name: 'mcp__fold_fixture__read', isMcp: true }] : []
      const context: any = { agentId: `summary-${road.lane}-${direction}`, abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], readFileState: new Map(), options: { tools, commands: [], mcpClients: [], engineModel: road.model, maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
      const messages = [createUserMessage({ content: 'The synthetic parser accepts quoted commas and all 14 checks passed.' })]
      const cache = { systemPrompt: ['Synthetic fold request proof.'] } as never
      const before = fixture.captured.length
      fixture.script(request => forbidden.test(JSON.stringify(request.body)) ? { refusal: true } : { text: summary })
      let result: Awaited<ReturnType<typeof compactConversation>> | undefined
      let error: unknown
      try {
        result = direction === 'full'
          ? await compactConversation(messages, context, cache, false, custom)
          : await partialCompactConversation(messages, direction === 'from' ? 0 : messages.length, context, cache, custom, direction)
      } catch (caught) { error = String(caught) }
      const requests = fixture.captured.slice(before)
      const wire = JSON.stringify(requests.map(request => request.body))
      const label = `${road.lane} ${direction}`
      check(`${label}: one request on its declared wire`, requests.length === 1 && requests[0]?.dialect === road.dialect, requests.map(request => ({ dialect: request.dialect, path: request.path })))
      check(`${label}: built request never demands exposed reasoning`, requests.length > 0 && !forbidden.test(wire), error)
      check(`${label}: the requested summary and custom instructions survive`, result?.summaryMessages.some(message => String(message.message.content).includes(summary)) === true && wire.includes(custom), error)
    }
  }
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} summary-request-roads: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
