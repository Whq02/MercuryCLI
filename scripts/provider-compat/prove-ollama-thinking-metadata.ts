;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'

const parent = process.env.MERCURY_CONFIG_DIR
assert.ok(parent, 'a scratch MERCURY_CONFIG_DIR is required')
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'ollama-thinking-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['MERCURY_HOME', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM']) delete process.env[key]

const metadata: Record<string, unknown> = {
  boolean: { values: [false, true], default: true },
  named: { values: ['low', 'high', 'max'], default: 'high' },
  arbitrary: { values: ['quick', 'deep'], default: 'deep' },
  off: { values: [false], default: false },
}
const names = [...Object.keys(metadata), 'legacy', 'plain']
const bodies: Array<Record<string, any>> = []
let toolReply = false
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(req: Request) {
    const path = new URL(req.url).pathname
    if (path === '/api/tags') return Response.json({ models: names.map(name => ({ name })) })
    if (path === '/api/version') return Response.json({ version: 'fixture' })
    if (path === '/api/ps') return Response.json({ models: names.map(name => ({ name, context_length: 131072 })) })
    if (path === '/api/show') {
      const body = await req.json() as { model: string }
      return Response.json({ capabilities: ['completion', 'tools', ...(body.model === 'plain' ? [] : ['thinking'])], ...(metadata[body.model] ? { thinking: metadata[body.model] } : {}) })
    }
    if (path === '/api/chat') {
      const body = await req.json() as Record<string, any>
      bodies.push(body)
      const message = toolReply
        ? { role: 'assistant', thinking: 'Read it first.', content: '', tool_calls: [{ id: 'read-1', function: { name: 'Read', arguments: { file_path: 'fixture.ts' } } }] }
        : { role: 'assistant', content: 'done' }
      return new Response(JSON.stringify({ model: body.model, message, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 5 }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
    }
    return new Response('not found', { status: 404 })
  },
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${server.port}`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const tool = { name: 'Read', inputSchema: z.object({ file_path: z.string() }), description: async () => 'Read a fixture', prompt: async () => 'Read a fixture', isEnabled: () => true, isReadOnly: () => true, isConcurrencySafe: () => true, maxResultSizeChars: 10000 } as never
let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  try { assert.deepEqual(actual, expected); console.log(`PASS ${label}`) }
  catch { failures++; console.error(`FAIL ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`) }
}
async function send(name: string, effort: string | undefined, thinking = true, messages: any[] = [createUserMessage({ content: 'Read the fixture.' })]) {
  const rows: any[] = []
  for await (const row of routedCallModel({ messages, systemPrompt: asSystemPrompt(['Fixture.']), tools: [tool], signal: new AbortController().signal, thinkingConfig: { type: thinking ? 'enabled' : 'disabled', budgetTokens: 10000 } as never, options: { model: `local/${name}`, effortValue: effort, querySource: 'user', isNonInteractiveSession: true, getToolPermissionContext: async () => ({ mode: 'default' }) } as never })) rows.push(row)
  check(`${name} answered`, rows.some(row => row.type === 'assistant' && !row.isApiErrorMessage), true)
  return { body: bodies.at(-1)!, rows, messages }
}
try {
  await discovery.refreshLocalDiscovery({ force: true })
  check('named vocabulary and default retained', (localRecordFor('local/named') as any)?.thinking, metadata.named)
  check('arbitrary vocabulary retained', (localRecordFor('local/arbitrary') as any)?.thinking, metadata.arbitrary)
  const view = effortVocabularyFor('local/named') as any
  check('selection reads advertised vocabulary', view.vocabulary, ['low', 'high', 'max'])
  check('selection reads model default', view.defaultEffort, 'high')
  for (const name of ['low', 'high', 'max']) check(`named ${name} request bytes`, (await send('named', name)).body.think, name)
  check('named default request bytes', (await send('named', undefined)).body.think, 'high')
  check('arbitrary chosen level request bytes', (await send('arbitrary', 'quick')).body.think, 'quick')
  check('boolean-only on stays boolean', (await send('boolean', 'max')).body.think, true)
  check('boolean-only off stays boolean', (await send('boolean', 'max', false)).body.think, false)
  check('false-only metadata is respected', (await send('off', undefined)).body.think, false)
  check('legacy thinking metadata absent is unchanged', (await send('legacy', 'high')).body.think, true)
  check('no metadata and no thinking capability unchanged', Object.hasOwn((await send('plain', 'high')).body, 'think'), false)
  toolReply = true
  const first = await send('named', 'max')
  toolReply = false
  const assistant = first.rows.find(row => row.type === 'assistant' && row.message.content.some((block: any) => block.type === 'tool_use'))
  check('tool call survives', !!assistant, true)
  if (assistant) {
    const resumed = JSON.parse(JSON.stringify({ effort: 'max', messages: [...first.messages, ...first.rows.filter(row => row.type === 'assistant'), createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'fixture result' }] })] }))
    discovery.__resetLocalDiscoveryForTest()
    const continued = await send('named', resumed.effort, true, resumed.messages)
    check('resume rediscovers and keeps max', continued.body.think, 'max')
    check('resume keeps tool roster', continued.body.tools.map((entry: any) => entry.function.name), ['Read'])
    check('resume keeps thinking beside call', continued.body.messages.find((row: any) => row.role === 'assistant')?.thinking, 'Read it first.')
    check('resume keeps paired tool result', continued.body.messages.some((row: any) => row.role === 'tool' && row.tool_call_id === 'read-1'), true)
  }
  metadata.named = { values: ['high', 'max', 'deep'], default: 'deep' }
  await discovery.refreshLocalDiscovery({ force: true })
  check('refresh updates vocabulary and default', (localRecordFor('local/named') as any)?.thinking, metadata.named)
  check('refresh default reaches request bytes', (await send('named', undefined)).body.think, 'deep')
  check('refresh keeps selected max', (await send('named', 'max')).body.think, 'max')
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
