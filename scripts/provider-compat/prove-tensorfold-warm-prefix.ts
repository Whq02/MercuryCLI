#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'tensorfold-warm-prefix-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_PROMPT_PROFILE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Route = (req: IncomingMessage, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        if (!route(req, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end('{}')
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, root: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}` })
    })
  })
}
const json = (res: ServerResponse, body: unknown): true => {
  res.writeHead(200, { 'content-type': 'application/json', server: 'TensorFold' })
  res.end(JSON.stringify(body))
  return true
}
const tensorfold = await serve((req, res) => {
  const url = req.url ?? ''
  if (url === '/health') return json(res, { status: 'ok', model: 'qwen3.5-2b', model_ids: ['qwen3.5-2b'], max_batch_size: 8, warming: false, memory: {}, live: {}, version: '1.2.2', backend: 'metal', device: 'Apple M5 Pro' })
  if (/\/models$/.test(url)) return json(res, { object: 'list', data: [{ id: 'qwen3.5-2b', object: 'model', created: 1, owned_by: 'tensorfold', context_length: 32768, max_model_len: 32768, reasoning: { default_enabled: true } }] })
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${tensorfold.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { composeLocalWarm } = await import('../../src/services/providers/local/localWarm.ts')
const { appendSystemContext, firstTurnUserContext } = await import('../../src/utils/api.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { renderGenericInstructions, resolveBehaviourContract } = await import('../../src/prompt/behaviourContract.ts')
const { localPromptProfileApplies } = await import('../../src/constants/localPromptProfile.ts')
const { MEMORY_AT_START_HEADING } = await import('../../src/mneme/entryKnapsack.ts')
const { ENTRY_PAGE_HEADING } = await import('../../src/mneme/entryPage.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

await refreshLocalDiscovery({ force: true })
const MODEL = 'local/qwen3.5-2b'
const record = localRecordFor(MODEL)
check('the fixture is discovered as TensorFold', record?.server === 'tensorfold')
check('the local prompt profile applies to the model', localPromptProfileApplies(MODEL))
if (record === undefined) {
  tensorfold.server.close()
  process.exit(1)
}

const STABLE = 'You are Mercury. The same rules, fewer words.'
const VOLATILE = [`${MEMORY_AT_START_HEADING}\n- a remembered fact`, `${ENTRY_PAGE_HEADING}\n- a lineage line`, 'Scratchpad directory: a per-session place']
const systemPrompt = asSystemPrompt([STABLE, ...VOLATILE])
const systemContext = { gitStatus: 'Current branch: main\nStatus: (clean)', gitRules: 'commit only when asked' }
const userContext = { date: 'Today is a date', environment: 'a terminal' }
const permissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
const appStateStub = { toolPermissionContext: permissionContext, mcp: { clients: [], tools: [] }, effortValue: undefined }
const toolUseContext = {
  options: { tools: [], thinkingConfig: { type: 'disabled' }, engineModel: MODEL, agentDefinitions: { activeAgents: [], allAgents: [] }, commands: [], mcpClients: [], isNonInteractiveSession: true },
  getAppState: () => appStateStub,
  setAppState: () => {},
  abortController: new AbortController(),
  messages: [],
}
const context = { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: [] }

section('§1 the warm request renders the first turn\'s system bytes: the volatile sections and gitStatus leave the system message on the local profile')
const warm = await composeLocalWarm(record, MODEL, context as never)
check('the warm composed', !('skipped' in warm), 'skipped' in warm ? warm.skipped : '')
if (!('skipped' in warm)) {
  const system = warm.request.messages.find(message => (message as { role?: string }).role === 'system') as { content?: unknown } | undefined
  const warmSystem = typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content)
  const turnSystem = renderGenericInstructions(resolveBehaviourContract([...asSystemPrompt(appendSystemContext(systemPrompt, systemContext, MODEL))]))
  check('the warm\'s system text equals the turn\'s system text byte for byte', warmSystem === turnSystem, `warm ${warmSystem.length} B vs turn ${turnSystem.length} B`)
  check('the stable rule stays', warmSystem.includes(STABLE))
  check('memory at start, the lineage and the scratchpad line are not in the warm\'s system text', !warmSystem.includes(MEMORY_AT_START_HEADING) && !warmSystem.includes(ENTRY_PAGE_HEADING) && !warmSystem.includes('Scratchpad directory:'), warmSystem.slice(0, 300))
  check('gitStatus is not in the warm\'s system text; gitRules stays', !warmSystem.includes('Current branch: main') && warmSystem.includes('commit only when asked'))
  const cloudTurn = renderGenericInstructions(resolveBehaviourContract([...asSystemPrompt(appendSystemContext(systemPrompt, systemContext))]))
  check('red on the base: the two-argument composition (what the warm sent before) keeps them, so its bytes differ', cloudTurn !== turnSystem && cloudTurn.includes(MEMORY_AT_START_HEADING) && cloudTurn.includes('Current branch: main'))
  const firstTurn = await firstTurnUserContext(userContext, systemContext, MODEL)
  check('the first user turn carries what left the system message (gitStatus among the facts), beside the date and environment', firstTurn.gitStatus === systemContext.gitStatus && firstTurn.date === userContext.date, JSON.stringify(Object.keys(firstTurn)))
  check('a cloud model\'s first turn is the user context unchanged', (await firstTurnUserContext(userContext, systemContext, 'claude-opus-5-5')) === userContext)
}

tensorfold.server.close()
console.log(`\nprove-tensorfold-warm-prefix: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
