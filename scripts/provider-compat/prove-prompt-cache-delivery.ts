import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const home = mkdtempSync(join(tmpdir(), 'prompt-cache-delivery-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
const load = (path: string): Promise<any> => import(join(root, path))
const { enableConfigs } = await load('src/utils/config.ts'); enableConfigs()
const { compatChatCallModel } = await load('src/services/providers/openaicompat/compatChatCallModel.ts')
const { asSystemPrompt } = await load('src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await load('src/Tool.ts')
let failures = 0
const check = (label: string, yes: boolean): void => { if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}`) }
const captured: Array<{ path: string; body: any }> = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const body = await req.json() as any
  captured.push({ path, body })
  if (path.startsWith('/reject') && body.prompt_cache_key !== undefined) return Response.json({ error: { message: 'Unknown field prompt_cache_key', param: 'prompt_cache_key' } }, { status: 400 })
  if (path === '/unrelated') return Response.json({ error: { message: 'Invalid tool name' } }, { status: 400 })
  return new Response(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'complete' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 10 } } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
} })
async function run(lane: string, path: string, model = 'fixture-model'): Promise<any[]> {
  const results: any[] = []
  const profile = { lane, providerLabel: 'fixture', resolveCredential: () => ({}), credentialHint: 'fixture', requestUrl: () => `http://127.0.0.1:${server.port}${path}`, wireModelId: () => model, buildExtras: () => ({ max_tokens: 1024, temperature: 0.2 }) }
  for await (const event of compatChatCallModel(profile, { messages: [{ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Say complete.' } }], systemPrompt: asSystemPrompt(['fixture instructions']), tools: [], thinkingConfig: { type: 'disabled' }, signal: new AbortController().signal, options: { model: lane === 'openrouter' ? 'openrouter/fixture/model' : lane === 'openai-compat' ? 'compat/fixture-model' : 'deepseek-chat', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], mcpTools: [], hasAppendSystemPrompt: false } })) results.push(event)
  return results
}
try {
  for (const lane of ['openai-compat', 'openrouter']) {
    await run(lane, '/accept-'+lane)
    await run(lane, '/accept-'+lane)
    const bodies = captured.filter(r=>r.path === '/accept-'+lane).map(r=>r.body)
    check(lane+' sends the minted stable key even without tool deferral', bodies.length === 2 && typeof bodies[0].prompt_cache_key === 'string' && bodies[0].prompt_cache_key === bodies[1].prompt_cache_key)
    const out = await run(lane, '/reject-'+lane)
    await run(lane, '/reject-'+lane)
    const rejected = captured.filter(r=>r.path === '/reject-'+lane).map(r=>r.body)
    check(lane+' retries only the field refusal and remembers it', rejected.length === 3 && typeof rejected[0].prompt_cache_key === 'string' && rejected.slice(1).every(b=>b.prompt_cache_key === undefined))
    check(lane+' loses no turn or usage at the refusal', out.some(e=>e.type === 'assistant' && !e.isApiErrorMessage && e.message.usage.output_tokens === 3))
    if(rejected.length >= 2) { const {prompt_cache_key, ...first}=rejected[0]; check(lane+' retry otherwise preserves exact request bytes', JSON.stringify(first) === JSON.stringify(rejected[1])) }
  }
  console.log('\nrefusals')
  await run('deepseek', '/control')
  check('other native chat roads receive no added field', captured.filter(r=>r.path==='/control').every(r=>r.body.prompt_cache_key===undefined))
  await run('openai-compat', '/unrelated')
  check('an unrelated 400 is not retried as a cache refusal', captured.filter(r=>r.path==='/unrelated').length===1)
  await run('openai-compat', '/new-endpoint')
  check('one endpoint refusal never disables another endpoint', typeof captured.at(-1)?.body.prompt_cache_key==='string')
  const { switchSession } = await load('src/bootstrap/state.ts')
  switchSession(randomUUID())
  const beforeSession = captured.length
  await run('openai-compat', '/reject-openai-compat')
  const fresh = captured.slice(beforeSession)
  check('a later session asks the gateway again', fresh.length === 2 && typeof fresh[0].body.prompt_cache_key === 'string' && fresh[1].body.prompt_cache_key === undefined)
} finally { server.stop(true); rmSync(home,{recursive:true,force:true}) }
console.log(`${failures?'FAIL':'PASS'} prompt-cache-delivery: ${failures} failed`)
process.exit(failures?1:0)
