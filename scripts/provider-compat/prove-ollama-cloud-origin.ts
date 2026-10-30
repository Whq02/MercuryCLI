;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const parent = process.env.MERCURY_CONFIG_DIR
assert.ok(parent)
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'ollama-origin-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['MERCURY_HOME', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM']) delete process.env[key]
const models = [{ name: 'downloaded' }, { name: 'cloud', remote_model: 'upstream', remote_host: 'https://ollama.com' }, { name: 'remote', remote_model: 'other', remote_host: 'https://models.example.test' }, { name: 'model-only', remote_model: 'upstream' }]
const requests: string[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
  const path = new URL(req.url).pathname
  if (path === '/api/tags') return Response.json({ models })
  if (path === '/api/version') return Response.json({ version: 'fixture' })
  if (path === '/api/ps') return Response.json({ models: models.map(row => ({ name: row.name, context_length: 131072 })) })
  if (path === '/api/show') return Response.json({ capabilities: ['completion', 'tools'] })
  if (path === '/api/chat') {
    const body = await req.json() as { model: string }
    requests.push(body.model)
    return new Response(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'served' }, done: true, prompt_eval_count: 10, eval_count: 1 }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
  }
  return new Response('not found', { status: 404 })
} })
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${server.port}`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { getLocalModelOptions, localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localLiveCatalogue } = await import('../../src/services/providers/local/localAdapter.ts')
const { resolveModelPricing, getModelPricingString } = await import('../../src/utils/modelCost.ts')
const { activeSourceUsage } = await import('../../src/services/providers/providerUsage.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  try { assert.deepEqual(actual, expected); console.log(`PASS ${label}`) }
  catch { failures++; console.error(`FAIL ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`) }
}
try {
  await discovery.refreshLocalDiscovery({ force: true })
  for (const model of models) {
    const id = `local/${model.name}`
    const origin = model.remote_model ? { kind: 'remote', remoteModel: model.remote_model, ...(model.remote_host ? { remoteHost: model.remote_host } : {}) } : { kind: 'local' }
    check(`${id} discovery origin`, (localRecordFor(id) as any)?.executionOrigin, origin)
    check(`${id} catalogue origin`, (localLiveCatalogue().find(row => row.id === id) as any)?.executionOrigin, origin)
    const selected = getLocalModelOptions().find(row => row.value === id)!
    check(`${id} selection origin`, (selected as any).executionOrigin, origin)
    check(`${id} pricing basis`, resolveModelPricing(id).basis, model.remote_model ? 'unpriced' : 'recorded')
    check(`${id} price display`, getModelPricingString(id), model.remote_model ? undefined : '$0/$0 per Mtok')
    if (model.remote_model) check(`${id} description identifies upstream`, selected.descriptionForModel?.includes(model.remote_model), true)
    const resume = JSON.parse(JSON.stringify({ model: selected.value, messages: [createUserMessage({ content: 'Continue.' })] }))
    discovery.__resetLocalDiscoveryForTest()
    let answered = false
    for await (const row of routedCallModel({ messages: resume.messages, systemPrompt: asSystemPrompt(['Fixture.']), tools: [], signal: new AbortController().signal, thinkingConfig: { type: 'disabled' }, options: { model: resume.model, querySource: 'user', isNonInteractiveSession: true, getToolPermissionContext: async () => ({ mode: 'default' }) } as never })) if (row.type === 'assistant' && !(row as any).isApiErrorMessage) answered = true
    check(`${id} unpriced does not block resumed inference`, answered && requests.at(-1) === model.name, true)
    check(`${id} resume restores origin`, (localRecordFor(resume.model) as any)?.executionOrigin, origin)
  }
  check('usage identifies unknown remote pricing', activeSourceUsage({ model: 'local/cloud', reads: {} }).absence?.includes('remote pricing unknown'), true)
  models.splice(1)
  await discovery.refreshLocalDiscovery({ force: true })
  check('downloaded-only usage stays local', activeSourceUsage({ model: 'local/downloaded', reads: {} }).absence, 'local · no metering')
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
