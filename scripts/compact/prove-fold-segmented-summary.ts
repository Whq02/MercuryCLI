import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { validateEngineRequest } from '../provider-compat/fixtures/engineRules.mjs'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
f.state.dialect = 'vllm'
writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ compatProvider: { segmented: { baseUrl: f.baseUrl, dialect: 'vllm', models: [f.model] } } }))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()
const originalFetch = globalThis.fetch
let plan: 'split-text' | 'trailing-thought' | 'cut' = 'split-text'
const first = 'SUMMARY-FIRST: the migration is complete and the database checks passed.'
const last = 'SUMMARY-LAST: the next step is verifying the command-line parser.'
const thought = 'PRIVATE-FOLD-REASONING'
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(url.hostname, '127.0.0.1', 'all provider traffic stays on loopback')
  const response = await originalFetch(input, init)
  if (url.pathname !== '/v1/chat/completions') return response
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : await (input as Request).clone().text())
  assert.equal(validateEngineRequest('vllm', body), undefined)
  await response.text()
  const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 120, completion_tokens: 30 } } : {}) })}\n\n`
  const text = chunk({ content: first }) + (plan === 'cut' ? '' : chunk({ reasoning_content: thought }) + (plan === 'split-text' ? chunk({ content: last }) : '') + chunk({}, 'stop') + 'data: [DONE]\n\n')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}, originalFetch)
const previousCwd = process.cwd()
process.chdir(f.home)
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setOriginalCwd(f.home)
bootstrap.setCwdState(f.home)
const { compactConversation } = await import('../../src/services/compact/compact.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const model = `compat/segmented/${f.model}`
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], readFileState: createFileStateCacheWithSizeLimit(100), options: { tools: [], commands: [], mcpClients: [], engineModel: model, thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
const messages = [f.createUserMessage({ content: 'The requested work concerns the migration and the command-line parser.' })]
const cache = { systemPrompt: asSystemPrompt(['Segmented summary fixture']), userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages }
let checks = 0
let failures = 0
const check = (label: string, truth: unknown, detail?: unknown) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${label}${!truth && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`) }
try {
  for (const mode of ['split-text', 'trailing-thought'] as const) {
    plan = mode
    const before = f.captures.length
    const result = await compactConversation(messages, context, cache as never, true)
    const summary = JSON.stringify(result.summaryMessages)
    check(`${mode}: every summary text block survives instead of only the last assistant block`, summary.includes(first) && (mode !== 'split-text' || summary.includes(last)), summary.slice(0, 300))
    check(`${mode}: the complete summary needs one request, not a no-text retry`, f.captures.length === before + 1, f.captures.length - before)
    check(`${mode}: reasoning never appears as summary prose`, !summary.includes(thought))
    check(`${mode}: the summariser keeps max effort`, f.captures.slice(before).every(row => row.body.reasoning_effort === 'max'))
  }
  plan = 'cut'
  const cut = await compactConversation(messages, context, cache as never, true).then(value => ({ result: value }), error => ({ error: String(error) }))
  check('a fault after partial text still refuses the fold instead of accepting that text', 'error' in cut && !('result' in cut), cut)
} finally {
  globalThis.fetch = originalFetch
  process.chdir(previousCwd)
  f.close()
}
console.log(`SEGMENTED SUMMARY ${failures ? 'RED' : 'GREEN'} — ${checks - failures}/${checks}; real compact runner, routed compat stream, scripted block boundaries`)
process.exit(failures ? 1 : 0)
